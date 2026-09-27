import os
import json
import subprocess
import urllib.parse
from pathlib import Path
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from utils import find_download_file, DOWNLOAD_DIR

router = APIRouter(prefix="/api/editor", tags=["editor"])


class CutRequest(BaseModel):
    file: str
    start_time: float  # 초 단위
    end_time: float    # 초 단위
    output_name: str | None = None


class ConvertRequest(BaseModel):
    file: str


@router.get("/files")
async def list_editable_files():
    """편집 가능한 영상/음원 파일 목록"""
    files = []
    if DOWNLOAD_DIR.exists():
        for f in DOWNLOAD_DIR.iterdir():
            if f.is_file() and not f.name.startswith("."):
                ext = f.suffix.lower()
                if ext in [".mp4", ".mkv", ".webm", ".mov", ".avi", ".mp3", ".m4a", ".wav"]:
                    files.append({
                        "name": f.name,
                        "size": f.stat().st_size,
                        "modified": f.stat().st_mtime,
                        "ext": ext.replace(".", ""),
                    })
    files.sort(key=lambda x: x["modified"], reverse=True)
    return {"files": files}


@router.get("/info")
async def get_media_info(file: str):
    """ffprobe를 사용해 상세 미디어 정보 추출"""
    file_path = find_download_file(file)
    if not file_path:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration,size,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate,duration",
        "-of", "json",
        str(file_path),
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)

        video_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
        audio_stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
        format_info = data.get("format", {})

        fps = None
        if video_stream and "r_frame_rate" in video_stream:
            try:
                num, den = video_stream["r_frame_rate"].split("/")
                fps = round(float(num) / float(den), 2)
            except Exception:
                pass

        duration = float(format_info.get("duration", 0) or (video_stream.get("duration") if video_stream else 0) or 0)
        vcodec = video_stream.get("codec_name") if video_stream else None
        acodec = audio_stream.get("codec_name") if audio_stream else None

        # 브라우저 직접 재생 호환성 여부 (h264/aac 또는 webm/vp9)
        # Safari 등은 mp4 컨테이너 내 vp9/opus를 재생하지 못함
        is_browser_friendly = (vcodec in ["h264", "avc1"]) and (acodec in ["aac", "mp3", "mp4a", None])

        encoded_name = urllib.parse.quote(file_path.name)

        return {
            "name": file_path.name,
            "duration": duration,
            "size": int(format_info.get("size", file_path.stat().st_size)),
            "video": {
                "width": video_stream.get("width") if video_stream else None,
                "height": video_stream.get("height") if video_stream else None,
                "codec": vcodec,
                "fps": fps,
            } if video_stream else None,
            "audio": {
                "codec": acodec,
            } if audio_stream else None,
            "is_browser_friendly": is_browser_friendly,
            "url": f"/api/editor/stream?file={encoded_name}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"미디어 정보 분석 실패: {str(e)}")


@router.get("/stream")
async def stream_video(file: str, request: Request):
    """
    HTTP Range 헤더(206 Partial Content) 완벽 지원 비디오 스트리밍
    브라우저에서 앞뒤 탐색(Seek) 및 대용량 비디오 버퍼링을 원활하게 제공합니다.
    """
    file_path = find_download_file(file)
    if not file_path:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    file_size = file_path.stat().st_size
    range_header = request.headers.get("Range")

    content_type = "video/mp4"
    if file_path.suffix.lower() == ".webm":
        content_type = "video/webm"
    elif file_path.suffix.lower() in [".mp3", ".m4a"]:
        content_type = "audio/mpeg"

    if range_header:
        # Range: bytes=start-end 파싱
        range_val = range_header.strip().replace("bytes=", "")
        parts = range_val.split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1

        if start >= file_size:
            raise HTTPException(status_code=416, detail="Requested range not satisfiable")

        chunk_size = (end - start) + 1

        def iterfile():
            with open(file_path, "rb") as f:
                f.seek(start)
                bytes_left = chunk_size
                while bytes_left > 0:
                    read_bytes = min(bytes_left, 1024 * 1024)  # 1MB 청크
                    data = f.read(read_bytes)
                    if not data:
                        break
                    bytes_left -= len(data)
                    yield data

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": content_type,
        }
        return StreamingResponse(iterfile(), status_code=206, headers=headers)

    # Range 헤더가 없는 경우 전체 스트리밍
    def iterfile_full():
        with open(file_path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                yield chunk

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
        "Content-Type": content_type,
    }
    return StreamingResponse(iterfile_full(), headers=headers)


@router.post("/convert-h264")
async def convert_to_h264(req: ConvertRequest):
    """
    브라우저 비호환 코덱(VP9/Opus 등)을 Mac 하드웨어 가속(VideoToolbox)으로
    초고속 H.264 + AAC 표준 포맷으로 변환합니다.
    """
    input_path = find_download_file(req.file)
    if not input_path:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")

    out_name = f"{input_path.stem} [H264].mp4"
    output_path = DOWNLOAD_DIR / out_name

    # Mac VideoToolbox 하드웨어 가속 인코딩
    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-c:v", "h264_videotoolbox", "-b:v", "5000k",
        "-c:a", "aac", "-b:a", "192k",
        str(output_path),
    ]

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return {
            "status": "success",
            "message": "H.264 변환 완료",
            "output_file": out_name,
        }
    except Exception as e:
        # 소프트웨어 fallback
        fb_cmd = [
            "ffmpeg", "-y",
            "-i", str(input_path),
            "-c:v", "libx264", "-preset", "fast",
            "-c:a", "aac",
            str(output_path),
        ]
        try:
            subprocess.run(fb_cmd, capture_output=True, text=True, check=True)
            return {
                "status": "success",
                "message": "H.264 변환 완료 (CPU)",
                "output_file": out_name,
            }
        except Exception as err:
            raise HTTPException(status_code=500, detail=f"H.264 변환 실패: {str(err)}")


@router.post("/cut")
async def cut_video(req: CutRequest):
    """지정한 구간(start_time ~ end_time)을 잘라내어 새 파일로 저장"""
    input_path = find_download_file(req.file)
    if not input_path:
        raise HTTPException(status_code=404, detail="원본 파일이 존재하지 않습니다.")

    if req.end_time <= req.start_time:
        raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 커야 합니다.")

    duration = req.end_time - req.start_time
    base_stem = input_path.stem
    ext = input_path.suffix

    if req.output_name and req.output_name.strip():
        out_name = req.output_name.strip()
        if not out_name.endswith(ext):
            out_name += ext
    else:
        start_str = int(req.start_time)
        end_str = int(req.end_time)
        out_name = f"{base_stem}_cut_{start_str}s-{end_str}s{ext}"

    output_path = DOWNLOAD_DIR / out_name

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(req.start_time),
        "-i", str(input_path),
        "-t", str(duration),
        "-c", "copy",
        str(output_path),
    ]

    try:
        subprocess.run(cmd, capture_output=True, text=True, check=True)
        return {
            "status": "success",
            "message": "구간 자르기 완료",
            "output_file": out_name,
            "output_size": output_path.stat().st_size,
        }
    except subprocess.CalledProcessError:
        re_cmd = [
            "ffmpeg", "-y",
            "-ss", str(req.start_time),
            "-i", str(input_path),
            "-t", str(duration),
            "-c:v", "libx264",
            "-c:a", "aac",
            str(output_path),
        ]
        try:
            subprocess.run(re_cmd, capture_output=True, text=True, check=True)
            return {
                "status": "success",
                "message": "구간 자르기 완료 (인코딩)",
                "output_file": out_name,
                "output_size": output_path.stat().st_size,
            }
        except Exception as err:
            raise HTTPException(status_code=500, detail=f"영상 자르기 실패: {str(err)}")


# ── 💾 동영상 편집 프로젝트 전체 상태 저장 및 복원 ──
import datetime

class ProjectSaveRequest(BaseModel):
    file: str
    currentTime: float | None = 0.0
    activeTab: str | None = "subtitle"
    subtitles: list[dict] | None = None
    captionPos: str | None = "bottom"
    showScreenOverlay: bool | None = True
    maxDisplaySec: float | None = 4.0
    showSubtitles: bool | None = True
    selectedVoice: str | None = "ko-KR-SunHiNeural"
    ttsRate: str | None = "+10%"
    origVolume: float | None = 0.1
    selectedBgm: str | None = ""
    bgmVolume: float | None = 0.15
    startTime: float | None = 0.0
    endTime: float | None = 0.0
    customOutName: str | None = ""
    shortsStyle: str | None = "blur"
    burnSubtitles: bool | None = True
    headerTitle: str | None = ""
    shortsStart: float | None = 0.0
    shortsEnd: float | None = 0.0


@router.post("/project/save")
async def save_editor_project(req: ProjectSaveRequest):
    """현재 동영상 편집의 전체 상태(자막, 성우, BGM, 볼륨, 재생 위치, 설정)를 프로젝트 파일로 저장"""
    file_path = find_download_file(req.file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")

    project_path = DOWNLOAD_DIR / f"{file_path.stem}.project.json"
    now_iso = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    project_data = {
        "file": file_path.name,
        "saved_at": now_iso,
        "currentTime": req.currentTime or 0.0,
        "activeTab": req.activeTab or "subtitle",
        "captionPos": req.captionPos or "bottom",
        "showScreenOverlay": req.showScreenOverlay if req.showScreenOverlay is not None else True,
        "maxDisplaySec": req.maxDisplaySec if req.maxDisplaySec is not None else 4.0,
        "showSubtitles": req.showSubtitles if req.showSubtitles is not None else True,
        "selectedVoice": req.selectedVoice or "ko-KR-SunHiNeural",
        "ttsRate": req.ttsRate or "+10%",
        "origVolume": req.origVolume if req.origVolume is not None else 0.1,
        "selectedBgm": req.selectedBgm or "",
        "bgmVolume": req.bgmVolume if req.bgmVolume is not None else 0.15,
        "startTime": req.startTime or 0.0,
        "endTime": req.endTime or 0.0,
        "customOutName": req.customOutName or "",
        "shortsStyle": req.shortsStyle or "blur",
        "burnSubtitles": req.burnSubtitles if req.burnSubtitles is not None else True,
        "headerTitle": req.headerTitle or "",
        "shortsStart": req.shortsStart or 0.0,
        "shortsEnd": req.shortsEnd or 0.0,
        "subtitles_count": len(req.subtitles) if req.subtitles else 0,
    }

    # 프로젝트 파일 저장
    with open(project_path, "w", encoding="utf-8") as f:
        json.dump(project_data, f, ensure_ascii=False, indent=2)

    # 자막 데이터도 동기화 저장
    if req.subtitles:
        json_path = DOWNLOAD_DIR / f"{file_path.stem}.subtitles.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump({
                "file": file_path.name,
                "segments": req.subtitles,
            }, f, ensure_ascii=False, indent=2)

    return {
        "status": "success",
        "message": "동영상 편집 전체 작업 상황이 성공적으로 저장되었습니다.",
        "saved_at": now_iso,
    }


@router.get("/project/load")
async def load_editor_project(file: str):
    """저장된 동영상 편집 프로젝트 상태 불러오기"""
    file_path = find_download_file(file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")

    project_path = DOWNLOAD_DIR / f"{file_path.stem}.project.json"
    if not project_path.exists():
        return {"has_project": False}

    try:
        with open(project_path, "r", encoding="utf-8") as f:
            project_data = json.load(f)
        return {
            "has_project": True,
            "project": project_data,
        }
    except Exception as e:
        return {"has_project": False, "error": str(e)}


# ── 📱 원클릭 쇼츠(Shorts) 9:16 변환 & 자막 각인(Burn-in) ──
import tempfile
from PIL import Image, ImageDraw, ImageFont


class ShortsConvertRequest(BaseModel):
    file: str
    style: str = "blur"  # 'blur' (블러 배경), 'crop' (중앙 확대), 'fit' (상하 여백)
    burn_subtitles: bool = True  # 자막 영상 각인 여부
    header_title: str | None = ""  # 상단 타이틀 텍스트
    start_time: float | None = 0.0
    end_time: float | None = None


def get_korean_font(size: int = 46):
    """macOS 시스템 한글 폰트 로드"""
    font_paths = [
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    ]
    for p in font_paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except:
                continue
    return ImageFont.load_default()


def format_sub_2lines(text: str, max_chars: int = 20) -> str:
    """긴 자막 2줄 어절 밸런싱"""
    if not text:
        return ""
    if "\n" in text:
        return text
    trimmed = text.strip()
    if len(trimmed) <= max_chars:
        return trimmed
    words = trimmed.split(" ")
    if len(words) <= 1:
        return trimmed

    target_len = len(trimmed) // 2
    best_idx = 1
    min_diff = 999999
    cur_len = 0
    for i in range(len(words) - 1):
        cur_len += len(words[i]) + (1 if i > 0 else 0)
        diff = abs(cur_len - target_len)
        if diff < min_diff:
            min_diff = diff
            best_idx = i + 1

    line1 = " ".join(words[:best_idx])
    line2 = " ".join(words[best_idx:])
    return f"{line1}\n{line2}"


@router.post("/shorts")
async def convert_to_shorts(req: ShortsConvertRequest):
    """
    일반 가로 영상을 1080x1920 세로 9:16 쇼츠 영상으로 원클릭 변환
    - style: blur(블러 배경), crop(중앙 확대), fit(상하 여백)
    - burn_subtitles: 자막 화면 영구 각인
    - header_title: 상단 후킹 타이틀 바
    """
    file_path = find_download_file(req.file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")

    # 출력 파일명 생성
    out_stem = f"{file_path.stem}_shorts_9x16_{req.style}"
    out_name = f"{out_stem}.mp4"
    output_path = DOWNLOAD_DIR / out_name

    # 자막 데이터 불러오기 (자막 각인 요청 시)
    segments = []
    if req.burn_subtitles:
        sub_file = DOWNLOAD_DIR / f"{file_path.stem}.subtitles.json"
        if sub_file.exists():
            try:
                with open(sub_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    segments = data.get("segments", [])
            except:
                pass

    # 임시 디렉토리에서 오버레이 이미지들 생성
    temp_dir = tempfile.mkdtemp(prefix="shorts_overlay_")
    overlay_inputs = []
    overlay_filters = []
    filter_complex_parts = []

    # 1. 기본 9:16 화면 캔버스 필터
    if req.style == "crop":
        filter_complex_parts.append(
            "[0:v]scale=-2:1920:force_original_aspect_ratio=increase,crop=1080:1920[base_v]"
        )
    elif req.style == "fit":
        filter_complex_parts.append(
            "[0:v]scale=1080:-2:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black[base_v]"
        )
    else:  # 기본 blur
        filter_complex_parts.append(
            "[0:v]split=2[bg_in][fg_in];"
            "[bg_in]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=26:5[bg];"
            "[fg_in]scale=1080:-2:force_original_aspect_ratio=decrease[fg];"
            "[bg][fg]overlay=(W-w)/2:(H-h)/2[base_v]"
        )

    last_v = "[base_v]"
    input_idx = 1

    # 2. 상단 헤더 타이틀 오버레이 생성 (옵션)
    if req.header_title and req.header_title.strip():
        header_text = req.header_title.strip()
        header_img = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
        draw_h = ImageDraw.Draw(header_img)
        font_h = get_korean_font(size=52)

        bbox_h = draw_h.multiline_textbbox((0, 0), header_text, font=font_h, align="center")
        tw_h = bbox_h[2] - bbox_h[0]
        th_h = bbox_h[3] - bbox_h[1]
        cx_h, cy_h = 540, 240
        pad_x, pad_y = 36, 18
        box_h = [cx_h - tw_h//2 - pad_x, cy_h - th_h//2 - pad_y, cx_h + tw_h//2 + pad_x, cy_h + th_h//2 + pad_y]

        # 톡톡 튀는 노란색 하이라이트 박스 + 검은색 텍스트
        draw_h.rounded_rectangle(box_h, radius=24, fill=(255, 221, 0, 240), outline=(255, 255, 255, 200), width=3)
        draw_h.multiline_text((cx_h, cy_h), header_text, font=font_h, fill=(10, 10, 15, 255), anchor="mm", align="center")

        h_path = os.path.join(temp_dir, "header_title.png")
        header_img.save(h_path)
        overlay_inputs.extend(["-i", h_path])

        next_v = f"[v_h]"
        filter_complex_parts.append(f"{last_v}[{input_idx}:v]overlay=0:0{next_v}")
        last_v = next_v
        input_idx += 1

    # 3. 자막 각인 오버레이 생성 (각 자막 세그먼트별)
    font_sub = get_korean_font(size=46)
    offset_time = req.start_time or 0.0

    valid_segments = []
    if req.burn_subtitles and segments:
        for idx, seg in enumerate(segments):
            s_start = seg.get("start", 0.0)
            s_end = seg.get("end", 0.0)
            text = seg.get("text", "").strip()

            if not text:
                continue

            # 구간 자르기 범위에 걸치는지 확인
            if req.end_time and req.end_time > 0 and s_start >= req.end_time:
                continue
            if s_end <= offset_time:
                continue

            # 타임 오프셋 보정
            adj_start = max(0.0, round(s_start - offset_time, 2))
            adj_end = round(s_end - offset_time, 2)
            if req.end_time and req.end_time > 0:
                adj_end = min(round(req.end_time - offset_time, 2), adj_end)

            if adj_end <= adj_start:
                continue

            # 2줄 줄바꿈 적용
            display_text = format_sub_2lines(text, max_chars=20)

            # 자막 이미지 그리기
            sub_img = Image.new("RGBA", (1080, 1920), (0, 0, 0, 0))
            draw_s = ImageDraw.Draw(sub_img)
            bbox_s = draw_s.multiline_textbbox((0, 0), display_text, font=font_sub, align="center")
            tw_s = bbox_s[2] - bbox_s[0]
            th_s = bbox_s[3] - bbox_s[1]

            cx_s, cy_s = 540, 1500  # 쇼츠 화면 하단 안전지대
            pad_s_x, pad_s_y = 28, 16
            box_s = [cx_s - tw_s//2 - pad_s_x, cy_s - th_s//2 - pad_s_y, cx_s + tw_s//2 + pad_s_x, cy_s + th_s//2 + pad_s_y]

            # 반투명 둥근 글래스모피즘 박스
            draw_s.rounded_rectangle(box_s, radius=20, fill=(12, 12, 18, 220), outline=(255, 255, 255, 75), width=2)
            # 텍스트 그림자
            draw_s.multiline_text((cx_s + 1, cy_s + 2), display_text, font=font_sub, fill=(0, 0, 0, 180), anchor="mm", align="center")
            # 본문 텍스트 (흰색)
            draw_s.multiline_text((cx_s, cy_s), display_text, font=font_sub, fill=(255, 255, 255, 255), anchor="mm", align="center")

            sub_path = os.path.join(temp_dir, f"sub_{idx}.png")
            sub_img.save(sub_path)
            overlay_inputs.extend(["-i", sub_path])

            next_v = f"[v_sub_{idx}]"
            filter_complex_parts.append(
                f"{last_v}[{input_idx}:v]overlay=0:0:enable='between(t,{adj_start},{adj_end})'{next_v}"
            )
            last_v = next_v
            input_idx += 1

    # 최종 필터그래프 완성
    filter_complex_str = ";".join(filter_complex_parts)

    # ffmpeg 명령어 조립
    cmd = ["ffmpeg", "-y"]

    if req.start_time and req.start_time > 0:
        cmd.extend(["-ss", str(req.start_time)])
    if req.end_time and req.end_time > 0 and req.end_time > (req.start_time or 0.0):
        duration = req.end_time - (req.start_time or 0.0)
        cmd.extend(["-t", str(duration)])

    cmd.extend(["-i", str(file_path)])
    cmd.extend(overlay_inputs)
    cmd.extend([
        "-filter_complex", filter_complex_str,
        "-map", last_v,
        "-map", "0:a?",
        "-c:v", "h264_videotoolbox",
        "-b:v", "6500k",
        "-c:a", "aac",
        "-b:a", "192k",
        str(output_path),
    ])

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    except subprocess.CalledProcessError as e:
        # 하드웨어 가속 실패 시 libx264 소프트웨어 fallback
        cmd_fallback = [
            "ffmpeg", "-y",
        ]
        if req.start_time and req.start_time > 0:
            cmd_fallback.extend(["-ss", str(req.start_time)])
        if req.end_time and req.end_time > 0 and req.end_time > (req.start_time or 0.0):
            cmd_fallback.extend(["-t", str(req.end_time - (req.start_time or 0.0))])

        cmd_fallback.extend(["-i", str(file_path)])
        cmd_fallback.extend(overlay_inputs)
        cmd_fallback.extend([
            "-filter_complex", filter_complex_str,
            "-map", last_v,
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "22",
            "-c:a", "aac",
            str(output_path),
        ])
        try:
            subprocess.run(cmd_fallback, capture_output=True, text=True, check=True)
        except Exception as err:
            raise HTTPException(status_code=500, detail=f"쇼츠 변환 실패: {str(err)}")
    finally:
        # 임시 디렉토리 및 파일 정리
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)

    return {
        "status": "success",
        "message": "9:16 쇼츠 변환 완료!",
        "output_file": out_name,
        "output_size": output_path.stat().st_size,
        "url": f"/api/media/{urllib.parse.quote(out_name)}",
        "style": req.style,
        "burned_subtitles": req.burn_subtitles,
    }



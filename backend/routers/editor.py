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

import os
import json
import asyncio
import tempfile
import subprocess
import shutil
import urllib.parse
from pathlib import Path
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import edge_tts
from utils import find_download_file, DOWNLOAD_DIR

router = APIRouter(prefix="/api/tts", tags=["tts"])

# BGM 에셋 저장 폴더
BASE_DIR = Path(__file__).resolve().parent.parent.parent
BGM_DIR = BASE_DIR / "backend" / "assets" / "bgm"
BGM_DIR.mkdir(parents=True, exist_ok=True)

# 지원하는 고품질 한국어 AI 성우 목록
VOICES = [
    {
        "id": "ko-KR-SunHiNeural",
        "name": "선희 (여성)",
        "desc": "밝고 또렷한 톤, 유튜브 쇼츠 및 정보/리뷰 내레이션에 가장 인기",
        "gender": "Female",
    },
    {
        "id": "ko-KR-InJoonNeural",
        "name": "인준 (남성)",
        "desc": "차분하고 신뢰감 있는 톤, 다큐멘터리/뉴스/지식 채널에 추천",
        "gender": "Male",
    },
    {
        "id": "ko-KR-HyunsuNeural",
        "name": "현수 (남성)",
        "desc": "자연스럽고 캐주얼한 톤, 브이로그 및 일상/유머 영상에 추천",
        "gender": "Male",
    },
]


class PreviewRequest(BaseModel):
    text: str
    voice: str = "ko-KR-SunHiNeural"
    rate: str = "+0%"


class DubbingRequest(BaseModel):
    file: str
    voice: str = "ko-KR-SunHiNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    original_volume: float = 0.1   # 원본 영상 소리 (0.0: 음소거, 0.1: 10%)
    bgm_file: str | None = None    # 선택한 BGM 파일명 (None이면 BGM 없음)
    bgm_volume: float = 0.15       # BGM 볼륨 (0.15 = 15%)
    tts_volume: float = 1.0        # AI 목소리 볼륨 (1.0 = 100%)
    output_name: str | None = None


@router.get("/voices")
async def get_voices():
    """사용 가능한 한국어 AI 성우 목록"""
    return {"voices": VOICES}


@router.get("/bgm/list")
async def list_bgm_tracks():
    """사용 가능한 BGM 목록 (기본 프리셋 + 다운로드된 MP3 음원)"""
    tracks = []

    # 1. 기본 프리셋 BGM
    if BGM_DIR.exists():
        for f in BGM_DIR.iterdir():
            if f.is_file() and f.suffix.lower() in [".mp3", ".m4a", ".wav", ".ogg"]:
                tracks.append({
                    "id": f"preset:{f.name}",
                    "name": f.stem,
                    "filename": f.name,
                    "type": "preset",
                    "size": f.stat().st_size,
                    "url": f"/api/tts/bgm/stream?file={urllib.parse.quote(f.name)}&type=preset",
                })

    # 2. downloads 폴더의 음원 파일들 (유튜브 다운로더 등)
    if DOWNLOAD_DIR.exists():
        for f in DOWNLOAD_DIR.iterdir():
            if f.is_file() and f.suffix.lower() in [".mp3", ".m4a", ".wav"]:
                tracks.append({
                    "id": f"downloaded:{f.name}",
                    "name": f.stem,
                    "filename": f.name,
                    "type": "downloaded",
                    "size": f.stat().st_size,
                    "url": f"/api/tts/bgm/stream?file={urllib.parse.quote(f.name)}&type=downloaded",
                })

    return {"tracks": tracks}


@router.post("/bgm/upload")
async def upload_bgm(file: UploadFile = File(...)):
    """사용자 직접 BGM 파일 업로드"""
    ext = Path(file.filename).suffix.lower()
    if ext not in [".mp3", ".m4a", ".wav", ".aac"]:
        raise HTTPException(status_code=400, detail="MP3, M4A, WAV 오디오 파일만 업로드할 수 있습니다.")

    dest = BGM_DIR / file.filename
    with open(dest, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "status": "success",
        "filename": file.filename,
        "name": Path(file.filename).stem,
    }


@router.get("/bgm/stream")
async def stream_bgm(file: str, type: str = "preset"):
    """BGM 오디오 미리듣기 스트리밍"""
    if type == "preset":
        target = BGM_DIR / file
    else:
        target = find_download_file(file)

    if not target or not target.exists():
        raise HTTPException(status_code=404, detail="BGM 파일을 찾을 수 없습니다.")

    return FileResponse(
        str(target),
        media_type="audio/mpeg",
        filename=target.name,
    )


@router.post("/preview")
async def preview_tts(req: PreviewRequest):
    """지정한 텍스트로 미리듣기 음성(MP3) 생성"""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="텍스트를 입력해주세요.")

    temp_mp3 = Path(tempfile.gettempdir()) / "bill_studio_tts_preview.mp3"

    try:
        communicate = edge_tts.Communicate(
            req.text.strip(),
            req.voice,
            rate=req.rate,
        )
        await communicate.save(str(temp_mp3))
        return FileResponse(
            str(temp_mp3),
            media_type="audio/mpeg",
            filename="preview.mp3",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"미리듣기 생성 실패: {str(e)}")


@router.post("/dub")
async def dub_video(req: DubbingRequest):
    """
    영상 자막 대본을 기반으로 AI 성우 음성을 생성하고,
    선택한 BGM 배경음악 및 원본 영상 오디오와 믹싱하여 더빙된 새 영상을 제작합니다.
    """
    video_path = find_download_file(req.file)
    if not video_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")

    # 영상 길이 측정
    probe_cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    try:
        p_res = subprocess.run(probe_cmd, capture_output=True, text=True, check=True)
        video_duration = float(p_res.stdout.strip() or 0)
    except Exception:
        video_duration = 60.0

    # 자막 파일 확인 (.subtitles.json)
    json_path = DOWNLOAD_DIR / f"{video_path.stem}.subtitles.json"
    if not json_path.exists():
        json_path = DOWNLOAD_DIR / f"{video_path.name}.subtitles.json"

    if not json_path.exists():
        raise HTTPException(
            status_code=400,
            detail="자막 대본이 없습니다. 먼저 [🎙️ AI 자막] 탭에서 자막을 추출해주세요."
        )

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            sub_data = json.load(f)
        segments = sub_data.get("segments", [])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"자막 파일 읽기 실패: {str(e)}")

    if not segments:
        raise HTTPException(status_code=400, detail="대본에 자막 문장이 없습니다.")

    # 선택된 BGM 파일 확인
    bgm_path = None
    if req.bgm_file and req.bgm_file.strip():
        # preset 디렉토리 또는 downloads 디렉토리 검색
        cand1 = BGM_DIR / req.bgm_file
        cand2 = find_download_file(req.bgm_file)
        if cand1.exists():
            bgm_path = cand1
        elif cand2 and cand2.exists():
            bgm_path = cand2

    # 임시 디렉토리에 각 세그먼트 음성 생성
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        seg_audio_files = []

        for idx, seg in enumerate(segments):
            text = seg.get("text", "").strip()
            if not text:
                continue

            seg_file = tmp_path / f"seg_{idx:04d}.mp3"
            try:
                comm = edge_tts.Communicate(text, req.voice, rate=req.rate, pitch=req.pitch)
                await comm.save(str(seg_file))
                seg_audio_files.append({
                    "path": seg_file,
                    "start": seg.get("start", 0.0),
                })
            except Exception as e:
                print(f"Segment {idx} TTS error: {e}")

        if not seg_audio_files:
            raise HTTPException(status_code=500, detail="유효한 AI 음성을 생성하지 못했습니다.")

        # 출력 파일명 결정
        if req.output_name and req.output_name.strip():
            out_filename = req.output_name.strip()
            if not out_filename.endswith(".mp4"):
                out_filename += ".mp4"
        else:
            tag = "[AI더빙+BGM]" if bgm_path else "[AI더빙]"
            out_filename = f"{video_path.stem} {tag}.mp4"

        output_video_path = DOWNLOAD_DIR / out_filename

        # ffmpeg 명령어 빌드
        # input 0: 비디오
        # input 1: BGM (선택된 경우)
        # input N: TTS 세그먼트들
        ffmpeg_cmd = ["ffmpeg", "-y", "-i", str(video_path)]

        input_offset = 1
        has_bgm = bgm_path is not None

        if has_bgm:
            ffmpeg_cmd.extend(["-i", str(bgm_path)])
            input_offset = 2

        for item in seg_audio_files:
            ffmpeg_cmd.extend(["-i", str(item["path"])])

        filter_parts = []
        tts_inputs = []

        # 각 TTS 오디오에 adelay 필터 적용 (밀리초 단위)
        for i, item in enumerate(seg_audio_files, start=input_offset):
            delay_ms = max(0, int(item["start"] * 1000))
            filter_parts.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[d{i}]")
            tts_inputs.append(f"[d{i}]")

        # 모든 TTS 세그먼트를 하나의 오디오 스트림으로 믹싱
        filter_parts.append(
            f"{''.join(tts_inputs)}amix=inputs={len(tts_inputs)}:normalize=0[tts_all]"
        )

        orig_vol = max(0.0, min(1.0, req.original_volume))
        tts_vol = max(0.1, min(2.0, req.tts_volume))
        bgm_vol = max(0.0, min(1.0, req.bgm_volume))

        # 오디오 트랙 믹싱 그래프
        mix_inputs = []

        # 1) 원본 오디오 볼륨 조절
        filter_parts.append(f"[0:a]volume={orig_vol}[orig_audio]")
        mix_inputs.append("[orig_audio]")

        # 2) BGM 볼륨 조절 및 루프 + 페이드아웃 (선택된 경우)
        if has_bgm:
            fade_start = max(0.0, video_duration - 2.5)
            # aloop으로 비디오 길이만큼 반복 후 페이드아웃
            filter_parts.append(
                f"[1:a]aloop=loop=-1:size=2e+09,volume={bgm_vol},afade=t=out:st={fade_start}:d=2.5[bgm_audio]"
            )
            mix_inputs.append("[bgm_audio]")

        # 3) TTS 목소리 볼륨
        filter_parts.append(f"[tts_all]volume={tts_vol}[tts_louder]")
        mix_inputs.append("[tts_louder]")

        # 4) 최종 믹싱 (amix)
        filter_parts.append(
            f"{''.join(mix_inputs)}amix=inputs={len(mix_inputs)}:duration=first:dropout_transition=0[final_a]"
        )

        filter_str = ";".join(filter_parts)

        ffmpeg_cmd.extend([
            "-filter_complex", filter_str,
            "-map", "0:v",
            "-map", "[final_a]",
            "-c:v", "copy",       # 비디오 무손실 초고속 복사
            "-c:a", "aac",        # 오디오 AAC 인코딩
            "-b:a", "192k",
            str(output_video_path),
        ])

        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: subprocess.run(ffmpeg_cmd, capture_output=True, text=True, check=True)
            )
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=500, detail=f"더빙 영상 렌더링 실패: {str(e)}")

        # 생성된 더빙 영상에도 자막 파일 복사 (자막 싱크 유지)
        sub_copy_path = DOWNLOAD_DIR / f"{output_video_path.stem}.subtitles.json"
        srt_copy_path = DOWNLOAD_DIR / f"{output_video_path.stem}.srt"
        try:
            with open(json_path, "r", encoding="utf-8") as f_in, open(sub_copy_path, "w", encoding="utf-8") as f_out:
                f_out.write(f_in.read())
            orig_srt = DOWNLOAD_DIR / f"{video_path.stem}.srt"
            if orig_srt.exists():
                with open(orig_srt, "r", encoding="utf-8") as f_in, open(srt_copy_path, "w", encoding="utf-8") as f_out:
                    f_out.write(f_in.read())
        except Exception:
            pass

        return {
            "status": "success",
            "message": "BGM과 AI 내레이션이 결합된 더빙 영상이 성공적으로 제작되었습니다!",
            "output_file": out_filename,
            "output_size": output_video_path.stat().st_size,
        }

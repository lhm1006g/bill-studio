import os
import json
import subprocess
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/editor", tags=["editor"])

# 프로젝트 루트 기준 downloads 폴더
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DOWNLOAD_DIR = BASE_DIR / "downloads"


class CutRequest(BaseModel):
    file: str
    start_time: float  # 초 단위
    end_time: float    # 초 단위
    output_name: str | None = None


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
    file_path = DOWNLOAD_DIR / file
    if not file_path.exists() or not file_path.is_file():
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

        # FPS 계산
        fps = None
        if video_stream and "r_frame_rate" in video_stream:
            try:
                num, den = video_stream["r_frame_rate"].split("/")
                fps = round(float(num) / float(den), 2)
            except Exception:
                pass

        duration = float(format_info.get("duration", 0) or (video_stream.get("duration") if video_stream else 0) or 0)

        return {
            "name": file,
            "duration": duration,
            "size": int(format_info.get("size", file_path.stat().st_size)),
            "video": {
                "width": video_stream.get("width") if video_stream else None,
                "height": video_stream.get("height") if video_stream else None,
                "codec": video_stream.get("codec_name") if video_stream else None,
                "fps": fps,
            } if video_stream else None,
            "audio": {
                "codec": audio_stream.get("codec_name") if audio_stream else None,
            } if audio_stream else None,
            "url": f"/api/media/{file}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"미디어 정보 분석 실패: {str(e)}")


@router.post("/cut")
async def cut_video(req: CutRequest):
    """지정한 구간(start_time ~ end_time)을 잘라내어 새 파일로 저장"""
    input_path = DOWNLOAD_DIR / req.file
    if not input_path.exists():
        raise HTTPException(status_code=404, detail="원본 파일이 존재하지 않습니다.")

    if req.end_time <= req.start_time:
        raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 커야 합니다.")

    duration = req.end_time - req.start_time

    # 출력 파일명 생성
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

    # ffmpeg 실행 (무손실 스트림 카피 우선 시도)
    cmd = [
        "ffmpeg",
        "-y",
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
    except subprocess.CalledProcessError as e:
        # 무손실 카피 실패 시 재인코딩 fallback
        re_cmd = [
            "ffmpeg",
            "-y",
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

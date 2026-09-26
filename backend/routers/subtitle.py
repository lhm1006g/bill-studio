import os
import json
import asyncio
from pathlib import Path
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from faster_whisper import WhisperModel
from utils import find_download_file, DOWNLOAD_DIR

router = APIRouter(prefix="/api/subtitle", tags=["subtitle"])


# 캐시된 Whisper 모델 인스턴스 (지연 로딩)
_loaded_models = {}


def get_whisper_model(model_size: str = "base"):
    if model_size not in _loaded_models:
        # Mac CPU 환경 최적화 (int8)
        _loaded_models[model_size] = WhisperModel(model_size, device="cpu", compute_type="int8")
    return _loaded_models[model_size]


def format_srt_time(seconds: float) -> str:
    """초 단위를 SRT 타임코드 형식 (00:00:00,000)으로 변환"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds % 1) * 1000))
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def generate_srt(segments: list) -> str:
    """세그먼트 리스트를 SRT 문자열로 변환"""
    srt_lines = []
    for idx, seg in enumerate(segments, start=1):
        start = format_srt_time(seg["start"])
        end = format_srt_time(seg["end"])
        text = seg["text"].strip()
        srt_lines.append(f"{idx}\n{start} --> {end}\n{text}\n")
    return "\n".join(srt_lines)


class SubtitleSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str


class ExtractRequest(BaseModel):
    file: str
    model_size: str = "base"  # tiny, base, small
    language: str | None = "ko"


class SaveRequest(BaseModel):
    file: str
    segments: list[SubtitleSegment]


@router.get("/get")
async def get_subtitles(file: str):
    """이미 추출되어 저장된 자막이 있는지 확인하고 반환"""
    file_path = find_download_file(file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일이 없습니다.")

    json_path = DOWNLOAD_DIR / f"{file_path.stem}.subtitles.json"
    if json_path.exists():
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return {"exists": True, "segments": data.get("segments", []), "file": file_path.name}
        except Exception:
            pass

    return {"exists": False, "segments": [], "file": file_path.name}


@router.post("/extract")
async def extract_subtitles(req: ExtractRequest):
    """faster-whisper를 사용해 영상에서 한국어 음성을 인식하여 자막 추출"""
    file_path = find_download_file(req.file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")


    try:
        model = get_whisper_model(req.model_size)

        # 블로킹 작업이므로 스레드 풀에서 실행
        loop = asyncio.get_event_loop()

        def run_transcription():
            # vad_filter: 무음 구간 자동 스킵하여 속도 및 정확도 향상
            segments_gen, info = model.transcribe(
                str(file_path),
                language=req.language if req.language != "auto" else None,
                vad_filter=True,
                beam_size=5,
            )
            parsed_segments = []
            for idx, s in enumerate(segments_gen, start=1):
                parsed_segments.append({
                    "id": idx,
                    "start": round(s.start, 2),
                    "end": round(s.end, 2),
                    "text": s.text.strip(),
                })
            return parsed_segments, info

        segments, info = await loop.run_in_executor(None, run_transcription)

        # 추출 결과를 JSON 및 SRT 파일로 자동 저장
        json_path = DOWNLOAD_DIR / f"{file_path.stem}.subtitles.json"
        srt_path = DOWNLOAD_DIR / f"{file_path.stem}.srt"

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump({
                "file": req.file,
                "language": info.language,
                "segments": segments,
            }, f, ensure_ascii=False, indent=2)

        srt_content = generate_srt(segments)
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(srt_content)

        return {
            "status": "success",
            "file": req.file,
            "language": info.language,
            "segments": segments,
            "count": len(segments),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"자막 추출 실패: {str(e)}")


@router.post("/save")
async def save_subtitles(req: SaveRequest):
    """사용자가 웹 UI에서 수정한 자막 저장"""
    file_path = find_download_file(req.file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일이 없습니다.")

    json_path = DOWNLOAD_DIR / f"{file_path.stem}.subtitles.json"
    srt_path = DOWNLOAD_DIR / f"{file_path.stem}.srt"

    segments_data = [s.model_dump() for s in req.segments]

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "file": file_path.name,
            "segments": segments_data,
        }, f, ensure_ascii=False, indent=2)

    srt_content = generate_srt(segments_data)
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    return {"status": "success", "message": "자막이 성공적으로 저장되었습니다."}


@router.get("/export/srt")
async def export_srt(file: str):
    """SRT 자막 파일 다운로드"""
    file_path = find_download_file(file)
    if not file_path:
        raise HTTPException(status_code=404, detail="영상 파일이 없습니다.")

    srt_path = DOWNLOAD_DIR / f"{file_path.stem}.srt"
    if not srt_path.exists():
        raise HTTPException(status_code=404, detail="SRT 자막 파일이 없습니다. 먼저 자막을 추출해주세요.")

    return FileResponse(
        str(srt_path),
        media_type="application/x-subrip",
        filename=f"{file_path.stem}.srt",
    )


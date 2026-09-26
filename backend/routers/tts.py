import os
import json
import asyncio
import tempfile
import subprocess
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
import edge_tts
from utils import find_download_file, DOWNLOAD_DIR

router = APIRouter(prefix="/api/tts", tags=["tts"])

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
    rate: str = "+0%"  # e.g. "+10%", "-10%"


class DubbingRequest(BaseModel):
    file: str
    voice: str = "ko-KR-SunHiNeural"
    rate: str = "+0%"
    pitch: str = "+0Hz"
    original_volume: float = 0.15  # 원본 영상 소리 (0.0: 음소거, 0.15: 은은한 배경음)
    tts_volume: float = 1.0        # AI 목소리 볼륨
    output_name: str | None = None


@router.get("/voices")
async def get_voices():
    """사용 가능한 한국어 AI 성우 목록"""
    return {"voices": VOICES}


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
    원본 영상 오디오(BGM)와 믹싱하여 더빙된 새 영상을 제작합니다.
    """
    video_path = find_download_file(req.file)
    if not video_path:
        raise HTTPException(status_code=404, detail="영상 파일을 찾을 수 없습니다.")

    # 자막 파일 확인 (.subtitles.json)
    json_path = DOWNLOAD_DIR / f"{video_path.stem}.subtitles.json"
    if not json_path.exists():
        # 혹시 원본 stem 기준이 아닌 경우
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
            out_filename = f"{video_path.stem} [AI더빙].mp4"

        output_video_path = DOWNLOAD_DIR / out_filename

        # ffmpeg로 각 세그먼트를 해당 시작 시간에 딜레이 배치 후 원본 오디오와 믹싱
        # inputs: 0번은 video_path, 1번부터는 각 seg_audio_files
        ffmpeg_cmd = ["ffmpeg", "-y", "-i", str(video_path)]
        for item in seg_audio_files:
            ffmpeg_cmd.extend(["-i", str(item["path"])])

        # 필터 그래프 구성
        filter_parts = []
        tts_inputs = []

        # 각 TTS 오디오에 adelay 필터 적용 (밀리초 단위)
        for i, item in enumerate(seg_audio_files, start=1):
            delay_ms = max(0, int(item["start"] * 1000))
            filter_parts.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[d{i}]")
            tts_inputs.append(f"[d{i}]")

        # 모든 TTS 세그먼트를 하나의 오디오 스트림으로 믹싱
        filter_parts.append(
            f"{''.join(tts_inputs)}amix=inputs={len(tts_inputs)}:normalize=0[tts_all]"
        )

        # 원본 볼륨 조절 & TTS 볼륨 조절 후 최종 합성
        orig_vol = max(0.0, min(1.0, req.original_volume))
        tts_vol = max(0.1, min(2.0, req.tts_volume))

        filter_parts.append(f"[0:a]volume={orig_vol}[orig_bgm]")
        filter_parts.append(f"[tts_all]volume={tts_vol}[tts_louder]")
        filter_parts.append(
            f"[orig_bgm][tts_louder]amix=inputs=2:duration=first:dropout_transition=0[final_a]"
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
            res = await loop.run_in_executor(
                None,
                lambda: subprocess.run(ffmpeg_cmd, capture_output=True, text=True, check=True)
            )
        except subprocess.CalledProcessError as e:
            # 원본 영상에 오디오 트랙이 없거나 filter_complex 실패 시 단순 TTS만 결합
            fallback_cmd = [
                "ffmpeg", "-y", "-i", str(video_path),
                "-filter_complex", ";".join(filter_parts[:-2] + [f"[tts_all]volume={tts_vol}[final_a]"]),
                "-map", "0:v",
                "-map", "[final_a]",
                "-c:v", "copy",
                "-c:a", "aac",
                str(output_video_path),
            ]
            try:
                await loop.run_in_executor(
                    None,
                    lambda: subprocess.run(fallback_cmd, capture_output=True, text=True, check=True)
                )
            except Exception as err:
                raise HTTPException(status_code=500, detail=f"더빙 영상 렌더링 실패: {str(err)}")

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
            "message": "AI 내레이션 더빙 영상이 성공적으로 제작되었습니다!",
            "output_file": out_filename,
            "output_size": output_video_path.stat().st_size,
        }

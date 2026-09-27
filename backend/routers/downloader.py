import asyncio
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import yt_dlp

router = APIRouter(prefix="/api/download", tags=["downloader"])

# 다운로드 저장 폴더 (프로젝트 하위 /downloads)
BASE_DIR = Path(__file__).resolve().parent.parent.parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


# 정보 조회용 - format 지정 없이 순수 포맷 목록만 추출
INFO_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
}

# 다운로드용 공통 설정 (deno JS 런타임으로 n-sig 자동 해결)
DOWNLOAD_OPTS = {
    "quiet": True,
    "no_warnings": True,
}



class VideoInfoRequest(BaseModel):
    url: str


@router.post("/info")
async def get_video_info(req: VideoInfoRequest):
    """영상 정보 및 화질 목록 가져오기"""
    try:
        with yt_dlp.YoutubeDL(INFO_OPTS) as ydl:
            info = ydl.extract_info(req.url, download=False)

            # 지원하는 해상도 목록 (height 기반)
            RESOLUTIONS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144]
            available_heights = set()

            for f in info.get("formats", []):
                height = f.get("height")
                vcodec = f.get("vcodec", "none")
                if vcodec != "none" and height:
                    available_heights.add(height)

            formats = []
            for res in RESOLUTIONS:
                # 해당 해상도 이하 중 최적 포맷이 존재하면 추가
                matching = [h for h in available_heights if h <= res]
                if not matching:
                    continue
                best = max(matching)
                if best < res * 0.6:  # 너무 낮은 건 해당 레이블로 안 씀
                    continue

                # 대략적인 파일 크기 계산
                best_fmt = None
                for f in info.get("formats", []):
                    if f.get("height") == best and f.get("vcodec", "none") != "none":
                        if best_fmt is None or (f.get("filesize") or 0) > (best_fmt.get("filesize") or 0):
                            best_fmt = f

                label = f"{res}p" if res == best else f"{best}p"
                if label in [x["label"] for x in formats]:
                    continue

                formats.append({
                    "format_id": str(res),   # height 값을 format_id로 사용
                    "label": label,
                    "ext": "mp4",
                    "filesize": (best_fmt.get("filesize") or best_fmt.get("filesize_approx")) if best_fmt else None,
                })

            # 오디오만
            formats.append({
                "format_id": "audio",
                "label": "🎵 오디오만 (MP3)",
                "ext": "mp3",
                "filesize": None,
            })

            return {
                "title": info.get("title", "알 수 없음"),
                "thumbnail": info.get("thumbnail"),
                "duration": info.get("duration"),
                "uploader": info.get("uploader"),
                "view_count": info.get("view_count"),
                "formats": formats,
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


CHANNEL_LABELS = {
    "humanity": "💧 인류애 & 감동 실화",
    "sports": "⚡ 스포츠 명장면",
    "animals": "🐾 동물 힐링",
    "tech": "🧠 미래 테크 & AI",
}


@router.get("/start")
async def download_video(url: str, format_id: str, channel: str | None = None):
    """영상 다운로드 - SSE(Server-Sent Events)로 실시간 진행률 전송 (채널별 폴더 자동 분류)"""

    async def event_stream():
        progress_data = {"percent": "0%", "speed": "", "eta": ""}

        def progress_hook(d):
            if d["status"] == "downloading":
                pct = d.get("_percent_str", "0%").strip()
                speed = d.get("_speed_str", "").strip()
                eta = d.get("_eta_str", "").strip()
                progress_data["percent"] = pct
                progress_data["speed"] = speed
                progress_data["eta"] = eta
            elif d["status"] == "finished":
                progress_data["percent"] = "100%"

        # 채널 지정 시 채널 전용 폴더에 저장, 없으면 기본 downloads 루트에 저장
        if channel and channel in CHANNEL_LABELS:
            target_dir = DOWNLOAD_DIR / channel
        else:
            target_dir = DOWNLOAD_DIR
        target_dir.mkdir(parents=True, exist_ok=True)

        is_audio = format_id == "audio"

        if is_audio:
            ydl_opts = {
                **DOWNLOAD_OPTS,
                "format": "bestaudio/best",
                "outtmpl": str(target_dir / "%(title)s.%(ext)s"),
                "overwrites": True,
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }],
                "progress_hooks": [progress_hook],
            }
        else:
            # 브라우저 완벽 호환: H.264(avc1) 비디오 + AAC(m4a) 오디오 최우선 결합
            height = int(format_id)
            ydl_opts = {
                **DOWNLOAD_OPTS,
                "format": (
                    f"bestvideo[height={height}][vcodec^=avc]+bestaudio[ext=m4a]"
                    f"/bestvideo[height<={height}][vcodec^=avc]+bestaudio[ext=m4a]"
                    f"/bestvideo[height={height}][ext=mp4]+bestaudio[ext=m4a]"
                    f"/bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]"
                    f"/bestvideo[height={height}]+bestaudio"
                    f"/bestvideo[height<={height}]+bestaudio"
                    f"/best[height<={height}]"
                    f"/best"
                ),
                "outtmpl": str(target_dir / "%(title)s [%(height)sp].%(ext)s"),
                "merge_output_format": "mp4",
                "overwrites": True,
                "progress_hooks": [progress_hook],
            }

        loop = asyncio.get_event_loop()

        def run_download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

        yield f"data: {json.dumps({'status': 'start'})}\n\n"

        task = loop.run_in_executor(None, run_download)

        while not task.done():
            yield f"data: {json.dumps({'status': 'progress', **progress_data})}\n\n"
            await asyncio.sleep(0.5)

        try:
            await task
            yield f"data: {json.dumps({'status': 'done', 'save_dir': str(target_dir), 'channel': channel})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/history")
async def get_history(channel: str | None = None):
    """다운로드된 파일 목록 (루트 및 채널별 서브폴더 스캔)"""
    files = []
    if DOWNLOAD_DIR.exists():
        # 루트 및 서브폴더 재귀 스캔 (미디어 파일만)
        VALID_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".mp3", ".m4a", ".wav"}
        for f in DOWNLOAD_DIR.rglob("*"):
            if not f.is_file() or f.name.startswith("."):
                continue
            if f.suffix.lower() not in VALID_EXTS:
                continue

            # 채널 감지
            rel_path = str(f.relative_to(DOWNLOAD_DIR))
            file_channel = None
            parts = f.relative_to(DOWNLOAD_DIR).parts
            if len(parts) > 1 and parts[0] in CHANNEL_LABELS:
                file_channel = parts[0]

            # 채널 필터 적용
            if channel and channel != "all":
                if file_channel != channel:
                    continue

            files.append({
                "name": f.name,
                "rel_path": rel_path,
                "channel": file_channel,
                "channel_label": CHANNEL_LABELS.get(file_channel),
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })

    files.sort(key=lambda x: x["modified"], reverse=True)
    return {"files": files, "save_dir": str(DOWNLOAD_DIR)}


@router.post("/open-folder")
async def open_download_folder(channel: str | None = None):
    """Mac Finder에서 저장 폴더 열기 (채널 지정 가능)"""
    import subprocess
    try:
        target = DOWNLOAD_DIR
        if channel and (DOWNLOAD_DIR / channel).exists():
            target = DOWNLOAD_DIR / channel
        subprocess.run(["open", str(target)], check=True)
        return {"status": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


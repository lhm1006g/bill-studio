import asyncio
import json
from pathlib import Path
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import yt_dlp

router = APIRouter(prefix="/api/download", tags=["downloader"])

# 다운로드 저장 폴더
DOWNLOAD_DIR = Path.home() / "Downloads" / "BillStudio"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 403 에러 우회 공통 옵션
COMMON_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "extractor_args": {
        "youtube": {
            "player_client": ["ios", "android", "web"],
        }
    },
    "http_headers": {
        "User-Agent": "com.google.ios.youtube/19.29.1 CFNetwork/1568.100.1 Darwin/24.0.0",
    },
}


class VideoInfoRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    format_id: str
    filename: str | None = None


@router.post("/info")
async def get_video_info(req: VideoInfoRequest):
    """영상 정보 및 화질 목록 가져오기"""
    ydl_opts = {
        **COMMON_OPTS,
        "skip_download": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(req.url, download=False)
            formats = []
            seen = set()
            for f in info.get("formats", []):
                height = f.get("height")
                ext = f.get("ext", "")
                vcodec = f.get("vcodec", "none")
                acodec = f.get("acodec", "none")
                # 영상+음성 포함 포맷만 (또는 영상만)
                if vcodec == "none":
                    continue
                label = f"{height}p" if height else "기타"
                if label in seen:
                    continue
                seen.add(label)
                formats.append({
                    "format_id": f["format_id"],
                    "label": label,
                    "ext": ext,
                    "filesize": f.get("filesize") or f.get("filesize_approx"),
                    "vcodec": vcodec,
                    "acodec": acodec,
                })
            # 음원만 (mp3)
            formats.append({
                "format_id": "bestaudio/best",
                "label": "🎵 오디오만 (MP3)",
                "ext": "mp3",
                "filesize": None,
                "vcodec": "none",
                "acodec": "mp3",
            })
            # 해상도 높은 순 정렬
            def sort_key(f):
                label = f["label"]
                if label.endswith("p"):
                    try:
                        return int(label[:-1])
                    except:
                        return 0
                return -1
            video_formats = [f for f in formats if f["label"] != "🎵 오디오만 (MP3)"]
            video_formats.sort(key=sort_key, reverse=True)
            formats = video_formats + [f for f in formats if f["label"] == "🎵 오디오만 (MP3)"]

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


@router.get("/start")
async def download_video(url: str, format_id: str):
    """영상 다운로드 - SSE(Server-Sent Events)로 실시간 진행률 전송"""

    async def event_stream():
        progress_data = {"percent": 0, "speed": "", "eta": ""}

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

        is_audio = format_id == "bestaudio/best"

        if is_audio:
            ydl_opts = {
                **COMMON_OPTS,
                "format": "bestaudio/best",
                "outtmpl": str(DOWNLOAD_DIR / "%(title)s.%(ext)s"),
                "postprocessors": [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }],
                "progress_hooks": [progress_hook],
            }
        else:
            ydl_opts = {
                **COMMON_OPTS,
                "format": f"{format_id}+bestaudio[ext=m4a]/best[height<={format_id}]/best",
                "outtmpl": str(DOWNLOAD_DIR / "%(title)s.%(ext)s"),
                "merge_output_format": "mp4",
                "progress_hooks": [progress_hook],
            }

        loop = asyncio.get_event_loop()

        def run_download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])

        # 시작 이벤트
        yield f"data: {json.dumps({'status': 'start'})}\n\n"

        task = loop.run_in_executor(None, run_download)

        while not task.done():
            yield f"data: {json.dumps({'status': 'progress', **progress_data})}\n\n"
            await asyncio.sleep(0.5)

        try:
            await task
            yield f"data: {json.dumps({'status': 'done', 'save_dir': str(DOWNLOAD_DIR)})}\n\n"
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
async def get_history():
    """다운로드된 파일 목록"""
    files = []
    for f in DOWNLOAD_DIR.iterdir():
        if f.is_file():
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })
    files.sort(key=lambda x: x["modified"], reverse=True)
    return {"files": files, "save_dir": str(DOWNLOAD_DIR)}

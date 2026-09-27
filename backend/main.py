from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from routers import downloader, editor, subtitle, tts, schedule, news, ai_chat, research, channels

app = FastAPI(title="Bill Studio API", version="1.0.0")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 미디어 파일 정적 서빙 (/api/media/파일명)
DOWNLOAD_DIR = Path(__file__).resolve().parent.parent / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/media", StaticFiles(directory=DOWNLOAD_DIR), name="media")

# 라우터 등록
app.include_router(downloader.router)
app.include_router(editor.router)
app.include_router(subtitle.router)
app.include_router(tts.router)
app.include_router(schedule.router)
app.include_router(news.router)
app.include_router(ai_chat.router)
app.include_router(research.router)
app.include_router(channels.router)





@app.get("/")
def root():
    return {"message": "🎬 Bill Studio API 정상 작동 중"}


@app.get("/health")
def health():
    return {"status": "ok"}

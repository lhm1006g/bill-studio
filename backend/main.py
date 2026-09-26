from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import downloader

app = FastAPI(title="Bill Studio API", version="1.0.0")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 라우터 등록
app.include_router(downloader.router)


@app.get("/")
def root():
    return {"message": "🎬 Bill Studio API 정상 작동 중"}


@app.get("/health")
def health():
    return {"status": "ok"}

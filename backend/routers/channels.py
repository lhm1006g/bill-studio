"""
Phase: Studio Channels Profile System (채널 프로필 관리 시스템)
- 4대 황금 채널 카테고리 (인류애/스포츠/동물/테크) 기본 프리셋
- 채널별 전용 폴더, 추천 검색어, AI 성우, BGM, 자막/쇼츠 연출 스타일 정의
"""
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/channels", tags=["channels"])

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DOWNLOAD_DIR = BASE_DIR / "downloads"

# 기본 4대 황금 채널 프리셋
STUDIO_CHANNELS = [
    {
        "id": "humanity",
        "name": "인류애 & 감동 실화",
        "icon": "💧",
        "color": "#38bdf8",
        "folder": "humanity",
        "description": "선행, 인류애 회복, 눈물주의 감동 실화, 기적의 순간",
        "query": "감동적인 동영상",
        "en_query": "wholesome moments restored faith in humanity",
        "voice": "ko-KR-SunHiNeural",
        "voice_name": "선희 (따뜻하고 차분한 여성)",
        "voice_speed": 1.0,
        "bgm_id": "ambient_piano",
        "bgm_name": "감성 피아노 앰비언트",
        "bgm_volume": 0.15,
        "sub_position": "middle",
        "shorts_style": "blur",
    },
    {
        "id": "sports",
        "name": "스포츠 명장면 & 리스펙트",
        "icon": "⚡",
        "color": "#f59e0b",
        "folder": "sports",
        "description": "축구/야구/격투기 페어플레이, 역전 드라마, 감동 리스펙트",
        "query": "스포츠 명장면 쇼츠",
        "en_query": "respect moments sports sportsmanship",
        "voice": "ko-KR-HyunsuNeural",
        "voice_name": "현수 (박진감 넘치는 남성)",
        "voice_speed": 1.05,
        "bgm_id": "cinematic_beat",
        "bgm_name": "박진감 시네마틱 비트",
        "bgm_volume": 0.12,
        "sub_position": "bottom",
        "shorts_style": "crop",
    },
    {
        "id": "animals",
        "name": "동물 구조 & 기적의 힐링",
        "icon": "🐾",
        "color": "#10b981",
        "folder": "animals",
        "description": "유기견/야생동물 구조, 동물과 인간의 교감, 포근한 힐링",
        "query": "귀여운 동물 감동 쇼츠",
        "en_query": "touching animal rescue heartwarming",
        "voice": "ko-KR-SunHiNeural",
        "voice_name": "선희 (다정하고 감성적인 여성)",
        "voice_speed": 1.0,
        "bgm_id": "ambient_acoustic",
        "bgm_name": "어쿠스틱 포근 앰비언트",
        "bgm_volume": 0.15,
        "sub_position": "middle",
        "shorts_style": "blur",
    },
    {
        "id": "tech",
        "name": "미래 테크 & 글로벌 머니",
        "icon": "🧠",
        "color": "#a855f7",
        "folder": "tech",
        "description": "AI, 반도체 혁신, 빅테크 신기술 데모, 미래 산업 분석",
        "query": "반도체 AI 엔비디아 뉴스",
        "en_query": "breakthrough technology AI robotics innovation",
        "voice": "ko-KR-InJoonNeural",
        "voice_name": "인준 (신뢰감 넘치는 뉴스/다큐 남성)",
        "voice_speed": 1.0,
        "bgm_id": "deep_tech",
        "bgm_name": "딥 테크 일렉트로닉",
        "bgm_volume": 0.10,
        "sub_position": "bottom",
        "shorts_style": "letterbox",
    },
]


@router.get("")
async def get_channels():
    """등록된 채널 목록 및 프리셋 설정 반환"""
    # 각 채널의 폴더가 존재하는지 확인하고 생성
    for ch in STUDIO_CHANNELS:
        ch_folder = DOWNLOAD_DIR / ch["folder"]
        ch_folder.mkdir(parents=True, exist_ok=True)
    return {"channels": STUDIO_CHANNELS}


@router.get("/{channel_id}")
async def get_channel(channel_id: str):
    """특정 채널 정보 조회"""
    for ch in STUDIO_CHANNELS:
        if ch["id"] == channel_id:
            return ch
    raise HTTPException(status_code=404, detail="채널을 찾을 수 없습니다.")

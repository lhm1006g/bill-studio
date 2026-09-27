"""
Phase: YouTube Content Research & Benchmarking (콘텐츠 발굴 및 유튜브 리서치)
- yt-dlp 기반 초고속 유튜브 실시간 검색 (조회수, 썸네일, 채널, 재생시간)
- Gemini 3.8 Flash (agy CLI) 기반 원클릭 벤치마킹 분석 및 쇼츠 기획안 도출
- 나만의 영감 보관함(Idea Board) CRUD (SQLite)
"""
import asyncio
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List

import yt_dlp
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/research", tags=["research"])

# DB 경로 및 agy 경로
DB_PATH = Path(__file__).resolve().parent.parent / "studio.db"
AGY_BIN = "/Users/bill/.local/bin/agy"

# 기본 추천 검색어 프리셋
DEFAULT_PRESETS = [
    {"label": "💧 감동적인 동영상", "query": "감동적인 동영상"},
    {"label": "📜 해외 감동 실화", "query": "해외 감동 실화 스토리"},
    {"label": "⚽ 스포츠 명장면 쇼츠", "query": "스포츠 명장면 쇼츠"},
    {"label": "🧠 AI 반도체 해설", "query": "반도체 AI 엔비디아 뉴스"},
    {"label": "🔥 100만뷰 바이럴 쇼츠", "query": "100만뷰 쇼츠 스토리텔링"},
    {"label": "🐱 귀여운 동물 힐링", "query": "귀여운 동물 감동 쇼츠"},
]


# ─── DB 초기화 ────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 영감 보관함 (스크랩한 영상 및 기획 아이디어)
    c.execute("""
        CREATE TABLE IF NOT EXISTS research_ideas (
            id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL,
            title TEXT NOT NULL,
            channel TEXT,
            views INTEGER DEFAULT 0,
            duration TEXT,
            thumbnail TEXT,
            url TEXT NOT NULL,
            category TEXT DEFAULT '일반',
            notes TEXT,
            ai_analysis TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    conn.commit()
    conn.close()


init_db()


# ─── 조회수 및 시간 포맷 유틸 ────────────────────────────────────────────────
def format_views(view_count):
    if not view_count:
        return "조회수 없음"
    try:
        vc = int(view_count)
        if vc >= 100000000:
            return f"{vc / 100000000:.1f}억회"
        if vc >= 10000:
            return f"{vc / 10000:.1f}만회"
        if vc >= 1000:
            return f"{vc / 1000:.1f}천회"
        return f"{vc}회"
    except Exception:
        return str(view_count)


def format_duration(seconds):
    if not seconds:
        return ""
    try:
        sec = int(seconds)
        m, s = divmod(sec, 60)
        h, m = divmod(m, 60)
        if h > 0:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except Exception:
        return ""


import re
from deep_translator import GoogleTranslator

# 한글 포함 여부 확인 함수
def contains_korean(text: str) -> bool:
    return bool(re.search(r'[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]', text or ''))

# 핫 키워드 영문 자동 변환 매핑
KO_TO_EN_TOPICS = {
    "감동적인 동영상": "wholesome moments restored faith in humanity",
    "감동적인동영상": "wholesome moments restored faith in humanity",
    "감동 실화": "heartwarming emotional true stories that make you cry",
    "해외 감동 실화": "heartwarming emotional true stories that make you cry",
    "해외 감동 실화 스토리": "heartwarming emotional true stories that make you cry",
    "스포츠 명장면": "respect moments in sports wholesome sportsmanship",
    "스포츠 명장면 쇼츠": "respect moments in sports wholesome sportsmanship",
    "동물 힐링": "hero saves animal heartwarming rescue",
    "귀여운 동물 감동 쇼츠": "hero saves animal heartwarming rescue",
    "100만뷰 바이럴 쇼츠": "viral shorts heartwarming stories that make you cry",
    "인류애": "faith in humanity restored wholesome",
    "길거리 인터뷰": "street interview emotional life advice",
}


# ─── 유튜브 실시간 검색 API ───────────────────────────────────────────────
@router.get("/search")
def search_youtube(
    q: str,
    sort: Optional[str] = "relevance",  # relevance | views | date
    foreign_only: bool = False,         # 🌐 해외 순수 원본만 찾기 (한글 자막/제목 100% 배제)
    limit: int = 24,
):
    """
    yt-dlp 기반 유튜브 실시간 검색
    foreign_only=True 시:
    - 영문 키워드로 자동 변환하여 글로벌 유튜브 검색
    - 제목에 한글이 단 1글자라도 들어간 2차 가공 영상은 100% 필터링하여 순수 해외 원본만 추출
    """
    if not q or not q.strip():
        raise HTTPException(status_code=400, detail="검색어를 입력해주세요.")

    original_query = q.strip()
    search_query = original_query

    # 🌐 해외 원본 모드일 때 키워드 영문 변환
    if foreign_only:
        if search_query in KO_TO_EN_TOPICS:
            search_query = KO_TO_EN_TOPICS[search_query]
        elif contains_korean(search_query):
            try:
                translated = GoogleTranslator(source='auto', target='en').translate(search_query)
                if translated:
                    search_query = f"{translated} viral wholesome"
            except Exception:
                search_query = f"{search_query} english viral"

    # 검색 건수 (해외 필터링 고려하여 넉넉히 가져옴)
    fetch_count = limit * 3 if foreign_only else limit * 2
    search_spec = f"ytsearch{fetch_count}:{search_query}"

    ydl_opts = {
        "extract_flat": True,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            res = ydl.extract_info(search_spec, download=False)
            entries = res.get("entries", []) or []

        results = []
        for e in entries:
            if not e or not e.get("id"):
                continue

            vid = e.get("id")
            title = e.get("title") or "Untitled"
            channel = e.get("channel") or e.get("uploader") or "Unknown"

            # 🚫 해외 원본 모드일 때 한글이 포함된 제목/채널은 무조건 제외 (2차 가공물 배제)
            if foreign_only:
                if contains_korean(title) or contains_korean(channel):
                    continue

            view_count = e.get("view_count") or 0
            duration_sec = e.get("duration")
            url = f"https://www.youtube.com/watch?v={vid}"

            # 썸네일 고화질 추출
            thumbnail = e.get("thumbnail")
            if not thumbnail and e.get("thumbnails"):
                thumbnail = e.get("thumbnails")[-1].get("url")
            if not thumbnail:
                thumbnail = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"

            results.append({
                "id": vid,
                "title": title,
                "channel": channel,
                "view_count": view_count,
                "views_formatted": format_views(view_count),
                "duration_sec": duration_sec,
                "duration_formatted": format_duration(duration_sec),
                "thumbnail": thumbnail,
                "url": url,
                "is_foreign": foreign_only or not contains_korean(title),
            })

        # 정렬 처리
        if sort == "views":
            results.sort(key=lambda x: x["view_count"] or 0, reverse=True)

        return {
            "query": original_query,
            "actual_query": search_query,
            "foreign_only": foreign_only,
            "total": len(results[:limit]),
            "results": results[:limit],
            "presets": DEFAULT_PRESETS,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"유튜브 검색 실패: {str(e)}")


# ─── AI 벤치마킹 분석 API (Gemini 3.8 Flash 스트리밍) ────────────────────
class AnalyzeRequest(BaseModel):
    video_id: str
    title: str
    channel: Optional[str] = "알 수 없음"
    views: Optional[str] = ""
    url: str


@router.post("/analyze")
async def analyze_video(body: AnalyzeRequest):
    """
    Gemini 3.8 Flash (agy CLI)를 사용하여
    이 영상이 왜 떡상했는지 분석하고, 내 채널에 적용할 킬러 쇼츠 기획안을 스트리밍
    """
    prompt = f"""당신은 100만 구독자 유튜브 채널을 육성하는 대한민국 최고의 '유튜브 콘텐츠 기획 컨설턴트'입니다.

다음 벤치마킹 대상 유튜브 영상을 분석하여, 내가 내 채널에 새로 만들 쇼츠/영상 기획안을 작성해주세요.

[분석 대상 영상]
- 제목: {body.title}
- 채널명: {body.channel}
- 조회수: {body.views}
- 영상 링크: {body.url}

다음 형식으로 가독성 좋고 구체적으로 작성해주세요:

## 🎯 1. 이 영상의 흥행 비결 (시청자가 클릭하고 끝까지 본 이유)
- **후킹 포인트**: 초반에 시선을 사로잡은 요소
- **감정 트리거**: 시청자의 어떤 감정(감동, 호기심, 분노, 카타르시스 등)을 자극했는가?
- **구성 특징**: 지루하지 않게 이끈 스토리텔링 방식

## 💡 2. 내 채널 적용 쇼츠 기획안 (3가지 콘셉트)
1. **[콘셉트 A - 감성/스토리 중심]**: 제목 및 한 줄 기획
2. **[콘셉트 B - 충격/반전 중심]**: 제목 및 한 줄 기획
3. **[콘셉트 C - 정보/핵심 요약 중심]**: 제목 및 한 줄 기획

## 🪝 3. 초반 3초 킬러 후킹 멘트 (시청자 이탈 방지용)
1. 
2. 
3. 

## 🎬 4. 60초 쇼츠 타임코드 대본 구조
- **00~05초 (도입)**: 
- **05~25초 (전개 & 갈등)**: 
- **25~45초 (클라이맥스/반전)**: 
- **45~60초 (여운 & 구독 유도 CTA)**: 
"""

    async def generate():
        cmd = [
            AGY_BIN,
            "-p", prompt,
            "--model", "gemini-3.8-flash-medium",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
        ]

        full_text = ""
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            while True:
                line_bytes = await proc.stdout.readline()
                if not line_bytes:
                    break
                line_str = line_bytes.decode("utf-8", errors="replace").strip()
                if not line_str:
                    continue

                try:
                    data = json.loads(line_str)
                    event = data.get("event")
                    if event == "step_update":
                        step_data = data.get("step_update", {})
                        delta = step_data.get("text_delta", "")
                        if delta:
                            full_text += delta
                            yield f"data: {json.dumps({'type': 'token', 'text': delta})}\n\n"
                    elif event == "result":
                        res_data = data.get("result", {})
                        if not full_text and res_data.get("response"):
                            resp = res_data.get("response")
                            full_text = resp
                            yield f"data: {json.dumps({'type': 'token', 'text': resp})}\n\n"
                except json.JSONDecodeError:
                    continue

            await proc.wait()
            yield f"data: {json.dumps({'type': 'done', 'full_text': full_text})}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ─── 영감 보관함 (Idea Board) CRUD API ────────────────────────────────────
class IdeaCreate(BaseModel):
    video_id: str
    title: str
    channel: Optional[str] = ""
    views: Optional[int] = 0
    duration: Optional[str] = ""
    thumbnail: Optional[str] = ""
    url: str
    category: Optional[str] = "일반"
    notes: Optional[str] = ""
    ai_analysis: Optional[str] = ""


@router.get("/ideas")
def get_ideas(category: Optional[str] = None):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    query = "SELECT * FROM research_ideas WHERE 1=1"
    params = []
    if category and category != "전체":
        query += " AND category = ?"
        params.append(category)
    query += " ORDER BY created_at DESC"

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/ideas")
def save_idea(body: IdeaCreate):
    conn = sqlite3.connect(DB_PATH)
    idea_id = hashlib.md5((body.video_id + body.category).encode()).hexdigest()[:12]
    try:
        conn.execute("""
            INSERT INTO research_ideas 
            (id, video_id, title, channel, views, duration, thumbnail, url, category, notes, ai_analysis)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                notes = excluded.notes,
                ai_analysis = excluded.ai_analysis,
                category = excluded.category
        """, (
            idea_id, body.video_id, body.title, body.channel, body.views,
            body.duration, body.thumbnail, body.url, body.category, body.notes, body.ai_analysis
        ))
        conn.commit()
    finally:
        conn.close()
    return {"id": idea_id, "message": "영감 보관함에 저장되었습니다."}


@router.delete("/ideas/{idea_id}")
def delete_idea(idea_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM research_ideas WHERE id = ?", (idea_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

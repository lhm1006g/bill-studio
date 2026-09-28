"""
Phase 6 - 뉴스 리서치 백엔드
RSS 수집 + 본문 추출 + Ollama AI 요약 스트리밍
"""
import asyncio
import json
import time
import hashlib
import sqlite3
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional, List

import feedparser
import httpx
from bs4 import BeautifulSoup
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/news", tags=["news"])

# DB 경로 및 agy CLI 경로
DB_PATH = Path(__file__).resolve().parent.parent / "studio.db"
AGY_BIN = "/Users/bill/.local/bin/agy"

# ─── 기본 뉴스 소스 ────────────────────────────────────────────────────
DEFAULT_SOURCES = [
    {
        "id": "naver_economy",
        "name": "네이버 경제",
        "url": "https://news.naver.com/section/101",
        "category": "경제/증권",
        "icon": "🟢",
    },
    {
        "id": "naver_it",
        "name": "네이버 IT/과학",
        "url": "https://news.naver.com/section/105",
        "category": "IT/기술",
        "icon": "🟢",
    },
    {
        "id": "zdnet_korea",
        "name": "ZDNet Korea",
        "url": "http://feeds.feedburner.com/zdkorea",
        "category": "IT/기술",
        "icon": "💻",
    },
    {
        "id": "bloter",
        "name": "블로터 (Bloter)",
        "url": "https://www.bloter.net/rss/allArticle.xml",
        "category": "IT/기술",
        "icon": "📱",
    },
    {
        "id": "etnews",
        "name": "전자신문",
        "url": "https://rss.etnews.com/Section902.xml",
        "category": "IT/기술",
        "icon": "⚡",
    },
    {
        "id": "yozm_it",
        "name": "요즘IT",
        "url": "https://yozm.wishket.com/magazine/feed/",
        "category": "IT/기술",
        "icon": "💡",
    },
    {
        "id": "geeknews",
        "name": "GeekNews",
        "url": "https://feeds.feedburner.com/geeknews-feed",
        "category": "IT/기술",
        "icon": "🤓",
    },
    {
        "id": "aitimes",
        "name": "AI타임스",
        "url": "https://www.aitimes.com/rss/allArticle.xml",
        "category": "AI",
        "icon": "🤖",
    },
    {
        "id": "google_tech",
        "name": "구글 뉴스 IT",
        "url": "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ko&gl=KR&ceid=KR:ko",
        "category": "IT/기술",
        "icon": "🌐",
    },
    {
        "id": "hankyung_stock",
        "name": "한국경제 증권",
        "url": "https://rss.hankyung.com/feed/stock",
        "category": "경제/증권",
        "icon": "📈",
    },
    {
        "id": "mk_stock",
        "name": "매일경제 증권",
        "url": "https://www.mk.co.kr/rss/50200011/",
        "category": "경제/증권",
        "icon": "📊",
    },
    {
        "id": "google_biz",
        "name": "구글 뉴스 경제",
        "url": "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ko&gl=KR&ceid=KR:ko",
        "category": "경제/증권",
        "icon": "💵",
    },
]


# ─── 기본 관심 종목 정의 ────────────────────────────────────────────────
DEFAULT_WATCHLIST = [
    {"id": "samsung",  "name": "삼성전자",        "keywords": "삼성전자,Samsung Electronics,삼전",                    "icon": "📱", "color": "#3b82f6"},
    {"id": "skhynix",  "name": "SK하이닉스",       "keywords": "SK하이닉스,SK Hynix,하이닉스,HBM",                     "icon": "💾", "color": "#f59e0b"},
    {"id": "naver",    "name": "네이버",            "keywords": "네이버,NAVER,클로바,하이퍼클로바",                    "icon": "🟢", "color": "#10b981"},
    {"id": "nvidia",   "name": "NVIDIA",            "keywords": "NVIDIA,엔비디아,젠슨황,블랙웰,GB200",                 "icon": "🧠", "color": "#8b5cf6"},
    {"id": "tsmc",     "name": "TSMC",              "keywords": "TSMC,대만적체,파운드리",                             "icon": "🇹🇼", "color": "#ec4899"},
    {"id": "china_semi","name": "중국 반도체(SMIC/화웨이)", "keywords": "SMIC,중신국제,중국 반도체,CXMT,YMTC,화웨이 반도체", "icon": "🇨🇳", "color": "#ef4444"},
    {"id": "tesla",    "name": "테슬라",            "keywords": "테슬라,Tesla,일론머스크,FSD,사이버트럭",              "icon": "⚡", "color": "#f97316"},
    {"id": "spacex",   "name": "스페이스X",         "keywords": "스페이스X,SpaceX,스타링크,스타십,팰컨",               "icon": "🚀", "color": "#6b7280"},
    {"id": "doosan",   "name": "두산에너빌리티",    "keywords": "두산에너빌리티,두산에너,체코 원전,SMR,원자력",         "icon": "☢️", "color": "#14b8a6"},
    {"id": "hyundai",  "name": "현대차",            "keywords": "현대차,Hyundai,현대자동차,아이오닉,제네시스",         "icon": "🚗", "color": "#0ea5e9"},
]


# ─── DB 초기화 ────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # RSS 소스 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS news_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            category TEXT DEFAULT 'IT/기술',
            icon TEXT DEFAULT '📰',
            is_active INTEGER DEFAULT 1,
            last_fetched TEXT,
            article_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    # 뉴스 기사 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS news_articles (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            title TEXT NOT NULL,
            link TEXT NOT NULL,
            summary TEXT,
            content TEXT,
            ai_summary TEXT,
            keywords TEXT,
            mentioned_stocks TEXT,
            published_at TEXT,
            is_read INTEGER DEFAULT 0,
            is_bookmarked INTEGER DEFAULT 0,
            fetched_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (source_id) REFERENCES news_sources(id)
        )
    """)

    # 관심종목 워치리스트 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS news_watchlist (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            keywords TEXT NOT NULL,
            icon TEXT DEFAULT '📊',
            color TEXT DEFAULT '#8b5cf6',
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)

    # 📅 날짜별 데일리 AI 종합 브리핑 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS daily_news_briefings (
            date TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            article_count INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)

    # mentioned_stocks 컬럼 업그레이드 (기존 설치 DB 호환)
    try:
        c.execute("ALTER TABLE news_articles ADD COLUMN mentioned_stocks TEXT")
    except Exception:
        pass  # 이미 존재하면 무시

    # 기본 소스 삽입 (없으면)
    for src in DEFAULT_SOURCES:
        c.execute("""
            INSERT OR IGNORE INTO news_sources (id, name, url, category, icon)
            VALUES (?, ?, ?, ?, ?)
        """, (src["id"], src["name"], src["url"], src["category"], src["icon"]))

    # 기본 관심종목 삽입 또는 최신화
    for w in DEFAULT_WATCHLIST:
        c.execute("""
            INSERT INTO news_watchlist (id, name, keywords, icon, color)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                keywords = excluded.keywords,
                icon = excluded.icon,
                color = excluded.color
        """, (w["id"], w["name"], w["keywords"], w["icon"], w["color"]))

    conn.commit()
    conn.close()


init_db()



# ─── 유틸 ────────────────────────────────────────────────────────────
def make_article_id(link: str) -> str:
    return hashlib.md5(link.encode()).hexdigest()[:16]


def extract_content(url: str) -> str:
    """웹페이지 본문 추출 (trafilatura 우선, 실패 시 httpx로 fallback)"""
    try:
        import trafilatura
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            text = trafilatura.extract(downloaded, include_comments=False, include_tables=False)
            if text and len(text) > 100:
                return text[:3000]  # 최대 3000자
    except Exception:
        pass

    # httpx fallback - meta description만 반환
    try:
        resp = httpx.get(url, timeout=10, follow_redirects=True,
                         headers={"User-Agent": "Mozilla/5.0"})
        # 간단 파싱으로 og:description 추출
        import re
        m = re.search(r'<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]+)"', resp.text)
        if m:
            return m.group(1)
    except Exception:
        pass

    return ""


# ─── 소스 관련 API ────────────────────────────────────────────────────
@router.get("/sources")
def get_sources():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM news_sources ORDER BY category, name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


class SourceCreate(BaseModel):
    name: str
    url: str
    category: str = "IT/기술"
    icon: str = "📰"


@router.post("/sources")
def add_source(body: SourceCreate):
    src_id = hashlib.md5(body.url.encode()).hexdigest()[:12]
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("""
            INSERT INTO news_sources (id, name, url, category, icon)
            VALUES (?, ?, ?, ?, ?)
        """, (src_id, body.name, body.url, body.category, body.icon))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="이미 존재하는 소스입니다.")
    conn.close()
    return {"id": src_id, "message": "소스가 추가되었습니다."}


@router.delete("/sources/{source_id}")
def delete_source(source_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM news_sources WHERE id = ?", (source_id,))
    conn.execute("DELETE FROM news_articles WHERE source_id = ?", (source_id,))
    conn.commit()
    conn.close()
    return {"message": "소스가 삭제되었습니다."}


@router.patch("/sources/{source_id}/toggle")
def toggle_source(source_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        UPDATE news_sources SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
        WHERE id = ?
    """, (source_id,))
    conn.commit()
    row = conn.execute("SELECT is_active FROM news_sources WHERE id = ?", (source_id,)).fetchone()
    conn.close()
    return {"is_active": row[0] if row else None}


# ─── 관심종목 감지 함수 ───────────────────────────────────────────────────
def detect_mentioned_stocks(text: str, conn) -> str:
    """기사 제목/요약에서 관심 종목 키워드 감지 → '삼성전자,NVIDIA' 형태 반환"""
    watchlist = conn.execute(
        "SELECT name, keywords FROM news_watchlist WHERE is_active = 1"
    ).fetchall()

    matched = []
    text_lower = text.lower()
    for name, kw_str in watchlist:
        for kw in kw_str.split(","):
            kw = kw.strip()
            if kw and kw.lower() in text_lower:
                if name not in matched:
                    matched.append(name)
                break
    return ",".join(matched)


# ─── 네이버 뉴스 스크래퍼 함수 ──────────────────────────────────────────
def fetch_naver_news_section(url: str):
    """네이버 뉴스 섹션(101 경제, 105 IT/과학 등) 직접 웹 스크래핑"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    resp = httpx.get(url, headers=headers, timeout=12, follow_redirects=True)
    soup = BeautifulSoup(resp.text, "html.parser")
    items = soup.select(".sa_item")
    entries = []
    
    for item in items[:40]:
        title_a = item.select_one(".sa_text_title")
        press_div = item.select_one(".sa_text_press")
        lede_div = item.select_one(".sa_text_lede")

        if not title_a:
            continue

        title = title_a.get_text(strip=True)
        link = title_a.get("href", "")
        if not link:
            continue

        press = press_div.get_text(strip=True) if press_div else ""
        summary = lede_div.get_text(strip=True) if lede_div else ""
        if press:
            summary = f"[{press}] {summary}"

        entries.append({
            "title": title,
            "link": link,
            "summary": summary,
            "published": datetime.now(timezone.utc).isoformat(),
        })

    return entries


# ─── 뉴스 수집 API ─────────────────────────────────────────────────────
@router.post("/fetch")
def fetch_all_sources():
    """모든 활성 소스(RSS 피드 + 네이버 뉴스 웹)를 수집하고 DB에 저장"""
    conn = sqlite3.connect(DB_PATH)
    sources = conn.execute(
        "SELECT * FROM news_sources WHERE is_active = 1"
    ).fetchall()

    total_new = 0
    results = []

    for src in sources:
        src_id, name, url = src[0], src[1], src[2]
        new_count = 0

        try:
            articles_to_process = []

            # 🟢 네이버 뉴스 URL 감지 시 전용 스크래퍼 실행
            if "news.naver.com" in url:
                articles_to_process = fetch_naver_news_section(url)
            else:
                feed = feedparser.parse(url)
                for entry in feed.entries[:30]:  # 최근 30개만
                    link = getattr(entry, "link", "")
                    if not link:
                        continue
                    title = getattr(entry, "title", "제목 없음")
                    summary = getattr(entry, "summary", "")
                    import re
                    summary = re.sub(r"<[^>]+>", "", summary)[:500]

                    published = ""
                    if hasattr(entry, "published_parsed") and entry.published_parsed:
                        published = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                    elif hasattr(entry, "updated_parsed") and entry.updated_parsed:
                        published = datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc).isoformat()
                    else:
                        published = datetime.now(timezone.utc).isoformat()

                    articles_to_process.append({
                        "title": title,
                        "link": link,
                        "summary": summary,
                        "published": published,
                    })

            for item in articles_to_process:
                link = item["link"]
                article_id = make_article_id(link)

                # 이미 존재하면 스킵
                exists = conn.execute(
                    "SELECT 1 FROM news_articles WHERE id = ?", (article_id,)
                ).fetchone()
                if exists:
                    continue

                title = item["title"]
                summary = item["summary"]
                published = item["published"]

                # 🔔 관심종목 감지
                mentioned = detect_mentioned_stocks(title + " " + summary, conn)

                conn.execute("""
                    INSERT OR IGNORE INTO news_articles
                    (id, source_id, title, link, summary, published_at, mentioned_stocks)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (article_id, src_id, title, link, summary, published, mentioned or None))
                new_count += 1

            # last_fetched 업데이트
            conn.execute("""
                UPDATE news_sources SET last_fetched = datetime('now'), article_count = (
                    SELECT COUNT(*) FROM news_articles WHERE source_id = ?
                ) WHERE id = ?
            """, (src_id, src_id))
            conn.commit()

            total_new += new_count
            results.append({"source": name, "new_articles": new_count})

        except Exception as e:
            results.append({"source": name, "error": str(e)})

    conn.close()
    return {"total_new": total_new, "results": results}


# ─── 날짜 헬퍼 함수 ───────────────────────────────────────────────────
def get_date_label(date_str: str) -> str:
    """YYYY-MM-DD 날짜를 '오늘', '어제', '그저께', 'M월 D일' 등으로 변환"""
    now_kst = datetime.now(timezone(timedelta(hours=9))).date()
    try:
        target_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        diff = (now_kst - target_date).days
        if diff == 0:
            return "오늘"
        elif diff == 1:
            return "어제"
        elif diff == 2:
            return "그저께"
        else:
            return f"{target_date.month}월 {target_date.day}일"
    except Exception:
        return date_str


# ─── 날짜 목록 API ────────────────────────────────────────────────────
@router.get("/dates")
def get_news_dates():
    """뉴스 기사가 존재하는 최근 날짜 목록 및 건수, 브리핑 여부 반환"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute("""
        SELECT 
            COALESCE(NULLIF(substr(published_at, 1, 10), ''), substr(fetched_at, 1, 10)) as date_key,
            COUNT(*) as total_count,
            SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_count
        FROM news_articles
        WHERE COALESCE(NULLIF(substr(published_at, 1, 10), ''), substr(fetched_at, 1, 10)) IS NOT NULL
        GROUP BY date_key
        ORDER BY date_key DESC
        LIMIT 14
    """).fetchall()

    # 브리핑 존재 여부 맵
    briefing_rows = conn.execute("SELECT date FROM daily_news_briefings").fetchall()
    briefing_dates = {r[0] for r in briefing_rows}
    conn.close()

    now_kst_str = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    result = []
    has_today = False

    for r in rows:
        d_key = r["date_key"]
        if not d_key or len(d_key) < 10:
            continue
        if d_key == now_kst_str:
            has_today = True
        result.append({
            "date": d_key,
            "label": get_date_label(d_key),
            "total_count": r["total_count"],
            "unread_count": r["unread_count"] or 0,
            "has_briefing": d_key in briefing_dates,
        })

    # 오늘 날짜가 아직 DB에 없더라도 '오늘' 탭은 맨 앞에 항상 유지
    if not has_today:
        result.insert(0, {
            "date": now_kst_str,
            "label": "오늘",
            "total_count": 0,
            "unread_count": 0,
            "has_briefing": now_kst_str in briefing_dates,
        })

    return result


@router.post("/dates/{date}/read-all")
def mark_date_all_read(date: str):
    """해당 날짜의 모든 기사를 일괄 읽음 처리"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        UPDATE news_articles 
        SET is_read = 1 
        WHERE COALESCE(NULLIF(substr(published_at, 1, 10), ''), substr(fetched_at, 1, 10)) = ?
    """, (date,))
    conn.commit()
    conn.close()
    return {"ok": True, "date": date}


# ─── 기사 목록 API (날짜 필터 지원) ──────────────────────────────────
@router.get("/articles")
def get_articles(
    source_id: Optional[str] = None,
    category: Optional[str] = None,
    keyword: Optional[str] = None,
    stock: Optional[str] = None,
    date: Optional[str] = None,
    bookmarked: Optional[bool] = None,
    limit: int = 60,
    offset: int = 0,
):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    query = """
        SELECT a.*, s.name as source_name, s.icon as source_icon, s.category
        FROM news_articles a
        JOIN news_sources s ON a.source_id = s.id
        WHERE 1=1
    """
    params = []

    # 📅 날짜 필터링 (YYYY-MM-DD)
    if date:
        query += " AND COALESCE(NULLIF(substr(a.published_at, 1, 10), ''), substr(a.fetched_at, 1, 10)) = ?"
        params.append(date)

    if source_id:
        query += " AND a.source_id = ?"
        params.append(source_id)

    if category:
        query += " AND s.category = ?"
        params.append(category)

    if keyword:
        query += " AND (a.title LIKE ? OR a.summary LIKE ?)"
        params.extend([f"%{keyword}%", f"%{keyword}%"])

    # 📊 관심종목 필터링
    if stock:
        if stock == "__all__":
            query += " AND (a.mentioned_stocks IS NOT NULL AND a.mentioned_stocks != '')"
        else:
            query += " AND a.mentioned_stocks LIKE ?"
            params.append(f"%{stock}%")

    if bookmarked is not None:
        query += " AND a.is_bookmarked = ?"
        params.append(1 if bookmarked else 0)

    query += " ORDER BY a.published_at DESC, a.fetched_at DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── 날짜별 데일리 AI 종합 브리핑 API ─────────────────────────────────
@router.get("/dates/{date}/briefing")
def get_daily_briefing(date: str):
    """해당 날짜의 기존 AI 브리핑 조회"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM daily_news_briefings WHERE date = ?", (date,)).fetchone()
    conn.close()
    if row:
        return dict(row)
    return {"date": date, "content": None}


@router.post("/dates/{date}/briefing")
async def generate_daily_briefing(date: str, force: bool = False):
    """특정 날짜의 기사들을 종합하여 실시간 SSE 스트리밍으로 데일리 브리핑 생성"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # 캐시 확인 (force가 아니면 기존 브리핑 즉시 반환)
    if not force:
        cached = conn.execute("SELECT * FROM daily_news_briefings WHERE date = ?", (date,)).fetchone()
        if cached and cached["content"]:
            conn.close()
            async def cached_stream():
                yield f"data: {json.dumps({'type': 'cached', 'text': cached['content'], 'date': date})}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(cached_stream(), media_type="text/event-stream")

    # 해당 일자의 주요 기사 추출 (최대 25개: 관심종목 언급 기사 우선)
    articles = conn.execute("""
        SELECT a.title, a.summary, a.mentioned_stocks, s.name as source_name, s.category
        FROM news_articles a
        JOIN news_sources s ON a.source_id = s.id
        WHERE COALESCE(NULLIF(substr(a.published_at, 1, 10), ''), substr(a.fetched_at, 1, 10)) = ?
        ORDER BY 
            CASE WHEN a.mentioned_stocks IS NOT NULL AND a.mentioned_stocks != '' THEN 0 ELSE 1 END,
            a.published_at DESC
        LIMIT 25
    """, (date,)).fetchall()
    conn.close()

    if not articles:
        async def empty_stream():
            msg = f"{date} 날짜에 수집된 기사가 없어 브리핑을 생성할 수 없습니다."
            yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(empty_stream(), media_type="text/event-stream")

    # 기사 목록 텍스트 생성
    article_lines = []
    for i, a in enumerate(articles, 1):
        stock_tag = f" [관련: {a['mentioned_stocks']}]" if a["mentioned_stocks"] else ""
        summary_clean = (a["summary"] or "")[:150].replace("\n", " ")
        article_lines.append(f"{i}. [{a['category']}/{a['source_name']}] {a['title']}{stock_tag}\n   - 요약: {summary_clean}")

    article_bullet_text = "\n".join(article_lines)

    date_label = get_date_label(date)
    prompt = f"""당신은 세계 최고 수준의 IT/테크 및 증권 금융 수석 리서치 애널리스트입니다.
{date} ({date_label}) 하루 동안 수집된 주요 뉴스 기사 {len(articles)}건을 분석하여, 바쁜 사용자가 1분 만에 오늘의 모든 핵심 흐름을 완벽히 꿰뚫을 수 있도록 고품질 '데일리 종합 뉴스 브리핑'을 작성해주세요.

[수집된 {date} 주요 기사 목록]
{article_bullet_text}

다음 형식으로 명확하고 가독성 높게(마크다운, 볼드, 이모지) 작성해주세요:

# 📰 {date} ({date_label}) 데일리 뉴스 종합 브리핑

## 🔥 오늘의 3대 빅 이슈 & 파급 효과
1. **[이슈 1 핵심 제목]**: 구체적 사건 내용 및 이것이 업계나 시장에 미치는 영향 2줄 설명
2. **[이슈 2 핵심 제목]**: 구체적 사건 내용 및 이것이 업계나 시장에 미치는 영향 2줄 설명
3. **[이슈 3 핵심 제목]**: 구체적 사건 내용 및 이것이 업계나 시장에 미치는 영향 2줄 설명

## ⚡ IT · AI 테크 시장 주요 동향
- **[테크 트렌드]**: 주요 기술 발표, AI 모델, 반도체 및 빅테크 흐름 요약

## 📈 관심 종목(반도체/빅테크/경제) 동향
- **[기업명/종목]**: 해당 기업 관련 주요 이슈 요약 (언급된 경우만 작성)

## 💡 오늘의 1줄 인사이트
> (오늘 하루의 뉴스를 관통하는 핵심 메시지 1줄)
"""

    async def generate_briefing():
        accumulated = ""
        # 1. agy CLI (Gemini 3.8 Flash) 시도
        try:
            cmd = [
                AGY_BIN,
                "-p", prompt,
                "--model", "gemini-3.8-flash-medium",
                "--output-format", "stream-json",
                "--dangerously-skip-permissions",
            ]
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
                    if data.get("event") == "step_update":
                        delta = data.get("step_update", {}).get("text_delta", "")
                        if delta:
                            accumulated += delta
                            yield f"data: {json.dumps({'type': 'token', 'text': delta})}\n\n"
                except Exception:
                    continue

            await proc.wait()
        except Exception as e:
            # agy 실패 시 Ollama fallback
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    async with client.stream(
                        "POST",
                        "http://localhost:11434/api/generate",
                        json={
                            "model": "gemma3:12b",
                            "prompt": prompt,
                            "stream": True,
                        },
                    ) as resp:
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            try:
                                d = json.loads(line)
                                token = d.get("response", "")
                                accumulated += token
                                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
                                if d.get("done"):
                                    break
                            except Exception:
                                continue
            except Exception as e2:
                yield f"data: {json.dumps({'type': 'error', 'message': f'AI 브리핑 생성 실패: {str(e2)}'})}\n\n"
                yield "data: [DONE]\n\n"
                return

        # DB에 캐시 저장 (UPSERT)
        if accumulated:
            try:
                conn2 = sqlite3.connect(DB_PATH)
                conn2.execute("""
                    INSERT INTO daily_news_briefings (date, content, article_count, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(date) DO UPDATE SET
                        content = excluded.content,
                        article_count = excluded.article_count,
                        updated_at = datetime('now')
                """, (date, accumulated, len(articles)))
                conn2.commit()
                conn2.close()
            except Exception as err:
                print(f"[ERROR] 브리핑 DB 저장 실패: {err}")

        yield f"data: {json.dumps({'type': 'done', 'full_text': accumulated, 'date': date})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate_briefing(), media_type="text/event-stream")


@router.get("/articles/count")
def get_unread_count():
    conn = sqlite3.connect(DB_PATH)
    total = conn.execute("SELECT COUNT(*) FROM news_articles").fetchone()[0]
    unread = conn.execute("SELECT COUNT(*) FROM news_articles WHERE is_read = 0").fetchone()[0]
    bookmarked = conn.execute("SELECT COUNT(*) FROM news_articles WHERE is_bookmarked = 1").fetchone()[0]
    stocks_count = conn.execute(
        "SELECT COUNT(*) FROM news_articles WHERE mentioned_stocks IS NOT NULL AND mentioned_stocks != ''"
    ).fetchone()[0]
    conn.close()
    return {
        "total": total,
        "unread": unread,
        "bookmarked": bookmarked,
        "stocks": stocks_count,
    }


# ─── 관심종목 (워치리스트) API ───────────────────────────────────────────
class WatchlistCreate(BaseModel):
    name: str
    keywords: str
    icon: str = "📊"
    color: str = "#8b5cf6"


@router.get("/watchlist")
def get_watchlist():
    """워치리스트 목록 및 각 종목별 언급된 기사 개수 반환"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    items = conn.execute("SELECT * FROM news_watchlist ORDER BY created_at ASC").fetchall()
    
    result = []
    for item in items:
        d = dict(item)
        # 종목 언급 기사 수 집계
        cnt = conn.execute(
            "SELECT COUNT(*) FROM news_articles WHERE mentioned_stocks LIKE ?",
            (f"%{d['name']}%",)
        ).fetchone()[0]
        d["article_count"] = cnt
        result.append(d)

    conn.close()
    return result


@router.post("/watchlist")
def add_watchlist(body: WatchlistCreate):
    stock_id = hashlib.md5(body.name.encode()).hexdigest()[:10]
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("""
            INSERT INTO news_watchlist (id, name, keywords, icon, color)
            VALUES (?, ?, ?, ?, ?)
        """, (stock_id, body.name, body.keywords, body.icon, body.color))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="이미 등록된 종목입니다.")

    # 새로 추가된 종목에 대해 기존 기사 재스캔
    rescan_articles_for_stock(conn, body.name, body.keywords)
    conn.close()
    return {"id": stock_id, "message": f"{body.name} 관심종목이 추가되었습니다."}


@router.delete("/watchlist/{stock_id}")
def delete_watchlist(stock_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM news_watchlist WHERE id = ?", (stock_id,))
    conn.commit()
    conn.close()
    return {"message": "관심종목이 삭제되었습니다."}


@router.patch("/watchlist/{stock_id}/toggle")
def toggle_watchlist(stock_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        UPDATE news_watchlist SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END
        WHERE id = ?
    """, (stock_id,))
    conn.commit()
    row = conn.execute("SELECT is_active FROM news_watchlist WHERE id = ?", (stock_id,)).fetchone()
    conn.close()
    return {"is_active": row[0] if row else None}


@router.post("/watchlist/rescan")
def rescan_all_watchlist():
    """모든 기사를 대상으로 관심종목 키워드 전체 재스캔 및 DB 업데이트"""
    conn = sqlite3.connect(DB_PATH)
    articles = conn.execute("SELECT id, title, summary FROM news_articles").fetchall()
    
    updated_count = 0
    matched_articles = 0

    for art_id, title, summary in articles:
        mentioned = detect_mentioned_stocks((title or "") + " " + (summary or ""), conn)
        conn.execute(
            "UPDATE news_articles SET mentioned_stocks = ? WHERE id = ?",
            (mentioned or None, art_id)
        )
        if mentioned:
            matched_articles += 1
        updated_count += 1

    conn.commit()
    conn.close()
    return {"total_scanned": updated_count, "matched_articles": matched_articles}


def rescan_articles_for_stock(conn, name: str, keywords: str):
    """특정 종목 추가 시 해당 종목을 기존 기사들에서 찾아 mentioned_stocks에 추가"""
    kws = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    rows = conn.execute("SELECT id, title, summary, mentioned_stocks FROM news_articles").fetchall()
    for art_id, title, summary, curr_stocks in rows:
        text = ((title or "") + " " + (summary or "")).lower()
        if any(k in text for k in kws):
            stocks = set(curr_stocks.split(",")) if curr_stocks else set()
            stocks.add(name)
            conn.execute(
                "UPDATE news_articles SET mentioned_stocks = ? WHERE id = ?",
                (",".join(stocks), art_id)
            )
    conn.commit()


@router.patch("/articles/{article_id}/read")
def mark_read(article_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE news_articles SET is_read = 1 WHERE id = ?", (article_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.patch("/articles/{article_id}/bookmark")
def toggle_bookmark(article_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        UPDATE news_articles SET is_bookmarked = CASE WHEN is_bookmarked = 1 THEN 0 ELSE 1 END
        WHERE id = ?
    """, (article_id,))
    conn.commit()
    row = conn.execute("SELECT is_bookmarked FROM news_articles WHERE id = ?", (article_id,)).fetchone()
    conn.close()
    return {"is_bookmarked": row[0] if row else 0}


@router.delete("/articles/clear")
def clear_old_articles(days: int = 30):
    """오래된 기사 삭제 (기본 30일)"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        DELETE FROM news_articles
        WHERE is_bookmarked = 0
        AND fetched_at < datetime('now', ?)
    """, (f"-{days} days",))
    conn.commit()
    conn.close()
    return {"message": f"{days}일 이전 기사가 삭제되었습니다."}


# ─── AI 요약 스트리밍 API ─────────────────────────────────────────────
@router.get("/articles/{article_id}/summarize")
async def summarize_article(article_id: str, model: str = "gemma3:12b"):
    """기사 클릭 시 Ollama로 실시간 AI 요약 스트리밍"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM news_articles WHERE id = ?", (article_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="기사를 찾을 수 없습니다.")

    article = dict(row)

    # 이미 요약이 있으면 캐시 반환
    if article.get("ai_summary"):
        async def cached_stream():
            yield f"data: {json.dumps({'type': 'cached', 'text': article['ai_summary'], 'keywords': article.get('keywords', '')})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(cached_stream(), media_type="text/event-stream")

    # 본문 추출 (없으면 RSS summary 사용)
    content = article.get("content") or ""
    if not content or len(content) < 100:
        content = extract_content(article["link"])

    text_for_summary = content or article.get("summary", "") or article["title"]
    text_for_summary = text_for_summary[:2000]

    prompt = f"""다음 뉴스 기사를 한국어로 분석해주세요.

제목: {article['title']}

내용:
{text_for_summary}

다음 형식으로 답변해주세요:

## 📋 3줄 요약
1. 
2. 
3. 

## 💡 핵심 포인트
- 

## 🔑 키워드
(쉼표로 구분된 5개 이하 핵심 키워드)"""

    async def generate():
        full_text = ""
        keywords = ""
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream(
                    "POST",
                    "http://localhost:11434/api/generate",
                    json={
                        "model": model,
                        "prompt": prompt,
                        "stream": True,
                        "options": {"temperature": 0.3, "num_predict": 600},
                    },
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            token = data.get("response", "")
                            full_text += token
                            yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"

                            if data.get("done"):
                                # 키워드 추출
                                import re
                                kw_match = re.search(r"##\s*🔑\s*키워드\s*\n([^\n#]+)", full_text)
                                if kw_match:
                                    keywords = kw_match.group(1).strip()

                                # DB에 저장
                                conn2 = sqlite3.connect(DB_PATH)
                                conn2.execute("""
                                    UPDATE news_articles
                                    SET ai_summary = ?, keywords = ?, content = ?
                                    WHERE id = ?
                                """, (full_text, keywords, content or article.get("summary", ""), article_id))
                                conn2.commit()
                                conn2.close()

                                yield f"data: {json.dumps({'type': 'done', 'keywords': keywords})}\n\n"
                                yield "data: [DONE]\n\n"
                                break
                        except json.JSONDecodeError:
                            continue

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ─── 키워드 트렌드 API ────────────────────────────────────────────────
@router.get("/trends")
def get_trends(limit: int = 20):
    """최근 기사에서 키워드 빈도 분석"""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT keywords FROM news_articles
        WHERE keywords IS NOT NULL AND keywords != ''
        AND fetched_at > datetime('now', '-7 days')
    """).fetchall()
    conn.close()

    from collections import Counter
    counter = Counter()
    for row in rows:
        for kw in row[0].split(","):
            kw = kw.strip()
            if kw and len(kw) > 1:
                counter[kw] += 1

    return [{"keyword": kw, "count": cnt} for kw, cnt in counter.most_common(limit)]

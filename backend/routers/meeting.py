"""
Bill Studio - 컴짱회의 라우터
OBS 녹화/녹음 파일 기반 AI 대화록 추출(Faster-Whisper) + AI 회의록 요약(Gemini 3.8 Flash / Ollama)
캘린더 기반 회의 관리 및 액션 아이템 체크리스트 시스템
"""

import asyncio
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import List, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.subtitle import get_whisper_model
from utils import DOWNLOAD_DIR, find_download_file

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

DB_PATH = Path(__file__).resolve().parent.parent / "studio.db"
AGY_BIN = "/Users/bill/.local/bin/agy"
MEETINGS_DIR = DOWNLOAD_DIR / "meetings"
MEETINGS_DIR.mkdir(parents=True, exist_ok=True)


# ─── DB 초기화 ────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            meeting_date TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            duration_sec INTEGER DEFAULT 0,
            audio_file TEXT,
            summary TEXT,
            action_items TEXT,
            full_transcript TEXT,
            raw_text TEXT,
            tags TEXT,
            status TEXT DEFAULT 'completed',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
        )
    """)
    conn.commit()
    conn.close()


init_db()


# ─── Pydantic 모델 ─────────────────────────────────────────────────────────────
class ActionItem(BaseModel):
    id: str
    task: str
    assignee: Optional[str] = ""
    due_date: Optional[str] = ""
    done: bool = False


class MeetingCreate(BaseModel):
    title: str
    meeting_date: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    duration_sec: Optional[int] = 0
    audio_file: Optional[str] = None
    summary: Optional[str] = ""
    action_items: Optional[List[dict]] = []
    full_transcript: Optional[List[dict]] = []
    raw_text: Optional[str] = ""
    tags: Optional[List[str]] = []


class MeetingUpdate(BaseModel):
    title: Optional[str] = None
    meeting_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    duration_sec: Optional[int] = None
    summary: Optional[str] = None
    action_items: Optional[List[dict]] = None
    tags: Optional[List[str]] = None


class ActionItemToggle(BaseModel):
    item_id: str
    done: bool


class ProcessMeetingRequest(BaseModel):
    file: str
    title: Optional[str] = None
    meeting_date: Optional[str] = None
    start_time: Optional[str] = None
    model_name: Optional[str] = "gemini-3.8-flash-medium"
    whisper_size: Optional[str] = "base"


class AutoProcessRequest(BaseModel):
    files: Optional[List[str]] = None  # 특정 파일 목록 (None이면 모든 미등록 파일 자동 처리)
    model_name: Optional[str] = "gemini-3.8-flash-medium"
    whisper_size: Optional[str] = "base"


# ─── 헬퍼 함수 ────────────────────────────────────────────────────────────────
def parse_meeting_file_datetime(file_path: Path) -> tuple[str, str]:
    """
    파일명 또는 파일 메타데이터에서 회의 일자(YYYY-MM-DD)와 시작 시간(HH:MM)을 자동 추출
    예:
    - 2026-09-28 10-54-39.mp4 -> 2026-09-28, 10:54
    - 2026-09-28_10-54-39.mp4 -> 2026-09-28, 10:54
    - 20260928_105439.mp4 -> 2026-09-28, 10:54
    - 2026-09-28.mp4 -> 2026-09-28, mtime의 HH:MM
    """
    name = file_path.stem
    # 1. 2026-09-28 10-54-39 또는 2026-09-28_10-54-39, 2026-09-28 10.54.39 등
    m1 = re.search(r'(\d{4})[-_](\d{2})[-_](\d{2})[ _T](\d{2})[-_:\.](\d{2})', name)
    if m1:
        y, mo, d, hh, mm = m1.groups()
        return f"{y}-{mo}-{d}", f"{hh}:{mm}"

    # 2. 20260928_105439
    m2 = re.search(r'(\d{4})(\d{2})(\d{2})[ _T](\d{2})(\d{2})', name)
    if m2:
        y, mo, d, hh, mm = m2.groups()
        return f"{y}-{mo}-{d}", f"{hh}:{mm}"

    # 3. 날짜만 있는 경우 (예: 2026-09-28 회의.mp4)
    m3 = re.search(r'(\d{4})[-_](\d{2})[-_](\d{2})', name)
    if m3:
        y, mo, d = m3.groups()
        stat = file_path.stat()
        hh_mm = datetime.fromtimestamp(stat.st_mtime).strftime("%H:%M")
        return f"{y}-{mo}-{d}", hh_mm

    # 4. 파일 수정 시간 mtime 기반
    stat = file_path.stat()
    dt = datetime.fromtimestamp(stat.st_mtime)
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")


def get_media_duration_sec(file_path: Path) -> int:
    """ffprobe를 이용해 오디오/비디오 길이(초) 측정"""
    import subprocess
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(file_path)
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return int(float(res.stdout.strip()))
    except Exception:
        pass
    return 0


# ─── 녹화 파일 목록 및 미등록 감지 API ─────────────────────────────────────────
@router.get("/unregistered")
def get_unregistered_recordings():
    """
    downloads/meetings 폴더 (및 downloads 내 회의 녹화 파일)에서
    아직 회의록으로 DB에 등록되지 않은 녹화 파일들을 날짜별로 자동 분류하여 반환
    """
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    rows = c.execute("SELECT audio_file FROM meetings WHERE audio_file IS NOT NULL AND audio_file != ''").fetchall()
    conn.close()

    registered_paths = set()
    for (af,) in rows:
        registered_paths.add(af)
        registered_paths.add(Path(af).name)

    allowed_exts = {".mp4", ".mkv", ".mov", ".m4a", ".mp3", ".wav", ".webm", ".aac"}
    unregistered = []

    # meetings 디렉토리 우선 스캔
    search_dirs = [MEETINGS_DIR]
    seen_rel_paths = set()

    for sdir in search_dirs:
        if not sdir.exists():
            continue
        for p in sdir.iterdir():
            if p.is_file() and p.suffix.lower() in allowed_exts and not p.name.startswith("."):
                rel_path = str(p.relative_to(DOWNLOAD_DIR))
                if rel_path in registered_paths or p.name in registered_paths:
                    continue
                if rel_path in seen_rel_paths:
                    continue
                seen_rel_paths.add(rel_path)

                stat = p.stat()
                mdate, mtime = parse_meeting_file_datetime(p)
                duration_sec = get_media_duration_sec(p)

                # 추천 제목 생성 (예: 9월 28일 컴짱회의 (10:54))
                try:
                    dt_obj = datetime.strptime(mdate, "%Y-%m-%d")
                    suggested_title = f"{dt_obj.month}월 {dt_obj.day}일 컴짱회의 ({mtime})"
                except Exception:
                    suggested_title = f"{mdate} 컴짱회의 ({mtime})"

                unregistered.append({
                    "name": p.name,
                    "rel_path": rel_path,
                    "meeting_date": mdate,
                    "start_time": mtime,
                    "suggested_title": suggested_title,
                    "size_mb": round(stat.st_size / (1024 * 1024), 2),
                    "duration_sec": duration_sec,
                    "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                })

    # 날짜 최신순, 시간 최신순 정렬
    unregistered.sort(key=lambda x: (x["meeting_date"], x["start_time"]), reverse=True)
    return unregistered


@router.get("/files")
def list_recording_files():
    """downloads/ 및 downloads/meetings/ 폴더 내 녹화 파일 목록 조회 (최신순)"""
    allowed_exts = {".mp4", ".mkv", ".mov", ".m4a", ".mp3", ".wav", ".webm", ".aac"}
    files = []

    # meetings 디렉토리 및 downloads 전체 검색
    search_dirs = [MEETINGS_DIR, DOWNLOAD_DIR]
    seen_names = set()

    for sdir in search_dirs:
        if not sdir.exists():
            continue
        for p in sdir.iterdir():
            if p.is_file() and p.suffix.lower() in allowed_exts and not p.name.startswith("."):
                rel_path = str(p.relative_to(DOWNLOAD_DIR))
                if rel_path in seen_names:
                    continue
                seen_names.add(rel_path)

                stat = p.stat()
                mtime_str = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
                size_mb = round(stat.st_size / (1024 * 1024), 2)
                files.append({
                    "name": p.name,
                    "rel_path": rel_path,
                    "size_mb": size_mb,
                    "mtime": mtime_str,
                    "ext": p.suffix.lower(),
                })

    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


@router.post("/upload")
async def upload_meeting_file(file: UploadFile = File(...)):
    """회의 음성/영상 파일 직접 업로드 (downloads/meetings/에 저장)"""
    safe_name = re.sub(r'[^\w\-_\. ]', '_', file.filename)
    dest_path = MEETINGS_DIR / safe_name
    
    # 중복 시 타임스탬프 추가
    if dest_path.exists():
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        stem = Path(safe_name).stem
        ext = Path(safe_name).suffix
        safe_name = f"{stem}_{timestamp}{ext}"
        dest_path = MEETINGS_DIR / safe_name

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    stat = dest_path.stat()
    return {
        "ok": True,
        "name": safe_name,
        "rel_path": str(dest_path.relative_to(DOWNLOAD_DIR)),
        "size_mb": round(stat.st_size / (1024 * 1024), 2),
    }


# ─── 회의록 CRUD API ───────────────────────────────────────────────────────────
@router.get("")
def get_meetings(year: Optional[int] = None, month: Optional[int] = None, date: Optional[str] = None):
    """회의 목록 조회 (연/월 또는 특정 날짜 필터링)"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    query = "SELECT * FROM meetings"
    params = []

    if date:
        query += " WHERE meeting_date = ?"
        params.append(date)
    elif year and month:
        prefix = f"{year:04d}-{month:02d}-%"
        query += " WHERE meeting_date LIKE ?"
        params.append(prefix)
    elif year:
        prefix = f"{year:04d}-%"
        query += " WHERE meeting_date LIKE ?"
        params.append(prefix)

    query += " ORDER BY meeting_date DESC, start_time DESC, created_at DESC"
    rows = c.execute(query, params).fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d["action_items"] = json.loads(d["action_items"]) if d.get("action_items") else []
        d["tags"] = json.loads(d["tags"]) if d.get("tags") else []
        if d.get("full_transcript"):
            try:
                d["full_transcript"] = json.loads(d["full_transcript"])
            except Exception:
                pass
        result.append(d)

    return result


@router.get("/{meeting_id}")
def get_meeting_detail(meeting_id: str):
    """특정 회의 상세 정보 조회"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")

    d = dict(row)
    d["action_items"] = json.loads(d["action_items"]) if d.get("action_items") else []
    d["tags"] = json.loads(d["tags"]) if d.get("tags") else []
    if d.get("full_transcript"):
        try:
            d["full_transcript"] = json.loads(d["full_transcript"])
        except Exception:
            pass

    return d


@router.post("")
def create_manual_meeting(body: MeetingCreate):
    """수동으로 새 회의 등록"""
    meeting_id = str(uuid.uuid4())
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT INTO meetings (
            id, title, meeting_date, start_time, end_time, duration_sec,
            audio_file, summary, action_items, full_transcript, raw_text, tags, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        meeting_id,
        body.title,
        body.meeting_date,
        body.start_time or datetime.now().strftime("%H:%M"),
        body.end_time or "",
        body.duration_sec or 0,
        body.audio_file or "",
        body.summary or "",
        json.dumps(body.action_items, ensure_ascii=False),
        json.dumps(body.full_transcript, ensure_ascii=False),
        body.raw_text or "",
        json.dumps(body.tags, ensure_ascii=False),
        "completed",
    ))
    conn.commit()
    conn.close()

    if body.action_items:
        try:
            sync_action_items_to_schedule(meeting_id, body.action_items, body.title, body.meeting_date or "")
        except Exception as e:
            print(f"[Meeting Manual Sync Error] {e}")

    return {"ok": True, "id": meeting_id}


@router.put("/{meeting_id}")
def update_meeting(meeting_id: str, body: MeetingUpdate):
    """회의 정보 수정"""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    updates = []
    params = []

    if body.title is not None:
        updates.append("title = ?")
        params.append(body.title)
    if body.meeting_date is not None:
        updates.append("meeting_date = ?")
        params.append(body.meeting_date)
    if body.start_time is not None:
        updates.append("start_time = ?")
        params.append(body.start_time)
    if body.end_time is not None:
        updates.append("end_time = ?")
        params.append(body.end_time)
    if body.duration_sec is not None:
        updates.append("duration_sec = ?")
        params.append(body.duration_sec)
    if body.summary is not None:
        updates.append("summary = ?")
        params.append(body.summary)
    if body.action_items is not None:
        updates.append("action_items = ?")
        params.append(json.dumps(body.action_items, ensure_ascii=False))
    if body.tags is not None:
        updates.append("tags = ?")
        params.append(json.dumps(body.tags, ensure_ascii=False))

    updates.append("updated_at = datetime('now', 'localtime')")
    params.append(meeting_id)

    c.execute(f"UPDATE meetings SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()

    # 수정된 정보 조회 후 액션 아이템 동기화
    row = c.execute("SELECT title, meeting_date, action_items FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    conn.close()

    if row and row[2]:
        try:
            items = json.loads(row[2])
            sync_action_items_to_schedule(meeting_id, items, row[0], row[1] or "")
        except Exception as e:
            print(f"[Meeting Update Sync Error] {e}")

    return {"ok": True}


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: str):
    """회의 삭제"""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.patch("/{meeting_id}/action-item")
def toggle_action_item(meeting_id: str, body: ActionItemToggle):
    """회의의 특정 액션 아이템 완료/미완료 토글"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT action_items FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")

    items = json.loads(row["action_items"]) if row["action_items"] else []
    for item in items:
        if item.get("id") == body.item_id:
            item["done"] = body.done
            break

    conn.execute(
        "UPDATE meetings SET action_items = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        (json.dumps(items, ensure_ascii=False), meeting_id)
    )
    conn.commit()
    conn.close()
    return {"ok": True, "action_items": items}


class ResummarizeRequest(BaseModel):
    model_name: Optional[str] = "gemini-3.8-flash-medium"


@router.post("/{meeting_id}/resummarize")
async def resummarize_meeting(meeting_id: str, body: Optional[ResummarizeRequest] = None):
    """
    기존 회의의 대화록(raw_text)을 기반으로,
    녹음 진행 시간 순서(타임라인 순서)에 맞추어 회의록 요약과 액션아이템을 재작성합니다.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")

    m_title = row["title"]
    m_date = row["meeting_date"]
    m_time = row["start_time"]
    m_audio = row["audio_file"]
    raw_text = row["raw_text"] or ""
    full_transcript_json = row["full_transcript"] or ""

    if not raw_text.strip() and full_transcript_json:
        try:
            segments = json.loads(full_transcript_json)
            lines = []
            for s in segments:
                mins = int(s.get("start", 0) // 60)
                secs = int(s.get("start", 0) % 60)
                lines.append(f"[{mins:02d}:{secs:02d}] {s.get('text', '')}")
            raw_text = "\n".join(lines)
        except Exception:
            pass

    if not raw_text.strip():
        conn.close()
        raise HTTPException(status_code=400, detail="요약할 음성 대화록 전문이 없습니다.")

    file_name = Path(m_audio).name if m_audio else f"{m_date} 컴짱회의"
    model_name = body.model_name if body and body.model_name else "gemini-3.8-flash-medium"

    summary_text, final_title, action_items, tags = await execute_ai_summary(
        raw_text=raw_text,
        file_name=file_name,
        meeting_date=m_date,
        start_time=m_time,
        custom_title=m_title,
        model_name=model_name,
    )

    conn.execute("""
        UPDATE meetings
        SET summary = ?, title = ?, action_items = ?, tags = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
    """, (
        summary_text,
        final_title,
        json.dumps(action_items, ensure_ascii=False),
        json.dumps(tags, ensure_ascii=False),
        meeting_id
    ))
    conn.commit()
    conn.close()

    # 액션 아이템 중 날짜가 있는 일정을 컴짱 캘린더에 자동 동기화
    synced_count = 0
    try:
        synced_count = sync_action_items_to_schedule(meeting_id, action_items, final_title, m_date)
    except Exception as e:
        print(f"[Meeting] 일정 자동 동기화 예외: {e}")

    return {
        "ok": True,
        "meeting_id": meeting_id,
        "title": final_title,
        "summary": summary_text,
        "action_items": action_items,
        "tags": tags,
        "synced_schedules": synced_count,
    }


@router.post("/{meeting_id}/sync-schedules")
def sync_meeting_schedules(meeting_id: str):
    """해당 회의의 액션 아이템들을 컴짱 캘린더로 수동 동기화"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT title, action_items, meeting_date FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다.")

    items = json.loads(row["action_items"]) if row["action_items"] else []
    synced = sync_action_items_to_schedule(meeting_id, items, row["title"], row["meeting_date"] or "")
    return {
        "ok": True,
        "synced_count": synced,
        "message": f"{synced}개의 일정이 '💻 컴짱' 캘린더에 동기화되었습니다!"
    }


# ─── AI 회의록 요약 실행 및 파싱 (녹음 시간 순서 엄수) ─────────────────────────
async def execute_ai_summary(
    raw_text: str,
    file_name: str,
    meeting_date: str,
    start_time: str,
    custom_title: Optional[str] = None,
    model_name: str = "gemini-3.8-flash-medium",
) -> tuple[str, str, list, list]:
    """
    대화록 전문(시간 타임코드 포함)을 바탕으로,
    실제 녹음 시간 순서(타임라인 흐름)대로 회의록을 요약하고 마크다운 및 메타데이터를 추출합니다.
    """
    # 회의 내용이 누락되지 않도록 넉넉하게 대화록 전달 (Gemini는 80000자 이상 완벽 수용)
    truncated_raw = raw_text[:80000] if len(raw_text) > 80000 else raw_text

    ai_prompt = f"""당신은 '컴짱회의'의 전문 회의 기록 및 비즈니스 요약 비서입니다.
아래의 회의 음성 인식 대화록 전문(시간 타임코드 포함)을 바탕으로, 실무에서 바로 공유하고 관리할 수 있는 최고 품질의 회의록을 작성해주세요.

[회의 정보]
- 파일명: {file_name}
- 일자: {meeting_date}
- 시작시간: {start_time}
- 사용자 지정 제목(있다면): {custom_title or '없음 (내용을 바탕으로 핵심적인 회의 제목 생성 요망)'}

[대화록 전문 (실제 녹음 시간 순서대로 정렬됨)]
{truncated_raw}

---
[⭐ 가장 중요한 필수 규칙: 녹음 진행 순서(시간 흐름) 엄수 및 일정 추출]
1. **회의록 요약 내용의 순서는 반드시 실제 녹음이 진행된 시간 순서(타임라인 순서)와 100% 일치해야 합니다.**
2. 시간 순서를 절대 임의로 재배치하거나 뒤섞지 마세요. 회의 시작 시점 ➔ 전개/중반부 ➔ 후반/마무리 시점의 흐름을 그대로 따라가야 합니다.
3. '주요 논의 사항'에서는 각 안건/주제 블록마다 해당 발언이 나온 **타임코드 구간(예: [00:00 ~ 05:20], [05:21 ~ 13:40])**을 제목 앞에 반드시 기재하여, 회의 음성/영상과 1:1로 정확히 동기화되도록 작성하세요.
4. '핵심 요약' 역시 회의 전반부 ➔ 중반부 ➔ 후반부의 진행 흐름 순서대로 3줄로 작성하세요.
5. **[🔥 일정 자동 등록 핵심 지침 - 누락 금지!]**
   - 대화 중 언급된 마감 일정, 후속 미팅(다음 회의), 릴리즈/배포, 보고서 제출, 중간 점검, 정산/결제 등 **'날짜나 기한이 있는 모든 일정 및 할 일'은 빠짐없이 아래 '🚀 액션 아이템 및 일정' 섹션에 기재해야 합니다.**
   - 기한은 회의 날짜(기준일: {meeting_date})를 고려하여 반드시 **'YYYY-MM-DD' 형식의 명확한 날짜**로 계산하여 작성해주세요.
     - 예: '다음 주 수요일까지 초안 작성' ➔ (기한: YYYY-MM-DD)
     - 예: '10월 15일에 후속 회의 진행' ➔ - [ ] [전체] 차기 컴짱 회의 (기한: 2026-10-15)
     - 예: '내일까지 수정본 전달' ➔ (기한: YYYY-MM-DD)
   - 기한이 있는 항목은 스튜디오 캘린더의 **'💻 컴짱' 캘린더에 자동으로 실시간 등록**되므로 날짜를 정확한 YYYY-MM-DD로 기재하는 것이 매우 중요합니다.

[작성 지침 및 필수 마크다운 출력 형식]
반드시 아래의 마크다운 형식으로 작성해주세요:

# [제목] (회의 전체를 관통하는 명확하고 핵심적인 제목)

## 📌 핵심 요약 (회의 진행 순서별)
- 1. [회의 초반]: (회의 초반에 공유된 현황 및 시작 안건 요약)
- 2. [회의 중반]: (중반부에 집중적으로 논의된 핵심 이슈 및 논의점 요약)
- 3. [회의 후반]: (후반부에 정리된 결론, 피드백, 향후 진행 방향 요약)

## 🗣️ 주요 논의 사항 (녹음 시간 순서대로 정리)
- **[00:00 ~ 타임코드] 안건 1 제목**:
  - (논의 배경 및 핵심 발언 요점)
  - (세부 의견 교환 및 확인된 문제점)
- **[타임코드 ~ 타임코드] 안건 2 제목**:
  - (이어서 논의된 내용 및 발언 요점)
- **[타임코드 ~ 타임코드] 안건 3 제목**:
  - (후반부에 논의된 내용 및 발언 요점)
(※ 실제 녹음 순서대로 시간순으로 빠짐없이 작성할 것)

## ✅ 최종 결정 사항
- (회의 전체를 통해 최종적으로 합의되거나 확정된 정책, 방향, 규칙 등)

## 🚀 액션 아이템 및 일정 (Action Items & Schedules)
- [ ] [담당자] 구체적인 할 일 또는 일정 내용 (기한: YYYY-MM-DD)

## 🏷️ 태그
#키워드1, #키워드2, #키워드3
"""

    summary_text = ""
    try:
        if model_name.startswith("ollama:"):
            ol_mod = model_name.replace("ollama:", "")
            async with httpx.AsyncClient(timeout=180.0) as client:
                resp = await client.post(
                    "http://localhost:11434/api/generate",
                    json={"model": ol_mod, "prompt": ai_prompt, "stream": False},
                )
                summary_text = resp.json().get("response", "")
        else:
            cmd = [
                AGY_BIN,
                "-p", ai_prompt,
                "--model", model_name,
                "--output-format", "stream-json",
                "--dangerously-skip-permissions",
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            accumulated = []
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
                            accumulated.append(delta)
                    elif data.get("event") == "result":
                        res_text = data.get("result", {}).get("response", "")
                        if res_text and not accumulated:
                            accumulated.append(res_text)
                except json.JSONDecodeError:
                    pass
            await proc.wait()
            summary_text = "".join(accumulated).strip()
    except Exception as e:
        summary_text = f"## 📌 회의 요약\n회의록 생성 중 오류가 발생했습니다: {str(e)}\n\n대화록 원문을 참고해주세요."

    # 제목 및 태그, 액션 아이템 파싱
    final_title = custom_title
    if not final_title or not final_title.strip():
        title_match = re.search(r"^#\s+(.+)$", summary_text, re.MULTILINE)
        if title_match:
            final_title = title_match.group(1).replace("[제목]", "").strip("[] ")
        else:
            final_title = f"{meeting_date} 컴짱회의 ({start_time})"

    tags = []
    tags_match = re.search(r"## 🏷️ 태그\s*\n([^\n]+)", summary_text)
    if tags_match:
        raw_tags = tags_match.group(1)
        found_tags = re.findall(r"#([\w가-힣]+)", raw_tags)
        tags = [t.strip() for t in found_tags if t.strip()]
    if not tags:
        tags = ["컴짱회의", "음성녹음"]

    action_items = []
    action_matches = re.findall(r"-\s*\[([ xX])\]\s*(.+)", summary_text)
    for idx, (check, act_text) in enumerate(action_matches, start=1):
        act_text = act_text.strip()
        assignee = ""
        due_date = ""

        assignee_m = re.search(r"\[([가-힣\w]+)\]", act_text)
        if assignee_m:
            assignee = assignee_m.group(1)
            act_text = act_text.replace(assignee_m.group(0), "").strip()

        due_m = re.search(r"\(기한:\s*([^)]+)\)", act_text)
        if due_m:
            due_date = due_m.group(1).strip()
            act_text = act_text.replace(due_m.group(0), "").strip()
        else:
            # 기한 괄호가 없을 경우 텍스트 내에서 스마트 날짜 추출 시도
            extracted_date = parse_korean_due_date(act_text, meeting_date)
            if extracted_date:
                due_date = extracted_date

        action_items.append({
            "id": f"act_{uuid.uuid4().hex[:8]}",
            "task": act_text,
            "assignee": assignee,
            "due_date": due_date,
            "done": check.lower() == "x",
        })

    return summary_text, final_title, action_items, tags


def parse_korean_due_date(due_str: str, base_date_str: str = "") -> Optional[str]:
    """다양한 한국어/숫자 날짜 형식을 YYYY-MM-DD 형식으로 스마트 변환"""
    if not due_str:
        return None
    due_str = due_str.strip()

    # 기준일 파싱 (없으면 오늘)
    try:
        if base_date_str:
            base_dt = datetime.strptime(base_date_str[:10], "%Y-%m-%d")
        else:
            base_dt = datetime.now()
    except Exception:
        base_dt = datetime.now()

    # 1. YYYY-MM-DD 또는 YYYY.MM.DD 또는 YYYY/MM/DD
    m1 = re.search(r"(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})", due_str)
    if m1:
        y, m, d = int(m1.group(1)), int(m1.group(2)), int(m1.group(3))
        try:
            return f"{y:04d}-{m:02d}-{d:02d}"
        except Exception:
            pass

    # 2. YYYY년 M월 D일
    m2 = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", due_str)
    if m2:
        y, m, d = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        return f"{y:04d}-{m:02d}-{d:02d}"

    # 3. M월 D일 (연도 생략 시 기준일 연도 사용)
    m3 = re.search(r"(\d{1,2})월\s*(\d{1,2})일", due_str)
    if m3:
        m, d = int(m3.group(1)), int(m3.group(2))
        y = base_dt.year
        if base_dt.month == 12 and m == 1:
            y += 1
        return f"{y:04d}-{m:02d}-{d:02d}"

    # 4. MM/DD
    m4 = re.search(r"(?<!\d)(\d{1,2})/(\d{1,2})(?!\d)", due_str)
    if m4:
        m, d = int(m4.group(1)), int(m4.group(2))
        if 1 <= m <= 12 and 1 <= d <= 31:
            y = base_dt.year
            return f"{y:04d}-{m:02d}-{d:02d}"

    # 5. 상대 날짜: 오늘, 내일, 모레, 글피
    if "오늘" in due_str:
        return base_dt.strftime("%Y-%m-%d")
    if "내일" in due_str:
        return (base_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    if "모레" in due_str:
        return (base_dt + timedelta(days=2)).strftime("%Y-%m-%d")

    # 6. 다음주 / 이번주 요일
    weekdays_map = {"월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6}
    for day_name, day_idx in weekdays_map.items():
        if f"{day_name}요일" in due_str or (f"{day_name}" in due_str and ("이번주" in due_str or "다음주" in due_str)):
            current_weekday = base_dt.weekday()
            days_ahead = day_idx - current_weekday
            if "다음주" in due_str or "차주" in due_str:
                days_ahead += 7
            elif days_ahead < 0:
                days_ahead += 7
            target_dt = base_dt + timedelta(days=days_ahead)
            return target_dt.strftime("%Y-%m-%d")

    return None


def sync_action_items_to_schedule(meeting_id: str, action_items: list, meeting_title: str, meeting_date: str = "") -> int:
    """회의 액션 아이템 중 날짜/기한이 있는 항목을 '💻 컴짱' 캘린더에 자동 등록"""
    from models.database import SessionLocal
    from models.schedule_model import ScheduleEvent
    from routers.schedule import get_calendar_service, get_or_create_comjjang_calendar

    # 회의 날짜가 전달되지 않은 경우 DB에서 조회
    if not meeting_date:
        try:
            conn = sqlite3.connect(DB_PATH)
            row = conn.execute("SELECT meeting_date FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
            conn.close()
            if row and row[0]:
                meeting_date = row[0]
        except Exception:
            pass

    db = SessionLocal()
    added_count = 0
    try:
        service = get_calendar_service()
        comjjang_cal_id = get_or_create_comjjang_calendar(service) if service else "comjjang"

        # 구글 캘린더 기존 이벤트 사전 조회 (중복 등록 방지 캐시)
        existing_google_events = {}
        if service and comjjang_cal_id and comjjang_cal_id != "comjjang":
            try:
                g_list = service.events().list(calendarId=comjjang_cal_id, maxResults=250).execute()
                for g_item in g_list.get("items", []):
                    g_sum = (g_item.get("summary") or "").strip()
                    g_start = (g_item.get("start") or {}).get("date") or (g_item.get("start") or {}).get("dateTime", "")[:10]
                    if g_sum and g_start:
                        existing_google_events[(g_sum, g_start)] = g_item.get("id")
            except Exception as e:
                print(f"[Meeting -> Schedule] 구글 캘린더 기존 이벤트 목록 조회 스킵: {e}")

        for item in action_items:
            task = item.get("task", "").strip()
            raw_due = item.get("due_date", "").strip()
            assignee = item.get("assignee", "").strip()
            if not task:
                continue

            # 스마트 날짜 파싱 (due_date 또는 task 내 날짜 탐색)
            date_str = parse_korean_due_date(raw_due, meeting_date)
            if not date_str:
                date_str = parse_korean_due_date(task, meeting_date)

            if not date_str:
                continue

            cal_title = f"[컴짱] {task}"
            cal_desc = f"📌 회의: {meeting_title}\n👤 담당자: {assignee or '미지정'}\n🎯 할 일/일정: {task}\n(컴짱 회의록에서 자동 생성된 일정)"

            # 1. 이미 같은 회의 및 태스크 또는 같은 제목+날짜로 등록된 일정이 로컬 DB에 있는지 체크
            search_key = task[:15] if len(task) >= 15 else task
            existing_db = db.query(ScheduleEvent).filter(
                (ScheduleEvent.meeting_id == meeting_id) & (ScheduleEvent.title.contains(search_key))
            ).first()
            if not existing_db:
                existing_db = db.query(ScheduleEvent).filter(
                    (ScheduleEvent.title == cal_title) & (ScheduleEvent.start_time.startswith(date_str))
                ).first()

            # 2. 구글 캘린더에 이미 동일한 요약+날짜가 있는지 확인
            google_event_id = existing_google_events.get((cal_title, date_str))
            
            # 구글 캘린더에 없으면 신규 생성
            if not google_event_id and service and comjjang_cal_id and comjjang_cal_id != "comjjang":
                try:
                    g_body = {
                        "summary": cal_title,
                        "description": cal_desc,
                        "colorId": "7",  # 공작 / 스카이블루 (컴짱 대표 색상)
                        "start": {"date": date_str},
                        "end": {"date": date_str},
                    }
                    created_g = service.events().insert(calendarId=comjjang_cal_id, body=g_body).execute()
                    google_event_id = created_g.get("id")
                    existing_google_events[(cal_title, date_str)] = google_event_id
                except Exception as e:
                    print(f"[Meeting -> Schedule] 구글 컴짱 캘린더 등록 실패: {e}")

            if existing_db:
                # 이미 DB에 있으면 google_event_id만 보강하고 스킵
                if google_event_id and not existing_db.google_event_id:
                    existing_db.google_event_id = google_event_id
                    existing_db.source = "google"
                continue

            new_event = ScheduleEvent(
                google_event_id=google_event_id,
                calendar_id=comjjang_cal_id,
                title=cal_title,
                description=cal_desc,
                start_time=date_str,
                end_time=date_str,
                all_day=True,
                is_routine=False,
                is_comjjang=True,
                meeting_id=meeting_id,
                color_id="7",
                location="",
                source="google" if google_event_id else "local",
            )
            db.add(new_event)
            added_count += 1

        db.commit()
    except Exception as e:
        print(f"[Meeting -> Schedule] 일정 자동 동기화 에러: {e}")
        db.rollback()
    finally:
        db.close()
    return added_count


# ─── AI 회의록 처리 핵심 파이프라인 (공통 함수) ─────────────────────────────
async def execute_meeting_pipeline(
    file_path: Path,
    custom_title: Optional[str] = None,
    custom_meeting_date: Optional[str] = None,
    custom_start_time: Optional[str] = None,
    model_name: str = "gemini-3.8-flash-medium",
    whisper_size: str = "base",
    event_callback=None,
) -> dict:
    """단일 회의 녹화 파일에 대한 Whisper 음성인식 + Gemini/Ollama 요약 + DB 등록 파이프라인"""
    meeting_id = str(uuid.uuid4())

    # 날짜 및 시간 자동 감지
    parsed_date, parsed_time = parse_meeting_file_datetime(file_path)
    meeting_date = custom_meeting_date or parsed_date
    start_time = custom_start_time or parsed_time

    if event_callback:
        await event_callback({
            'step': 1, 'total_steps': 3, 'status': 'audio_analyzing',
            'message': f'회의 파일 분석 준비 중: {file_path.name} (날짜: {meeting_date} {start_time})',
            'file_name': file_path.name,
            'meeting_date': meeting_date,
            'start_time': start_time,
        })
        await asyncio.sleep(0.2)

    duration_sec = get_media_duration_sec(file_path)

    # 1. 단계 1: Faster-Whisper 음성 인식
    if event_callback:
        await event_callback({
            'step': 1, 'total_steps': 3, 'status': 'transcribing',
            'message': f'Faster-Whisper 로컬 AI가 음성을 텍스트로 변환 중입니다 ({file_path.name})...',
        })

    def run_transcription():
        model = get_whisper_model(whisper_size or "base")
        segments_gen, info = model.transcribe(
            str(file_path),
            language="ko",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400),
            beam_size=5,
        )
        segments = []
        raw_lines = []
        for idx, s in enumerate(segments_gen, start=1):
            txt = s.text.strip()
            if txt:
                segments.append({
                    "id": idx,
                    "start": round(s.start, 2),
                    "end": round(s.end, 2),
                    "text": txt,
                })
                mins = int(s.start // 60)
                secs = int(s.start % 60)
                raw_lines.append(f"[{mins:02d}:{secs:02d}] {txt}")
        return segments, "\n".join(raw_lines)

    segments, raw_text = await asyncio.to_thread(run_transcription)

    if not raw_text.strip():
        raw_text = "(음성이 감지되지 않았거나 매우 조용합니다)"

    if event_callback:
        await event_callback({
            'step': 2, 'total_steps': 3, 'status': 'transcribed',
            'message': f'음성 인식 완료! ({len(segments)}개 발언 추출)',
            'segment_count': len(segments)
        })
        await asyncio.sleep(0.2)

    # 2. 단계 2: AI 회의록 요약 및 구조화 (실제 녹음 시간 흐름 순서 엄수)
    if event_callback:
        await event_callback({
            'step': 2, 'total_steps': 3, 'status': 'summarizing',
            'message': 'AI가 녹음 시간 순서에 맞추어 핵심 요약, 타임라인 안건, 결정사항, 액션 아이템을 작성 중입니다...',
        })

    summary_text, final_title, action_items, tags = await execute_ai_summary(
        raw_text=raw_text,
        file_name=file_path.name,
        meeting_date=meeting_date,
        start_time=start_time,
        custom_title=custom_title,
        model_name=model_name or "gemini-3.8-flash-medium",
    )

    # 3. 단계 3: SQLite DB 저장
    if event_callback:
        await event_callback({
            'step': 3, 'total_steps': 3, 'status': 'saving',
            'message': f'회의록을 캘린더({meeting_date}) 데이터베이스에 안전하게 저장 중입니다...',
        })

    rel_audio = str(file_path.relative_to(DOWNLOAD_DIR))

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        INSERT INTO meetings (
            id, title, meeting_date, start_time, end_time, duration_sec,
            audio_file, summary, action_items, full_transcript, raw_text, tags, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        meeting_id,
        final_title,
        meeting_date,
        start_time,
        "",
        duration_sec,
        rel_audio,
        summary_text,
        json.dumps(action_items, ensure_ascii=False),
        json.dumps(segments, ensure_ascii=False),
        raw_text,
        json.dumps(tags, ensure_ascii=False),
        "completed",
    ))
    conn.commit()
    conn.close()

    # 4. 액션 아이템 중 기한이 있는 항목을 '컴짱 캘린더'에 자동 등록
    synced_schedules = 0
    try:
        synced_schedules = sync_action_items_to_schedule(meeting_id, action_items, final_title, meeting_date)
        print(f"[Meeting] 회의 '{final_title}'에서 {synced_schedules}개 일정 자동 등록 완료")
    except Exception as e:
        print(f"[Meeting Pipeline] 일정 동기화 오류: {e}")

    return {
        "meeting_id": meeting_id,
        "title": final_title,
        "meeting_date": meeting_date,
        "start_time": start_time,
        "duration_sec": duration_sec,
        "action_item_count": len(action_items),
        "synced_schedules": synced_schedules,
        "audio_file": rel_audio,
    }


# ─── 단일 회의록 생성 API (SSE 스트리밍) ────────────────────────────────────
@router.post("/process")
async def process_meeting_stream(req: ProcessMeetingRequest):
    """지정한 단일 파일에 대한 AI 회의록 분석 및 등록 (SSE 스트리밍)"""
    file_path = find_download_file(req.file)
    if not file_path:
        raise HTTPException(status_code=404, detail="회의 녹화 파일을 찾을 수 없습니다.")

    async def event_generator():
        queue = asyncio.Queue()

        async def callback(data: dict):
            await queue.put(data)

        async def run_worker():
            try:
                res = await execute_meeting_pipeline(
                    file_path=file_path,
                    custom_title=req.title,
                    custom_meeting_date=req.meeting_date,
                    custom_start_time=req.start_time,
                    model_name=req.model_name or "gemini-3.8-flash-medium",
                    whisper_size=req.whisper_size or "base",
                    event_callback=callback,
                )
                synced_scheds = res.get('synced_schedules', 0)
                sched_msg = f" ({synced_scheds}개 일정이 '💻 컴짱' 캘린더에 자동 등록되었습니다)" if synced_scheds > 0 else ""
                await queue.put({
                    'type': 'done',
                    'meeting_id': res['meeting_id'],
                    'title': res['title'],
                    'meeting_date': res['meeting_date'],
                    'start_time': res['start_time'],
                    'duration_sec': res['duration_sec'],
                    'action_item_count': res['action_item_count'],
                    'synced_schedules': synced_scheds,
                    'message': f'🎉 컴짱 AI 회의록 분석 및 저장이 완료되었습니다!{sched_msg}'
                })
            except Exception as e:
                await queue.put({
                    'type': 'error',
                    'message': f'회의록 처리 중 오류가 발생했습니다: {str(e)}'
                })
            finally:
                await queue.put(None)

        asyncio.create_task(run_worker())

        while True:
            event = await queue.get()
            if event is None:
                yield "data: [DONE]\n\n"
                break
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ─── 날짜별 자동 정리 & 일괄 등록 API (SSE 스트리밍) ────────────────────────
@router.post("/auto-process")
async def auto_process_meetings_stream(req: AutoProcessRequest):
    """
    미등록 녹화 파일들을 날짜별로 자동 분류하여 순차적으로 AI 회의록을 생성 및 캘린더에 등록
    - files: 특정 상대 경로 목록 또는 생략 시 모든 미등록 파일 자동 탐색
    """
    # 대상 파일 수집
    target_rel_paths = req.files
    if not target_rel_paths:
        unregistered = get_unregistered_recordings()
        target_rel_paths = [item["rel_path"] for item in unregistered]

    if not target_rel_paths:
        async def empty_gen():
            yield f"data: {json.dumps({'type': 'all_done', 'total_processed': 0, 'message': '새로 등록할 회의 녹화 파일이 없습니다.'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(empty_gen(), media_type="text/event-stream")

    async def event_generator():
        total_files = len(target_rel_paths)
        yield f"data: {json.dumps({'type': 'batch_start', 'total_files': total_files, 'message': f'총 {total_files}건의 미등록 회의 파일 날짜별 자동 정리를 시작합니다.'}, ensure_ascii=False)}\n\n"

        processed_count = 0
        success_list = []

        for idx, rel_p in enumerate(target_rel_paths, start=1):
            file_path = find_download_file(rel_p)
            if not file_path:
                yield f"data: {json.dumps({'type': 'file_error', 'file_index': idx, 'total_files': total_files, 'file': rel_p, 'message': f'파일을 찾을 수 없어 건너뜁니다: {rel_p}'}, ensure_ascii=False)}\n\n"
                continue

            parsed_d, parsed_t = parse_meeting_file_datetime(file_path)
            yield f"data: {json.dumps({
                'type': 'file_start',
                'file_index': idx,
                'total_files': total_files,
                'file_name': file_path.name,
                'meeting_date': parsed_d,
                'start_time': parsed_t,
                'message': f'[{idx}/{total_files}] {parsed_d} {parsed_t} 녹화본 자동 정리 중...'
            }, ensure_ascii=False)}\n\n"

            queue = asyncio.Queue()

            async def file_callback(data: dict):
                data['file_index'] = idx
                data['total_files'] = total_files
                await queue.put(data)

            async def run_single():
                try:
                    res = await execute_meeting_pipeline(
                        file_path=file_path,
                        model_name=req.model_name or "gemini-3.8-flash-medium",
                        whisper_size=req.whisper_size or "base",
                        event_callback=file_callback,
                    )
                    await queue.put({'res': res})
                except Exception as e:
                    await queue.put({'err': str(e)})
                finally:
                    await queue.put(None)

            asyncio.create_task(run_single())

            single_res = None
            single_err = None

            while True:
                item = await queue.get()
                if item is None:
                    break
                if 'res' in item:
                    single_res = item['res']
                elif 'err' in item:
                    single_err = item['err']
                else:
                    yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

            if single_res:
                processed_count += 1
                success_list.append(single_res)
                yield f"data: {json.dumps({
                    'type': 'file_done',
                    'file_index': idx,
                    'total_files': total_files,
                    'meeting': single_res,
                    'message': f'[{idx}/{total_files}] {single_res["meeting_date"]} {single_res["title"]} 등록 완료!'
                }, ensure_ascii=False)}\n\n"
            else:
                yield f"data: {json.dumps({
                    'type': 'file_error',
                    'file_index': idx,
                    'total_files': total_files,
                    'file_name': file_path.name,
                    'message': f'[{idx}/{total_files}] 처리 실패: {single_err}'
                }, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({
            'type': 'all_done',
            'total_processed': processed_count,
            'total_files': total_files,
            'meetings': success_list,
            'message': f'🎉 총 {processed_count}건의 회의 녹화 파일이 날짜별로 완벽하게 자동 정리 및 등록되었습니다!'
        }, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


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
    conn.close()
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

    return {
        "ok": True,
        "meeting_id": meeting_id,
        "title": final_title,
        "summary": summary_text,
        "action_items": action_items,
        "tags": tags,
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
[⭐ 가장 중요한 필수 규칙: 녹음 진행 순서(시간 흐름) 엄수]
1. **회의록 요약 내용의 순서는 반드시 실제 녹음이 진행된 시간 순서(타임라인 순서)와 100% 일치해야 합니다.**
2. 시간 순서를 절대 임의로 재배치하거나 뒤섞지 마세요. 회의 시작 시점 ➔ 전개/중반부 ➔ 후반/마무리 시점의 흐름을 그대로 따라가야 합니다.
3. '주요 논의 사항'에서는 각 안건/주제 블록마다 해당 발언이 나온 **타임코드 구간(예: [00:00 ~ 05:20], [05:21 ~ 13:40])**을 제목 앞에 반드시 기재하여, 회의 음성/영상과 1:1로 정확히 동기화되도록 작성하세요.
4. '핵심 요약' 역시 회의 전반부 ➔ 중반부 ➔ 후반부의 진행 흐름 순서대로 3줄로 작성하세요.

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

## 🚀 액션 아이템 (Action Items)
- [ ] [담당자] 구체적인 할 일 내용 (기한: YYYY-MM-DD 또는 미정)

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

        action_items.append({
            "id": f"act_{uuid.uuid4().hex[:8]}",
            "task": act_text,
            "assignee": assignee,
            "due_date": due_date,
            "done": check.lower() == "x",
        })

    return summary_text, final_title, action_items, tags


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

    return {
        "meeting_id": meeting_id,
        "title": final_title,
        "meeting_date": meeting_date,
        "start_time": start_time,
        "duration_sec": duration_sec,
        "action_item_count": len(action_items),
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
                await queue.put({
                    'type': 'done',
                    'meeting_id': res['meeting_id'],
                    'title': res['title'],
                    'meeting_date': res['meeting_date'],
                    'start_time': res['start_time'],
                    'duration_sec': res['duration_sec'],
                    'action_item_count': res['action_item_count'],
                    'message': '🎉 컴짱회의 AI 회의록 분석 및 저장이 완료되었습니다!'
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


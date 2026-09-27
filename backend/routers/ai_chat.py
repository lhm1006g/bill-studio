"""
Phase 7 - AI 어시스턴트 채팅 라우터
agy CLI (Gemini 3.8 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6) + Ollama 하이브리드 연동
실시간 SSE 스트리밍 + 대화 세션 및 히스토리 영구 저장 (SQLite)
"""
import asyncio
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/api/ai", tags=["ai_chat"])

# DB 경로 및 agy 경로
DB_PATH = Path(__file__).resolve().parent.parent / "studio.db"
AGY_BIN = "/Users/bill/.local/bin/agy"

# 기본 지원 모델 목록
AVAILABLE_MODELS = [
    {
        "id": "gemini-3.8-flash-medium",
        "name": "Gemini 3.8 Flash (추천)",
        "provider": "agy",
        "badge": "⚡ 초고속·고지능",
        "description": "최신 Gemini 3.8 Flash 모델, 자연스러운 한국어와 뛰어난 기획력",
    },
    {
        "id": "gemini-3.1-pro-high",
        "name": "Gemini 3.1 Pro",
        "provider": "agy",
        "badge": "🧠 심층 추론",
        "description": "복잡한 분석, 기획, 긴 글 분석에 최적화된 고성능 Pro 모델",
    },
    {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6 (Thinking)",
        "provider": "agy",
        "badge": "🎨 스토리텔링",
        "description": "Anthropic의 대표 모델, 섬세한 문장력과 감각적인 대본 작성",
    },
    {
        "id": "ollama:gemma3:12b",
        "name": "Gemma 3 (12B 로컬)",
        "provider": "ollama",
        "badge": "🔒 100% 오프라인",
        "description": "맥미니 온디바이스에서 100% 로컬로 구동되는 오프라인 모델",
    },
]

# 시스템 프롬프트 프리셋
SYSTEM_PRESETS = {
    "general": (
        "당신은 'Bill Studio'의 전문 올인원 AI 어시스턴트입니다. "
        "사용자(Bill)의 작업을 친절하고 명확하며 스마트하게 도와줍니다. "
        "한국어로 자연스럽고 가독성 좋게(마크다운, 목록, 강조 등 활용) 답변해주세요."
    ),
    "youtube_plan": (
        "당신은 유튜브 100만 구독자 채널을 컨설팅하는 최고의 '유튜브 콘텐츠 기획 전문가'입니다. "
        "시청자의 시선을 0.5초 만에 사로잡는 강력한 후킹 썸네일 카피, 클릭률(CTR)을 높이는 제목 5가지, "
        "시청 지속시간을 극대화하는 영상 구조(기-승-전-결)를 구체적으로 제안해주세요."
    ),
    "script_writer": (
        "당신은 유튜브 쇼츠(Shorts) 및 영상 킬러 대본을 전문으로 쓰는 '스타 방송 작가'입니다. "
        "초반 3초 안에 시청자를 붙잡는 충격적인 훅(Hook), 지루할 틈 없는 빠른 전개, "
        "자연스러운 구어체 대본을 타임코드(0~5초, 5~15초 등)와 함께 작성해주세요."
    ),
    "news_analyst": (
        "당신은 반도체, AI, 빅테크, 경제 및 주식 시장을 정밀 분석하는 '수석 리서치 애널리스트'입니다. "
        "최신 뉴스 및 관심 기업(삼성전자, SK하이닉스, 네이버, NVIDIA, TSMC, 테슬라 등)의 핵심 이슈와 시사점, "
        "투자 및 사업 관점에서의 기회와 리스크를 명쾌하게 분석해주세요."
    ),
}


# ─── DB 초기화 ────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # 대화 세션 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT 'gemini-3.8-flash-medium',
            preset TEXT NOT NULL DEFAULT 'general',
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    """)

    # 대화 메시지 테이블
    c.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
        )
    """)

    conn.commit()
    conn.close()


init_db()


# ─── 모델 & 프리셋 API ─────────────────────────────────────────────────
@router.get("/models")
def get_models():
    """사용 가능한 AI 모델 목록 반환"""
    return AVAILABLE_MODELS


@router.get("/presets")
def get_presets():
    """시스템 프롬프트 프리셋 목록 반환"""
    return [
        {"id": "general", "name": "💡 올인원 스튜디오 비서", "desc": "자유로운 대화, 아이디어 회의, 코드/문서 작성"},
        {"id": "youtube_plan", "name": "🎬 유튜브 콘텐츠 기획", "desc": "클릭률 높은 제목, 썸네일 카피, 영상 구성 기획"},
        {"id": "script_writer", "name": "✍️ 쇼츠 & 영상 대본 작가", "desc": "초반 3초 후킹, 몰입도 높은 타임코드 대본 작성"},
        {"id": "news_analyst", "name": "📈 경제 & 테크 뉴스 분석", "desc": "반도체, 빅테크, 관심종목 심층 분석 및 인사이트"},
    ]


# ─── 세션 관리 API ────────────────────────────────────────────────────
class SessionCreate(BaseModel):
    title: Optional[str] = "새로운 대화"
    model: Optional[str] = "gemini-3.8-flash-medium"
    preset: Optional[str] = "general"


@router.get("/sessions")
def get_sessions():
    """모든 대화 세션 목록 (최신순)"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT s.*, 
               (SELECT COUNT(*) FROM chat_messages WHERE session_id = s.id) as message_count,
               (SELECT content FROM chat_messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message
        FROM chat_sessions s
        ORDER BY s.updated_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/sessions")
def create_session(body: SessionCreate):
    session_id = str(uuid.uuid4())
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        INSERT INTO chat_sessions (id, title, model, preset)
        VALUES (?, ?, ?, ?)
    """, (session_id, body.title, body.model, body.preset))
    conn.commit()
    conn.close()
    return {"id": session_id, "title": body.title, "model": body.model, "preset": body.preset}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.patch("/sessions/{session_id}")
def update_session(session_id: str, title: Optional[str] = None, model: Optional[str] = None, preset: Optional[str] = None):
    conn = sqlite3.connect(DB_PATH)
    if title:
        conn.execute("UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?", (title, session_id))
    if model:
        conn.execute("UPDATE chat_sessions SET model = ?, updated_at = datetime('now') WHERE id = ?", (model, session_id))
    if preset:
        conn.execute("UPDATE chat_sessions SET preset = ?, updated_at = datetime('now') WHERE id = ?", (preset, session_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.get("/sessions/{session_id}/messages")
def get_session_messages(session_id: str):
    """세션의 모든 메시지 히스토리"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT * FROM chat_messages
        WHERE session_id = ?
        ORDER BY created_at ASC
    """, (session_id,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── 실시간 스트리밍 채팅 API ─────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    model: Optional[str] = None
    preset: Optional[str] = None


@router.post("/sessions/{session_id}/chat")
async def chat_stream(session_id: str, body: ChatRequest):
    """실시간 SSE 스트리밍 채팅 (agy CLI 또는 Ollama)"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    session_row = conn.execute("SELECT * FROM chat_sessions WHERE id = ?", (session_id,)).fetchone()
    
    if not session_row:
        conn.close()
        raise HTTPException(status_code=404, detail="대화 세션을 찾을 수 없습니다.")

    session = dict(session_row)
    model = body.model or session.get("model") or "gemini-3.8-flash-medium"
    preset_key = body.preset or session.get("preset") or "general"
    system_prompt = SYSTEM_PRESETS.get(preset_key, SYSTEM_PRESETS["general"])

    # 1. 사용자 메시지 DB 저장
    user_msg_id = str(uuid.uuid4())
    conn.execute("""
        INSERT INTO chat_messages (id, session_id, role, content)
        VALUES (?, ?, 'user', ?)
    """, (user_msg_id, session_id, body.message))
    
    # 세션 제목이 기본값인 경우, 첫 질문으로 제목 자동 업데이트
    if session["title"] == "새로운 대화":
        new_title = body.message[:25].strip()
        if len(body.message) > 25:
            new_title += "..."
        conn.execute("UPDATE chat_sessions SET title = ? WHERE id = ?", (new_title, session_id))

    # 최근 대화 히스토리 가져오기 (최근 6개 메시지)
    history_rows = conn.execute("""
        SELECT role, content FROM chat_messages
        WHERE session_id = ? AND id != ?
        ORDER BY created_at DESC LIMIT 6
    """, (session_id, user_msg_id)).fetchall()
    conn.commit()
    conn.close()

    history = [dict(r) for r in reversed(history_rows)]

    # 2. 전체 프롬프트 구성 (시스템 프롬프트 + 히스토리 + 현재 질문)
    full_prompt_lines = [f"[시스템 지침]\n{system_prompt}\n"]
    if history:
        full_prompt_lines.append("[이전 대화 기록]")
        for h in history:
            role_name = "사용자" if h["role"] == "user" else "AI 어시스턴트"
            full_prompt_lines.append(f"{role_name}: {h['content']}")
        full_prompt_lines.append("")
    full_prompt_lines.append(f"[현재 사용자 질문]\n{body.message}")
    
    full_prompt = "\n".join(full_prompt_lines)

    # 3. 모델별 스트리밍 제너레이터 실행
    async def generate_response():
        full_ai_response = ""
        assistant_msg_id = str(uuid.uuid4())

        # ── A. Ollama 로컬 모델인 경우 ─────────────────────────
        if model.startswith("ollama:"):
            ollama_model = model.replace("ollama:", "")
            try:
                async with httpx.AsyncClient(timeout=90.0) as client:
                    async with client.stream(
                        "POST",
                        "http://localhost:11434/api/generate",
                        json={
                            "model": ollama_model,
                            "prompt": full_prompt,
                            "stream": True,
                        },
                    ) as resp:
                        async for line in resp.aiter_lines():
                            if not line:
                                continue
                            try:
                                d = json.loads(line)
                                token = d.get("response", "")
                                full_ai_response += token
                                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
                                if d.get("done"):
                                    break
                            except json.JSONDecodeError:
                                continue
            except Exception as e:
                err_msg = f"\n[오류] Ollama 연결 실패: {str(e)}"
                full_ai_response += err_msg
                yield f"data: {json.dumps({'type': 'token', 'text': err_msg})}\n\n"

        # ── B. agy CLI 모델인 경우 (Gemini 3.8 Flash, Pro, Claude 등) ──
        else:
            try:
                cmd = [
                    AGY_BIN,
                    "-p", full_prompt,
                    "--model", model,
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
                        event = data.get("event")
                        
                        # step_update 이벤트에서 text_delta 추출
                        if event == "step_update":
                            step_data = data.get("step_update", {})
                            delta = step_data.get("text_delta", "")
                            if delta:
                                full_ai_response += delta
                                yield f"data: {json.dumps({'type': 'token', 'text': delta})}\n\n"

                        elif event == "result":
                            res_data = data.get("result", {})
                            # 만약 누적된 delta가 없고 result에 response가 있다면 보충
                            if not full_ai_response and res_data.get("response"):
                                final_resp = res_data.get("response", "")
                                full_ai_response = final_resp
                                yield f"data: {json.dumps({'type': 'token', 'text': final_resp})}\n\n"

                    except json.JSONDecodeError:
                        continue

                await proc.wait()

            except Exception as e:
                err_msg = f"\n[오류] agy CLI 실행 실패: {str(e)}"
                full_ai_response += err_msg
                yield f"data: {json.dumps({'type': 'token', 'text': err_msg})}\n\n"

        # 4. 최종 AI 답변 DB 저장 & 세션 갱신
        conn2 = sqlite3.connect(DB_PATH)
        conn2.execute("""
            INSERT INTO chat_messages (id, session_id, role, content)
            VALUES (?, ?, 'assistant', ?)
        """, (assistant_msg_id, session_id, full_ai_response or "(응답 없음)"))
        conn2.execute("""
            UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?
        """, (session_id,))
        conn2.commit()
        conn2.close()

        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id, 'full_text': full_ai_response})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate_response(), media_type="text/event-stream")

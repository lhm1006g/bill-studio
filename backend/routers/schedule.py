import os
import json
import threading
import subprocess
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from models.database import get_db
from models.schedule_model import ScheduleEvent

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

router = APIRouter(prefix="/api/schedule", tags=["Schedule"])

BASE_DIR = Path(__file__).resolve().parent.parent
CREDENTIALS_FILE = BASE_DIR / "credentials.json"
TOKEN_FILE = BASE_DIR / "token.json"

SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
]

OAUTH_PORT = 8089
REDIRECT_URI = f"http://localhost:{OAUTH_PORT}/"

auth_lock = threading.Lock()
auth_in_progress = False
current_auth_url = None
auth_last_error = None
active_oauth_server = None


def get_credentials() -> Optional[Credentials]:
    """저장된 token.json에서 유효한 자격증명을 불러오거나 갱신합니다."""
    creds = None
    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        except Exception as e:
            print(f"[Google Auth] 토큰 로드 실패: {e}")
            return None

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            with open(TOKEN_FILE, "w") as token:
                token.write(creds.to_json())
            print("[Google Auth] 토큰 자동 갱신 완료")
        except Exception as e:
            print(f"[Google Auth] 토큰 갱신 실패: {e}")
            return None

    if creds and creds.valid:
        return creds
    return None


def get_calendar_service():
    """Google Calendar API 서비스 객체 생성 (없으면 None)"""
    creds = get_credentials()
    if not creds:
        return None
    try:
        return build("calendar", "v3", credentials=creds)
    except Exception as e:
        print(f"[Google Auth] 빌드 실패: {e}")
        return None


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    flow_instance = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        global auth_in_progress, auth_last_error, current_auth_url
        query_components = parse_qs(urlparse(self.path).query)
        code = query_components.get("code", [None])[0]
        error = query_components.get("error", [None])[0]

        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.end_headers()

        if code and self.flow_instance:
            try:
                self.flow_instance.fetch_token(code=code)
                creds = self.flow_instance.credentials
                with open(TOKEN_FILE, "w") as token:
                    token.write(creds.to_json())
                auth_last_error = None
                print("[Google Auth] OAuth 토큰 획득 및 token.json 저장 성공!")

                html = """
                <html>
                <head>
                    <title>Bill Studio - 구글 캘린더 연동 성공</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: white; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                        .card { background: #1e293b; padding: 40px 50px; border-radius: 20px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); }
                        h1 { color: #10b981; font-size: 26px; margin-bottom: 12px; }
                        p { color: #94a3b8; font-size: 16px; margin-bottom: 24px; }
                        button { background: #6366f1; color: white; border: none; padding: 12px 24px; border-radius: 10px; font-size: 15px; font-weight: bold; cursor: pointer; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>🎉 구글 캘린더 연동 완료!</h1>
                        <p>Bill Studio와 스마트폰 구글 캘린더가 성공적으로 연결되었습니다.<br>이 창을 닫고 Bill Studio로 돌아가세요.</p>
                        <button onclick="window.close()">창 닫기</button>
                    </div>
                    <script>
                        setTimeout(() => { window.close(); }, 3000);
                    </script>
                </body>
                </html>
                """
                self.wfile.write(html.encode("utf-8"))
            except Exception as e:
                auth_last_error = f"토큰 교환 실패: {e}"
                print(f"[Google Auth] 토큰 교환 실패: {e}")
                self.wfile.write(f"<h1>인증 오류 발생: {e}</h1>".encode("utf-8"))
        else:
            auth_last_error = error or "인증 코드가 전달되지 않았습니다."
            self.wfile.write(f"<h1>인증 실패: {auth_last_error}</h1>".encode("utf-8"))

        with auth_lock:
            auth_in_progress = False
            current_auth_url = None

        threading.Thread(target=self.server.shutdown, daemon=True).start()


def start_oauth_flow():
    global auth_in_progress, auth_last_error, current_auth_url, active_oauth_server

    if not CREDENTIALS_FILE.exists():
        auth_last_error = "credentials.json 파일이 존재하지 않습니다."
        return None

    try:
        flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
        flow.redirect_uri = REDIRECT_URI
        auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
        current_auth_url = auth_url

        OAuthCallbackHandler.flow_instance = flow

        if active_oauth_server:
            try:
                active_oauth_server.shutdown()
            except Exception:
                pass

        server = HTTPServer(("localhost", OAUTH_PORT), OAuthCallbackHandler)
        active_oauth_server = server

        def serve():
            server.serve_forever()

        t = threading.Thread(target=serve, daemon=True)
        t.start()

        try:
            subprocess.Popen(["open", auth_url])
        except Exception as e:
            print(f"[Google Auth] open 명령 실패: {e}")

        return auth_url
    except Exception as e:
        auth_last_error = str(e)
        print(f"[Google Auth] OAuth 플로우 시작 에러: {e}")
        return None


# ==========================================
# Pydantic Schemas
# ==========================================

class EventCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    start_time: str
    end_time: str
    all_day: bool = False
    is_routine: bool = False  # 매일 자전거 타기 등 일상 루틴 여부
    calendar_id: Optional[str] = "primary"
    color_id: Optional[str] = "9"
    location: Optional[str] = ""


class EventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    all_day: Optional[bool] = None
    is_routine: Optional[bool] = None
    calendar_id: Optional[str] = None
    color_id: Optional[str] = None
    location: Optional[str] = None


# ==========================================
# 인증 및 캘린더 목록 API
# ==========================================

@router.get("/auth/status")
def get_auth_status():
    global auth_in_progress, auth_last_error, current_auth_url
    has_credentials = CREDENTIALS_FILE.exists()
    creds = get_credentials()
    
    account_email = None
    if creds:
        try:
            service = build("calendar", "v3", credentials=creds)
            cal = service.calendars().get(calendarId="primary").execute()
            account_email = cal.get("id") or cal.get("summary")
        except Exception as e:
            print(f"[Google Auth] 계정 조회 에러: {e}")

    return {
        "has_credentials": has_credentials,
        "is_authenticated": creds is not None,
        "account_email": account_email,
        "auth_in_progress": auth_in_progress,
        "auth_url": current_auth_url,
        "error": auth_last_error,
    }


@router.post("/auth/start")
def start_auth():
    global auth_in_progress, auth_last_error, current_auth_url
    if not CREDENTIALS_FILE.exists():
        raise HTTPException(status_code=400, detail="credentials.json 파일이 없습니다.")

    with auth_lock:
        auth_in_progress = True
        auth_last_error = None

    url = start_oauth_flow()
    if not url:
        with auth_lock:
            auth_in_progress = False
        raise HTTPException(status_code=500, detail=auth_last_error or "OAuth 인증 시작 실패")

    return {
        "message": "인증 창이 브라우저에서 열립니다.",
        "auth_url": url
    }


@router.post("/auth/logout")
def logout():
    if TOKEN_FILE.exists():
        try:
            TOKEN_FILE.unlink()
            return {"message": "구글 계정 연동이 해제되었습니다."}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"토큰 삭제 실패: {e}")
    return {"message": "연동된 계정이 없습니다."}


@router.get("/calendars")
def get_calendars():
    """사용자의 캘린더 목록 (기본 캘린더, 일상 루틴 캘린더 등)"""
    service = get_calendar_service()
    if not service:
        return [
            {"id": "primary", "summary": "📌 스튜디오 주요 일정", "primary": True, "is_routine": False},
            {"id": "routine", "summary": "🚲 일상 루틴 (자전거 등)", "primary": False, "is_routine": True}
        ]

    try:
        cal_list = service.calendarList().list().execute()
        items = []
        for item in cal_list.get("items", []):
            summary = item.get("summary", "")
            is_routine = any(kw in summary.lower() for kw in ["루틴", "routine", "자전거", "운동", "습관"])
            items.append({
                "id": item.get("id"),
                "summary": summary,
                "description": item.get("description", ""),
                "primary": item.get("primary", False),
                "backgroundColor": item.get("backgroundColor"),
                "is_routine": is_routine
            })
        return items
    except Exception as e:
        print(f"[Schedule] 캘린더 목록 조회 실패: {e}")
        return [
            {"id": "primary", "summary": "📌 스튜디오 주요 일정", "primary": True, "is_routine": False},
            {"id": "routine", "summary": "🚲 일상 루틴 (자전거 등)", "primary": False, "is_routine": True}
        ]


@router.post("/calendars/create-routine")
def create_routine_calendar():
    """구글 계정에 '🚲 일상 루틴' 전용 캘린더를 원클릭으로 생성"""
    service = get_calendar_service()
    if not service:
        raise HTTPException(status_code=401, detail="구글 연동이 필요합니다.")
    try:
        new_cal = {
            "summary": "🚲 일상 루틴",
            "description": "자전거 타기, 운동 등 매일 반복되는 개인 루틴 캘린더 (Bill Studio 연동)",
            "timeZone": "Asia/Seoul"
        }
        created = service.calendars().insert(body=new_cal).execute()
        return {"message": "구글 캘린더에 '🚲 일상 루틴' 캘린더가 생성되었습니다!", "calendar": created}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"캘린더 생성 실패: {e}")


# ==========================================
# 캘린더 일정 CRUD API
# ==========================================

ROUTINE_KEYWORDS = ["자전거", "운동", "헬스", "스트레칭", "영양제", "약 먹기", "루틴", "러닝", "조깅"]

def check_is_routine(title: str, description: str = "", calendar_name: str = "") -> bool:
    """제목, 설명, 캘린더 이름으로 루틴 여부 스마트 판별"""
    combined = f"{title} {description} {calendar_name}".lower()
    return any(kw in combined for kw in ROUTINE_KEYWORDS)


@router.get("/events")
def get_events(
    time_min: Optional[str] = Query(None, alias="timeMin"),
    time_max: Optional[str] = Query(None, alias="timeMax"),
    db: Session = Depends(get_db)
):
    now = datetime.now(timezone.utc)
    if not time_min:
        time_min = (now - timedelta(days=35)).isoformat()
    if not time_max:
        time_max = (now + timedelta(days=60)).isoformat()

    merged_events = []
    seen_google_ids = set()

    # 1. 로컬 SQLite DB 일정 로드
    local_records = db.query(ScheduleEvent).all()
    for rec in local_records:
        if rec.google_event_id:
            seen_google_ids.add(rec.google_event_id)
        
        is_routine = rec.is_routine or check_is_routine(rec.title, rec.description or "")

        merged_events.append({
            "id": f"local_{rec.id}",
            "db_id": rec.id,
            "google_event_id": rec.google_event_id,
            "calendar_id": rec.calendar_id or "primary",
            "title": rec.title,
            "description": rec.description or "",
            "start": rec.start_time,
            "end": rec.end_time,
            "all_day": rec.all_day,
            "is_routine": is_routine,
            "color_id": rec.color_id or "9",
            "location": rec.location or "",
            "source": rec.source or "local",
        })

    # 2. 구글 캘린더 서비스 조회 (연동되어 있을 시 모든 활성 캘린더에서 수집)
    service = get_calendar_service()
    if service:
        try:
            cal_list = service.calendarList().list().execute()
            calendars_to_query = cal_list.get("items", [])
            if not calendars_to_query:
                calendars_to_query = [{"id": "primary", "summary": "기본 일정"}]

            for cal in calendars_to_query:
                cal_id = cal.get("id")
                cal_summary = cal.get("summary", "")
                cal_is_routine = any(kw in cal_summary.lower() for kw in ["루틴", "routine", "자전거", "운동"])

                try:
                    events_result = service.events().list(
                        calendarId=cal_id,
                        timeMin=time_min,
                        timeMax=time_max,
                        maxResults=250,
                        singleEvents=True,
                        orderBy="startTime"
                    ).execute()

                    for item in events_result.get("items", []):
                        gid = item.get("id")
                        if gid in seen_google_ids:
                            continue

                        start = item.get("start", {})
                        end = item.get("end", {})
                        all_day = "date" in start
                        title = item.get("summary", "(제목 없음)")
                        desc = item.get("description", "")
                        
                        is_routine = cal_is_routine or check_is_routine(title, desc, cal_summary)

                        merged_events.append({
                            "id": f"google_{gid}",
                            "google_event_id": gid,
                            "calendar_id": cal_id,
                            "calendar_name": cal_summary,
                            "title": title,
                            "description": desc,
                            "start": start.get("dateTime") or start.get("date"),
                            "end": end.get("dateTime") or end.get("date"),
                            "all_day": all_day,
                            "is_routine": is_routine,
                            "color_id": item.get("colorId", "9"),
                            "location": item.get("location", ""),
                            "html_link": item.get("htmlLink"),
                            "source": "google"
                        })
                except Exception as inner_e:
                    print(f"[Schedule] 캘린더 {cal_summary} 이벤트 조회 스킵: {inner_e}")

        except Exception as e:
            print(f"[Schedule] 구글 캘린더 목록 동기화 에러: {e}")

    return {
        "time_zone": "Asia/Seoul",
        "events": merged_events
    }


@router.post("/events")
def create_event(event_data: EventCreate, db: Session = Depends(get_db)):
    google_event_id = None
    service = get_calendar_service()
    cal_id = event_data.calendar_id or "primary"

    # 스마트 루틴 판별
    is_routine = event_data.is_routine or check_is_routine(event_data.title, event_data.description or "")

    if service:
        try:
            body: Dict[str, Any] = {
                "summary": event_data.title,
                "description": event_data.description or "",
            }
            if event_data.location:
                body["location"] = event_data.location
            if event_data.color_id:
                body["colorId"] = str(event_data.color_id)

            if event_data.all_day:
                body["start"] = {"date": event_data.start_time[:10]}
                body["end"] = {"date": event_data.end_time[:10]}
            else:
                body["start"] = {"dateTime": event_data.start_time, "timeZone": "Asia/Seoul"}
                body["end"] = {"dateTime": event_data.end_time, "timeZone": "Asia/Seoul"}

            created_google = service.events().insert(calendarId=cal_id, body=body).execute()
            google_event_id = created_google.get("id")
        except Exception as e:
            print(f"[Schedule] 구글 캘린더 생성 실패: {e}")

    new_event = ScheduleEvent(
        google_event_id=google_event_id,
        calendar_id=cal_id,
        title=event_data.title,
        description=event_data.description or "",
        start_time=event_data.start_time,
        end_time=event_data.end_time,
        all_day=event_data.all_day,
        is_routine=is_routine,
        color_id=event_data.color_id or "9",
        location=event_data.location or "",
        source="google" if google_event_id else "local"
    )
    db.add(new_event)
    db.commit()
    db.refresh(new_event)

    msg = "일정이 구글 캘린더와 스튜디오에 동기화되었습니다! 📱" if google_event_id else "일정이 스튜디오 캘린더에 성공적으로 저장되었습니다."

    return {
        "message": msg,
        "event": {
            "id": f"local_{new_event.id}",
            "db_id": new_event.id,
            "google_event_id": google_event_id,
            "calendar_id": new_event.calendar_id,
            "title": new_event.title,
            "start": new_event.start_time,
            "end": new_event.end_time,
            "all_day": new_event.all_day,
            "is_routine": new_event.is_routine,
            "source": new_event.source
        }
    }


@router.put("/events/{event_id}")
def update_event(event_id: str, event_data: EventUpdate, db: Session = Depends(get_db)):
    service = get_calendar_service()
    
    if event_id.startswith("local_"):
        db_id = int(event_id.replace("local_", ""))
        rec = db.query(ScheduleEvent).filter(ScheduleEvent.id == db_id).first()
        if not rec:
            raise HTTPException(status_code=404, detail="일정을 찾을 수 없습니다.")

        if event_data.title is not None: rec.title = event_data.title
        if event_data.description is not None: rec.description = event_data.description
        if event_data.start_time is not None: rec.start_time = event_data.start_time
        if event_data.end_time is not None: rec.end_time = event_data.end_time
        if event_data.all_day is not None: rec.all_day = event_data.all_day
        if event_data.is_routine is not None: rec.is_routine = event_data.is_routine
        if event_data.color_id is not None: rec.color_id = event_data.color_id
        if event_data.location is not None: rec.location = event_data.location
        db.commit()

        if rec.google_event_id and service:
            try:
                g_body = {
                    "summary": rec.title,
                    "description": rec.description,
                    "colorId": rec.color_id,
                    "location": rec.location
                }
                if rec.all_day:
                    g_body["start"] = {"date": rec.start_time[:10]}
                    g_body["end"] = {"date": rec.end_time[:10]}
                else:
                    g_body["start"] = {"dateTime": rec.start_time, "timeZone": "Asia/Seoul"}
                    g_body["end"] = {"dateTime": rec.end_time, "timeZone": "Asia/Seoul"}
                cal_id = rec.calendar_id or "primary"
                service.events().patch(calendarId=cal_id, eventId=rec.google_event_id, body=g_body).execute()
            except Exception as e:
                print(f"[Schedule] 구글 수정 실패: {e}")

        return {"message": "일정이 수정되었습니다."}

    elif event_id.startswith("google_"):
        gid = event_id.replace("google_", "")
        if not service:
            raise HTTPException(status_code=401, detail="구글 연동이 필요합니다.")
        try:
            g_body = {}
            if event_data.title is not None: g_body["summary"] = event_data.title
            if event_data.description is not None: g_body["description"] = event_data.description
            if event_data.color_id is not None: g_body["colorId"] = event_data.color_id
            if event_data.location is not None: g_body["location"] = event_data.location
            if event_data.start_time or event_data.end_time:
                all_day = event_data.all_day if event_data.all_day is not None else False
                if all_day:
                    if event_data.start_time: g_body["start"] = {"date": event_data.start_time[:10]}
                    if event_data.end_time: g_body["end"] = {"date": event_data.end_time[:10]}
                else:
                    if event_data.start_time: g_body["start"] = {"dateTime": event_data.start_time, "timeZone": "Asia/Seoul"}
                    if event_data.end_time: g_body["end"] = {"dateTime": event_data.end_time, "timeZone": "Asia/Seoul"}
            cal_id = event_data.calendar_id or "primary"
            service.events().patch(calendarId=cal_id, eventId=gid, body=g_body).execute()
            return {"message": "구글 캘린더 일정이 수정되었습니다."}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"수정 실패: {e}")

    raise HTTPException(status_code=400, detail="유효하지 않은 일정 ID입니다.")


@router.delete("/events/{event_id}")
def delete_event(event_id: str, db: Session = Depends(get_db)):
    service = get_calendar_service()

    if event_id.startswith("local_"):
        db_id = int(event_id.replace("local_", ""))
        rec = db.query(ScheduleEvent).filter(ScheduleEvent.id == db_id).first()
        if rec:
            if rec.google_event_id and service:
                try:
                    cal_id = rec.calendar_id or "primary"
                    service.events().delete(calendarId=cal_id, eventId=rec.google_event_id).execute()
                except Exception as e:
                    print(f"[Schedule] 구글 캘린더 삭제 에러: {e}")
            db.delete(rec)
            db.commit()
            return {"message": "일정이 삭제되었습니다."}

    elif event_id.startswith("google_"):
        gid = event_id.replace("google_", "")
        if service:
            try:
                service.events().delete(calendarId="primary", eventId=gid).execute()
                return {"message": "구글 캘린더 일정이 삭제되었습니다."}
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"삭제 실패: {e}")

    raise HTTPException(status_code=404, detail="삭제할 일정을 찾지 못했습니다.")

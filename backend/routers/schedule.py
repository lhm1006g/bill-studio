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
    is_comjjang: bool = False  # 컴짱 회의 업무/마감 일정 여부
    meeting_id: Optional[str] = None  # 연결된 컴짱 회의 ID
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
    is_comjjang: Optional[bool] = None
    meeting_id: Optional[str] = None
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
            is_comjjang = any(kw in summary.lower() for kw in ["컴짱", "comjjang"])
            items.append({
                "id": item.get("id"),
                "summary": summary,
                "description": item.get("description", ""),
                "primary": item.get("primary", False),
                "backgroundColor": item.get("backgroundColor"),
                "is_routine": is_routine,
                "is_comjjang": is_comjjang,
            })
        return items
    except Exception as e:
        print(f"[Schedule] 캘린더 목록 조회 실패: {e}")
        return [
            {"id": "primary", "summary": "📌 스튜디오 주요 일정", "primary": True, "is_routine": False, "is_comjjang": False},
            {"id": "comjjang", "summary": "💻 컴짱 회의 일정", "primary": False, "is_routine": False, "is_comjjang": True},
            {"id": "routine", "summary": "🚲 일상 루틴 (자전거 등)", "primary": False, "is_routine": True, "is_comjjang": False}
        ]


def get_or_create_comjjang_calendar(service=None) -> str:
    """구글 캘린더에서 '💻 컴짱 회의' 전용 캘린더를 찾거나 없으면 자동 생성하여 ID 반환"""
    if not service:
        service = get_calendar_service()
    if not service:
        return "comjjang"
    try:
        cal_list = service.calendarList().list().execute()
        for cal in cal_list.get("items", []):
            summary = cal.get("summary", "")
            if "컴짱" in summary or "comjjang" in summary.lower():
                return cal.get("id")
        # 없으면 새로 생성
        new_cal = {
            "summary": "💻 컴짱 회의",
            "description": "컴짱 회의록에서 자동 추출된 업무 및 일정 (Bill Studio 연동)",
            "timeZone": "Asia/Seoul"
        }
        created = service.calendars().insert(body=new_cal).execute()
        return created.get("id")
    except Exception as e:
        print(f"[Schedule] 컴짱 캘린더 생성/조회 실패: {e}")
        return "comjjang"


@router.post("/calendars/create-comjjang")
def create_comjjang_calendar_api():
    """구글 계정에 '💻 컴짱 회의' 전용 캘린더를 원클릭으로 생성"""
    service = get_calendar_service()
    if not service:
        raise HTTPException(status_code=401, detail="구글 연동이 필요합니다.")
    try:
        cal_id = get_or_create_comjjang_calendar(service)
        return {"message": "구글 캘린더에 '💻 컴짱 회의' 캘린더가 준비되었습니다!", "calendar_id": cal_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"캘린더 생성 실패: {e}")


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
COMJJANG_KEYWORDS = ["컴짱", "comjjang", "회의록 연동", "컴짱회의"]
HOLIDAY_KEYWORDS = ["공휴일", "대체공휴일", "국경일", "연휴", "기념일", "추석", "설날", "삼일절", "어린이날", "부처님오신날", "현충일", "광복절", "개천절", "한글날", "성탄절", "크리스마스", "신정"]

KOREAN_FIXED_HOLIDAYS = [
    ("01-01", "신정"),
    ("03-01", "3·1절"),
    ("05-05", "어린이날"),
    ("06-06", "현충일"),
    ("08-15", "광복절"),
    ("10-03", "개천절"),
    ("10-09", "한글날"),
    ("12-25", "성탄절"),
]

# 2025~2027 주요 음력 공휴일 (설날 연휴, 부처님오신날, 추석 연휴 및 대체휴일)
LUNAR_HOLIDAYS_MAP = {
    2025: [
        ("2025-01-27", "설날 전날 (연휴)"),
        ("2025-01-28", "설날"),
        ("2025-01-29", "설날 다음날 (연휴)"),
        ("2025-01-30", "설날 대체공휴일"),
        ("2025-05-05", "부처님오신날 / 어린이날"),
        ("2025-05-06", "대체공휴일"),
        ("2025-10-05", "추석 전날 (연휴)"),
        ("2025-10-06", "추석"),
        ("2025-10-07", "추석 다음날 (연휴)"),
        ("2025-10-08", "대체공휴일"),
    ],
    2026: [
        ("2026-02-16", "설날 전날 (연휴)"),
        ("2026-02-17", "설날"),
        ("2026-02-18", "설날 다음날 (연휴)"),
        ("2026-05-24", "부처님오신날"),
        ("2026-05-25", "부처님오신날 대체공휴일"),
        ("2026-09-24", "추석 전날 (연휴)"),
        ("2026-09-25", "추석"),
        ("2026-09-26", "추석 다음날 (연휴)"),
        ("2026-10-05", "개천절 대체공휴일"),
    ],
    2027: [
        ("2027-02-06", "설날 전날 (연휴)"),
        ("2027-02-07", "설날"),
        ("2027-02-08", "설날 다음날 (연휴)"),
        ("2027-02-09", "설날 대체공휴일"),
        ("2027-05-13", "부처님오신날"),
        ("2027-09-14", "추석 전날 (연휴)"),
        ("2027-09-15", "추석"),
        ("2027-09-16", "추석 다음날 (연휴)"),
    ]
}

NON_HOLIDAYS = ["식목일", "어버이날", "스승의날", "국군의 날", "국군의날", "제헌절", "크리스마스 이브", "섣달 그믐날"]

def check_is_routine(title: str, description: str = "", calendar_name: str = "") -> bool:
    """제목, 설명, 캘린더 이름으로 루틴 여부 스마트 판별"""
    combined = f"{title} {description} {calendar_name}".lower()
    return any(kw in combined for kw in ROUTINE_KEYWORDS)


def check_is_comjjang(title: str, description: str = "", calendar_name: str = "") -> bool:
    """제목, 설명, 캘린더 이름으로 컴짱 회의 일정 여부 스마트 판별"""
    combined = f"{title} {description} {calendar_name}".lower()
    return any(kw in combined for kw in COMJJANG_KEYWORDS)


def check_is_holiday(title: str, description: str = "", calendar_name: str = "") -> bool:
    """제목, 설명, 캘린더 이름으로 법정 공휴일/휴무일 여부 판별 (쉬지 않는 기념일 제외)"""
    desc_str = (description or "").strip()
    # 구글 캘린더 설명이 '기념일'로 시작하는 경우 공휴일(휴무일)이 아님
    if desc_str.startswith("기념일"):
        return False

    # 쉬지 않는 일반 기념일 제외
    if any(nh in title for nh in NON_HOLIDAYS):
        return False

    combined = f"{title} {description} {calendar_name}".lower()
    return any(kw in combined for kw in HOLIDAY_KEYWORDS)


def get_korean_holidays_for_range(start_date_str: str, end_date_str: str) -> List[Dict[str, Any]]:
    """지정 기간 내 대한민국 법정 공휴일 목록 생성"""
    holidays = []
    try:
        start_year = int(start_date_str[:4])
        end_year = int(end_date_str[:4])
        s_date = start_date_str[:10]
        e_date = end_date_str[:10]

        for y in range(start_year, end_year + 1):
            # 양력 고정 공휴일
            for mm_dd, name in KOREAN_FIXED_HOLIDAYS:
                d_str = f"{y}-{mm_dd}"
                if s_date <= d_str <= e_date:
                    holidays.append({
                        "id": f"holiday_{y}_{mm_dd.replace('-', '')}",
                        "calendar_id": "korean_holiday",
                        "calendar_name": "대한민국의 휴일",
                        "title": name,
                        "description": "대한민국 법정 공휴일",
                        "start": d_str,
                        "end": d_str,
                        "all_day": True,
                        "is_routine": False,
                        "is_comjjang": False,
                        "is_holiday": True,
                        "color_id": "11",
                        "location": "",
                        "source": "holiday"
                    })
            # 음력 및 대체 공휴일
            if y in LUNAR_HOLIDAYS_MAP:
                for d_str, name in LUNAR_HOLIDAYS_MAP[y]:
                    if s_date <= d_str <= e_date:
                        holidays.append({
                            "id": f"holiday_{d_str.replace('-', '')}",
                            "calendar_id": "korean_holiday",
                            "calendar_name": "대한민국의 휴일",
                            "title": name,
                            "description": "대한민국 법정 공휴일",
                            "start": d_str,
                            "end": d_str,
                            "all_day": True,
                            "is_routine": False,
                            "is_comjjang": False,
                            "is_holiday": True,
                            "color_id": "11",
                            "location": "",
                            "source": "holiday"
                        })
    except Exception as e:
        print(f"[Holiday] 공휴일 생성 에러: {e}")
    return holidays


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
    seen_holiday_dates = set()

    # 1. 로컬 SQLite DB 일정 로드
    local_records = db.query(ScheduleEvent).all()
    for rec in local_records:
        if rec.google_event_id:
            seen_google_ids.add(rec.google_event_id)
        
        is_routine = rec.is_routine or check_is_routine(rec.title, rec.description or "")
        is_comjjang = rec.is_comjjang or check_is_comjjang(rec.title, rec.description or "", rec.calendar_id or "")
        is_holiday = check_is_holiday(rec.title, rec.description or "", rec.calendar_id or "")

        if is_holiday and rec.start_time:
            seen_holiday_dates.add(rec.start_time[:10])

        merged_events.append({
            "id": f"local_{rec.id}",
            "db_id": rec.id,
            "google_event_id": rec.google_event_id,
            "calendar_id": rec.calendar_id or ("comjjang" if is_comjjang else "primary"),
            "title": rec.title,
            "description": rec.description or "",
            "start": rec.start_time,
            "end": rec.end_time,
            "all_day": rec.all_day,
            "is_routine": is_routine,
            "is_comjjang": is_comjjang,
            "is_holiday": is_holiday,
            "meeting_id": rec.meeting_id,
            "color_id": "11" if is_holiday else (rec.color_id or ("7" if is_comjjang else "9")),
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
                cal_is_comjjang = any(kw in cal_summary.lower() for kw in ["컴짱", "comjjang"])
                cal_is_holiday = ("holiday" in str(cal_id).lower() or "휴일" in cal_summary or "공휴일" in cal_summary)

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
                        start = item.get("start", {})
                        end = item.get("end", {})
                        all_day = "date" in start
                        title = item.get("summary", "(제목 없음)")
                        desc = item.get("description", "")

                        start_raw = start.get("dateTime") or start.get("date")
                        end_raw = end.get("dateTime") or end.get("date")

                        # 구글 캘린더 종일(all_day) 일정 정규화
                        if all_day and start.get("date") and end.get("date"):
                            try:
                                s_date = datetime.strptime(start.get("date"), "%Y-%m-%d").date()
                                e_date = datetime.strptime(end.get("date"), "%Y-%m-%d").date()
                                if e_date > s_date:
                                    inclusive_end = e_date - timedelta(days=1)
                                    end_raw = inclusive_end.isoformat()
                                else:
                                    end_raw = start.get("date")
                            except Exception:
                                end_raw = start.get("date")

                        # 로컬 DB에 이미 등록된 구글 이벤트라면, 구글 캘린더의 최신 정보로 로컬 DB 및 목록 갱신
                        if gid in seen_google_ids:
                            for me in merged_events:
                                if me.get("google_event_id") == gid:
                                    me["title"] = title
                                    me["description"] = desc
                                    me["start"] = start_raw
                                    me["end"] = end_raw
                                    me["all_day"] = all_day
                                    break
                            # DB 레코드 업데이트
                            local_rec = next((r for r in local_records if r.google_event_id == gid), None)
                            if local_rec:
                                local_rec.title = title
                                local_rec.description = desc
                                local_rec.start_time = start_raw
                                local_rec.end_time = end_raw
                                local_rec.all_day = all_day
                            continue

                        is_routine = cal_is_routine or check_is_routine(title, desc, cal_summary)
                        is_comjjang = cal_is_comjjang or check_is_comjjang(title, desc, cal_summary)
                        is_holiday = (cal_is_holiday or check_is_holiday(title, desc, cal_summary)) and check_is_holiday(title, desc, cal_summary)

                        if is_holiday and start_raw:
                            try:
                                s_dt = datetime.strptime(start_raw[:10], "%Y-%m-%d").date()
                                e_dt = datetime.strptime((end_raw or start_raw)[:10], "%Y-%m-%d").date()
                                cur = s_dt
                                while cur <= e_dt:
                                    seen_holiday_dates.add(cur.isoformat())
                                    cur += timedelta(days=1)
                            except Exception:
                                seen_holiday_dates.add(start_raw[:10])

                        color_id = "11" if is_holiday else item.get("colorId", "7" if is_comjjang else "9")

                        merged_events.append({
                            "id": f"google_{gid}",
                            "google_event_id": gid,
                            "calendar_id": cal_id,
                            "calendar_name": cal_summary,
                            "title": title,
                            "description": desc,
                            "start": start_raw,
                            "end": end_raw,
                            "all_day": all_day,
                            "is_routine": is_routine,
                            "is_comjjang": is_comjjang,
                            "is_holiday": is_holiday,
                            "color_id": color_id,
                            "location": item.get("location", ""),
                            "html_link": item.get("htmlLink"),
                            "source": "google"
                        })
                except Exception as inner_e:
                    print(f"[Schedule] 캘린더 {cal_summary} 이벤트 조회 스킵: {inner_e}")

        except Exception as e:
            print(f"[Schedule] 구글 캘린더 목록 동기화 에러: {e}")
        finally:
            try:
                db.commit()
            except Exception:
                pass

    # 3. 대한민국 법정 공휴일 자동 보강 (구글 캘린더에 누락되었거나 연동되지 않은 휴일 자동 표시)
    auto_holidays = get_korean_holidays_for_range(time_min, time_max)
    for hol in auto_holidays:
        h_date = hol["start"][:10]
        if h_date not in seen_holiday_dates:
            seen_holiday_dates.add(h_date)
            merged_events.append(hol)

    return {
        "time_zone": "Asia/Seoul",
        "events": merged_events
    }


@router.post("/events")
def create_event(event_data: EventCreate, db: Session = Depends(get_db)):
    google_event_id = None
    service = get_calendar_service()
    cal_id = event_data.calendar_id or "primary"

    # 스마트 루틴 및 컴짱 판별
    is_routine = event_data.is_routine or check_is_routine(event_data.title, event_data.description or "")
    is_comjjang = event_data.is_comjjang or check_is_comjjang(event_data.title, event_data.description or "", cal_id)

    # 컴짱 일정이면 전용 캘린더 ID로 매핑
    if is_comjjang:
        if service and (cal_id == "primary" or cal_id == "comjjang"):
            cal_id = get_or_create_comjjang_calendar(service)
        elif not service:
            cal_id = "comjjang"

    if service:
        try:
            body: Dict[str, Any] = {
                "summary": event_data.title,
                "description": event_data.description or "",
            }
            if event_data.location:
                body["location"] = event_data.location
            color_id = event_data.color_id or ("7" if is_comjjang else "9")
            body["colorId"] = str(color_id)

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
        is_comjjang=is_comjjang,
        meeting_id=event_data.meeting_id,
        color_id=event_data.color_id or ("7" if is_comjjang else "9"),
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
            "is_comjjang": new_event.is_comjjang,
            "meeting_id": new_event.meeting_id,
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
        if event_data.is_comjjang is not None: rec.is_comjjang = event_data.is_comjjang
        if event_data.meeting_id is not None: rec.meeting_id = event_data.meeting_id
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

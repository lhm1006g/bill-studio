# 🎬 Bill Studio - 프로젝트 컨텍스트

> 이 파일은 AI 세션이 새로 시작될 때 프로젝트 맥락을 유지하기 위한 파일입니다.
> 작업 진행 시 반드시 이 파일을 먼저 읽고, 진행 상황을 업데이트하며 작업하세요.

---

## 📌 프로젝트 개요

- **프로젝트명**: Bill Studio
- **목적**: 개인용 올인원 스튜디오 웹앱 (맥미니 로컬 서버에서 실행)
- **사용자**: 본인(Bill)만 사용
- **외부 접속**: Cloudflare Tunnel로 외부에서도 접속 가능하게 구성 예정

---

## 🏗️ 확정된 기술 스택

| 영역 | 기술 | 비고 |
|------|------|------|
| Frontend (화면) | **Vite + React** | Next.js 대신 Vite 선택 (개인용, 가벼움) |
| Backend (작업처리) | **FastAPI (Python)** | 영상처리, AI 등 무거운 작업 담당 |
| Database | **SQLite** | 로컬 파일 DB (studio.db) |
| 외부 접속 | **Cloudflare Tunnel** | ngrok 대신 선택 (무료, 안정적) |
| 서버 자동실행 | **PM2 + launchd** | 맥미니 부팅 시 자동 서버 실행 |

---

## 📁 프로젝트 폴더 구조

```
/Users/bill/projects/my/bill_studio/
├── GEMINI.md                ← 현재 파일 (AI 컨텍스트)
├── frontend/                ← Vite + React
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Downloader.jsx
│   │   │   ├── Editor.jsx
│   │   │   ├── Subtitle.jsx
│   │   │   ├── Schedule.jsx
│   │   │   ├── News.jsx
│   │   │   └── AiChat.jsx
│   │   ├── components/
│   │   │   ├── Sidebar.jsx
│   │   │   └── Header.jsx
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js
│
├── backend/                 ← FastAPI (Python)
│   ├── routers/
│   │   ├── downloader.py
│   │   ├── editor.py
│   │   ├── subtitle.py
│   │   ├── schedule.py
│   │   ├── news.py
│   │   └── ai_chat.py
│   ├── models/
│   │   └── database.py
│   ├── main.py
│   ├── requirements.txt
│   └── studio.db
│
└── README.md
```

---

## 🎯 기능 목록 & 핵심 라이브러리

| # | 기능 | 라이브러리 | 설명 |
|---|------|-----------|------|
| 1 | **유튜브/영상 다운로드** | `yt-dlp` | URL 입력 → 해상도 선택 → 다운로드 |
| 2 | **동영상 편집** | `ffmpeg-python` | 자르기, 합치기, 포맷 변환 |
| 3 | **AI 자막 생성/편집** | `faster-whisper` | 로컬 AI 자막 생성, SRT 편집 |
| 4 | **일정 관리** | SQLite | 캘린더 UI, 일정 CRUD |
| 5 | **뉴스 리서치** | `feedparser`, `newspaper3k` | RSS 구독, AI 요약 |
| 6 | **AI 어시스턴트 채팅** | `ollama` | 로컬 LLM, 대화 기록 저장 |

---

## 🚀 개발 단계 (Phase)

- [x] **Phase 1** - 기반 구조 세팅 (Vite + FastAPI + SQLite + 사이드바 UI) ✅
- [x] **Phase 2** - 유튜브 다운로드 기능 (yt-dlp 고화질 1080p~4K + SSE 실시간 진행률 + 파일목록) ✅
- [x] **Phase 3** - AI 자막 생성/편집 기능 (faster-whisper 한국어 음성인식 + 실시간 자막 싱크 바 + 스크립트 대본 편집기 + SRT 다운로드) ✅
- [ ] **Phase 4** - 동영상 편집 기능 (ffmpeg-python 기반 확장)
- [ ] **Phase 5** - 일정 관리 기능
- [ ] **Phase 6** - 뉴스 리서치 기능
- [ ] **Phase 7** - AI 어시스턴트 채팅 기능
- [ ] **Phase 8** - 외부 접속 (Cloudflare Tunnel + PM2 자동실행)

---

## 🎨 디자인 방향

- **테마**: 다크모드 기본
- **색상**: 딥 그레이 배경 + 보라/파랑 포인트 컬러
- **레이아웃**: 왼쪽 사이드바 + 오른쪽 콘텐츠 영역
- **폰트**: Inter (Google Fonts)
- **스타일**: 글래스모피즘 + 모던 미니멀

---

## 🔌 API 포트 정보

- Frontend (Vite): `http://localhost:5173`
- Backend (FastAPI): `http://localhost:8000`

---

## 📝 현재 진행 상황

> 마지막 업데이트: 2026-09-27

### 완료된 작업
- [x] 기술 스택 확정 (Vite + FastAPI + SQLite)
- [x] 전체 기능 목록 확정
- [x] 개발 단계(Phase) 계획 수립
- [x] GEMINI.md 컨텍스트 파일 생성
- [x] GitHub 레포 연결 (https://github.com/lhm1006g/bill-studio)
- [x] Phase 1 완료 - Vite+React 프론트엔드 생성, FastAPI 백엔드 기반, 사이드바+라우팅 UI
- [x] Phase 2 완료 - 유튜브 다운로드 기능
  - yt-dlp 403 에러 우회 및 순수 포맷 추출 지원
  - 1080p ~ 4K 고화질 비디오+오디오 결합 다운로드 (ffmpeg)
  - SSE(Server-Sent Events) 실시간 다운로드 진행률, 다운로드 속도, 남은 시간
  - MP3 음원 추출 지원
  - Mac Finder 폴더 열기 연동 및 최근 다운로드 목록 표시
  - 다운로드 파일 저장 위치: 프로젝트 하위 `downloads/` (`/Users/bill/projects/my/bill_studio/downloads`)
  - 다운로드 목록 클릭 시 동영상 편집기(`/editor?file=...`) 직행 연동
- [x] Phase 3 완료 - AI 자막 생성 및 편집 기능
  - `faster-whisper` 로컬 AI 모델 기반 한국어 음성 자동 인식
  - 영상 재생에 맞춰 영상 바로 밑에 실시간으로 출력되는 **글래스모피즘 자막 바**
  - 자막 타임코드 클릭 시 해당 영상 위치로 즉시 점프(Seek) 기능
  - 오타 즉시 수정 인라인 편집 및 `downloads/` 내 `.json` / `.srt` 파일 자동 저장/내보내기
- [x] Phase 4 (부분 선행 완료) - 동영상 편집기 기본 기능
  - FastAPI `/api/media` 정적 비디오 스트리밍 서빙 및 HTTP Range 206 부분 스트리밍
  - `ffprobe` 기반 영상 정밀 메타데이터(해상도, 코덱, FPS, 길이, 파일크기) 추출
  - 브라우저 비디오 플레이어 연동 및 재생 위치 기반 시작/종료점 선택
  - `ffmpeg` 기반 초고속 무손실 구간 자르기(`-c copy` / 인코딩 fallback) 기능
  - Mac 하드웨어 가속(VideoToolbox) 기반 비호환 코덱(VP9) 1초 초고속 H.264 변환
- [x] 유튜브 수익화 1단계 - AI 내레이션 (Edge-TTS) 자동 더빙 시스템
  - 마이크로소프트 초고음질 한국어 AI 성우(선희, 인준, 현수) 연동 (100% 무료/무제한)
  - 대본 타임코드별 AI 음성 생성 및 원본 배경음(BGM 15%) 자동 오디오 믹싱
  - 음성 미리듣기 & 원클릭 더빙 영상 제작
- [x] 유튜브 수익화 1.5단계 - 배경음악(BGM) 선택 및 3채널 오디오 믹싱 시스템
  - 로열티 프리 기본 앰비언트 BGM 프리셋 제공 및 미리듣기 지원
  - 사용자 보유 MP3/WAV/M4A 음원 추가 및 보관함 관리
  - 원본 소리(10%) + BGM(15% 자동 페이드아웃 루프) + AI 목소리 정밀 3채널 오디오 믹싱
- [x] 유튜브 수익화 1.8단계 - 해외 영상(영어/일어 등) ➔ 한국어 자동 번역 & 한국어 AI 더빙 파이프라인
  - Whisper 다국어(영어, 일본어, 중국어 등) 자동 언어 감지 및 음성인식
  - 비동기 초고속 한국어 자동 번역 엔진 연동 (`POST /api/subtitle/translate`)
  - 자막 에디터 상단 `🌐 한국어로 일괄 번역` 원클릭 버튼 및 추출 시 자동 번역 옵션
  - 번역된 한국어 대본을 기반으로 한국어 AI 성우(선희/인준/현수) 실시간 자동 더빙
- [x] 유튜브 수익화 1.9단계 - 자막과 목소리 위치 및 타임코드 1:1 정밀 싱크 동기화 시스템
  - 비디오 화면 내부 실시간 오버레이 자막 (유튜브/넷플릭스 스타일 고시인성 버블)
  - 화면 자막 위치 선택 기능 (`하단` / `중앙` / `상단`) 및 ON/OFF 토글
  - 전체 자막 싱크 일괄 앞당기기/늦추기 컨트롤 (`-0.5s`, `-0.2s`, `+0.2s`, `+0.5s`)
  - AI 더빙 영상 렌더링 시 실제 AI 성우 음성 길이(`audio_duration`)를 1:1 측정하여 목소리 발화 구간과 자막 타임코드를 완벽 일치 및 겹침 방지 순차 정렬
  - 긴 텀 자막 원클릭 분할(`✂️`) 및 영상 재생 위치로 시작/종료 시간 즉시 맞춤(`🎯현재`, `🎯현재로 끝`), 시간 직접 입력창 지원
  - Whisper 음성인식 시 단어 간 1.2초 이상 텀 발생 시 자동 분할 파라미터 적용
- [x] 유튜브 수익화 1.95단계 - 자막 유지 시간(Linger) 조절 및 짧은 자막 원클릭 연장 시스템
  - 말이 끝나도 자막이 순식간에 사라져 놓치는 현상을 방지하는 실시간 유지(Linger) 버퍼 제공 (`0s`, `0.8s (추천)`, `1.5s (넉넉)`)
  - 다음 문장 발화 직전까지 자막이 매끄럽게 유지되며 겹침(Overlap) 완전 차단
  - 너무 짧게 끊긴 자막을 사람이 읽기 편한 최소 1.8초 이상으로 일괄 연장하는 `⏱ 짧은 자막 연장` 원클릭 버튼 지원
  - 개별 자막 항목별 종료 시간 `+0.5s` 미세 연장 버튼 추가

### 다음 할 일
- [ ] 유튜브 수익화 2단계 - 원클릭 쇼츠(Shorts) 9:16 변환 & 자막 영상 각인(Burn-in)




---

## ⚙️ 맥미니 환경 체크리스트 (Phase 1 시작 전 확인)

- [ ] Node.js 설치 확인 (`node -v`)
- [ ] Python 설치 확인 (`python3 -v`)
- [ ] ffmpeg 설치 확인 (`ffmpeg -version`)
- [ ] ollama 설치 확인 (`ollama -v`)

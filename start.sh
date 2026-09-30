#!/bin/bash
# Bill Studio 맥미니 로컬 서버 원클릭 실행 스크립트

echo "🚀 Bill Studio 서버를 시작합니다..."
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# 환경 변수 (Homebrew Node v22 등 우선 적용)
export PATH="/opt/homebrew/bin:$PATH"

# 1. 백엔드 실행 (FastAPI - 포트 8000)
echo "📦 백엔드(FastAPI) 시작 중..."
cd "$DIR/backend"
if [ -d "venv" ]; then
    source venv/bin/activate
fi
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# 2. 프론트엔드 실행 (Vite - 포트 5173)
echo "💻 프론트엔드(Vite) 시작 중..."
cd "$DIR/frontend"
npm run dev -- --host 0.0.0.0 &
FRONTEND_PID=$!

echo "✨ Bill Studio가 성공적으로 실행되었습니다!"
echo "👉 접속 주소: http://localhost:5173 (또는 맥미니 IP:5173)"
echo "종료하려면 Ctrl+C를 누르세요."

# 종료 시그널 처리
trap "kill $BACKEND_PID $FRONTEND_PID; exit" INT TERM
wait

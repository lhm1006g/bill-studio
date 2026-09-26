import { useLocation } from 'react-router-dom'
import './Header.css'

const pageNames = {
  '/dashboard':  '대시보드',
  '/downloader': '유튜브 다운로드',
  '/editor':     '동영상 편집',
  '/subtitle':   'AI 자막',
  '/schedule':   '일정 관리',
  '/news':       '뉴스 리서치',
  '/ai-chat':    'AI 어시스턴트',
}

function Header() {
  const location = useLocation()
  const title = pageNames[location.pathname] || 'Bill Studio'

  return (
    <header className="header">
      <h1 className="header-title">{title}</h1>
      <div className="header-right">
        <span className="status-dot" />
        <span className="status-text">서버 연결됨</span>
      </div>
    </header>
  )
}

export default Header

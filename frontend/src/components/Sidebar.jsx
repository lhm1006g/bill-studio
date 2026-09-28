import { NavLink } from 'react-router-dom'
import './Sidebar.css'

const menuItems = [
  { path: '/dashboard',  icon: '🏠', label: '대시보드' },
  { path: '/research',   icon: '💡', label: '콘텐츠 발굴' },
  { path: '/downloader', icon: '⬇️', label: '다운로드' },
  { path: '/editor',     icon: '✂️', label: '영상 편집' },
  { path: '/subtitle',   icon: '📝', label: '자막' },
  { path: '/schedule',   icon: '📅', label: '일정 관리' },
  { path: '/meetings',   icon: '🎙️', label: '컴짱회의' },
  { path: '/news',       icon: '📰', label: '뉴스' },
  { path: '/ai-chat',    icon: '🤖', label: 'AI 어시스턴트' },
]

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-icon">🎬</span>
        <span className="logo-text">Bill Studio</span>
      </div>
      <nav className="sidebar-nav">
        {menuItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `nav-item ${isActive ? 'active' : ''}`
            }
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span>v1.0.0</span>
      </div>
    </aside>
  )
}

export default Sidebar

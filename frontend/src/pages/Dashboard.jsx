import './Dashboard.css'

const stats = [
  { icon: '⬇️', label: '총 다운로드', value: '0개' },
  { icon: '✂️', label: '편집된 영상', value: '0개' },
  { icon: '📝', label: '생성된 자막', value: '0개' },
  { icon: '📅', label: '이번 주 일정', value: '0개' },
]

const features = [
  { icon: '⬇️', title: '유튜브 다운로드', desc: 'URL 입력 후 해상도 선택하여 다운로드', path: '/downloader', color: '#ef4444' },
  { icon: '✂️', title: '동영상 편집',    desc: '자르기, 합치기, 포맷 변환',           path: '/editor',     color: '#f97316' },
  { icon: '📝', title: 'AI 자막',        desc: 'faster-whisper로 자동 자막 생성',      path: '/subtitle',   color: '#8b5cf6' },
  { icon: '📅', title: '일정 관리',      desc: '캘린더 UI로 일정 추가/관리',           path: '/schedule',   color: '#06b6d4' },
  { icon: '📰', title: '뉴스 리서치',    desc: 'RSS 구독 및 AI 뉴스 요약',            path: '/news',       color: '#22c55e' },
  { icon: '🤖', title: 'AI 어시스턴트', desc: '로컬 LLM으로 대화형 AI',               path: '/ai-chat',    color: '#a78bfa' },
]

function Dashboard() {
  return (
    <div className="dashboard">
      <div className="welcome-card card">
        <div className="welcome-text">
          <h2>🎬 Bill Studio에 오신 것을 환영합니다</h2>
          <p>개인용 올인원 스튜디오 — 모든 작업을 한 곳에서.</p>
        </div>
        <div className="welcome-badge">LOCAL SERVER</div>
      </div>

      <div className="stats-grid">
        {stats.map((s) => (
          <div key={s.label} className="stat-card card">
            <span className="stat-icon">{s.icon}</span>
            <span className="stat-value">{s.value}</span>
            <span className="stat-label">{s.label}</span>
          </div>
        ))}
      </div>

      <h3 className="section-title">기능 바로가기</h3>
      <div className="features-grid">
        {features.map((f) => (
          <a key={f.path} href={f.path} className="feature-card card">
            <div className="feature-icon" style={{ background: `${f.color}22`, color: f.color }}>
              {f.icon}
            </div>
            <div className="feature-info">
              <h4>{f.title}</h4>
              <p>{f.desc}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}

export default Dashboard

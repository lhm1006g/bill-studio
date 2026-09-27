import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import './Downloader.css'


function formatSize(bytes) {
  if (!bytes) return '알 수 없음'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

function formatDuration(sec) {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(timestamp) {
  if (!timestamp) return ''
  const d = new Date(timestamp * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const CHANNELS_CONFIG = [
  { id: 'humanity', name: '💧 인류애 & 감동 실화', color: '#38bdf8' },
  { id: 'sports', name: '⚡ 스포츠 명장면', color: '#f59e0b' },
  { id: 'animals', name: '🐾 동물 힐링', color: '#10b981' },
  { id: 'tech', name: '🧠 미래 테크 & AI', color: '#a855f7' },
  { id: 'rescene', name: '🌸 리센느 & K-POP', color: '#ec4899' },
]

export default function Downloader() {
  const navigate = useNavigate()
  const location = useLocation()
  const [url, setUrl] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('humanity')
  const [historyChannelFilter, setHistoryChannelFilter] = useState('all')
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedFormat, setSelectedFormat] = useState(null)
  const [dlStatus, setDlStatus] = useState(null) // null | 'downloading' | 'done' | 'error'
  const [progress, setProgress] = useState({ percent: '0%', speed: '', eta: '' })
  const [saveDir, setSaveDir] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState([])
  const esRef = useRef(null)

  useEffect(() => {
    loadHistory(historyChannelFilter)
  }, [historyChannelFilter])

  // URL 및 channel 파라미터로 넘어왔을 때 자동 정보 조회
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const targetUrl = params.get('url')
    const targetChannel = params.get('channel')
    if (targetChannel && CHANNELS_CONFIG.some(c => c.id === targetChannel)) {
      setSelectedChannel(targetChannel)
      setHistoryChannelFilter(targetChannel)
    }
    if (targetUrl) {
      setUrl(targetUrl)
      handleSearch(targetUrl)
    }
  }, [location.search])

  async function loadHistory(channel = 'all') {
    try {
      const query = channel && channel !== 'all' ? `?channel=${channel}` : ''
      const res = await fetch(`/api/download/history${query}`)
      if (res.ok) {
        const data = await res.json()
        setHistory(data.files || [])
        if (data.save_dir) setSaveDir(data.save_dir)
      }
    } catch {
      // ignore
    }
  }

  async function handleOpenFolder() {
    try {
      await fetch('/api/download/open-folder', { method: 'POST' })
    } catch (e) {
      alert('폴더 열기 실패: ' + e.message)
    }
  }

  async function handleSearch(urlOverride = null) {
    const targetUrl = (urlOverride || url).trim()
    if (!targetUrl) return
    setLoading(true)
    setInfo(null)
    setError('')
    setDlStatus(null)
    try {
      const res = await fetch('/api/download/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '영상 정보를 가져올 수 없습니다.')
      }
      const data = await res.json()
      setInfo(data)
      setSelectedFormat(data.formats[0]?.format_id || null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleDownload() {
    if (!selectedFormat) return
    setDlStatus('downloading')
    setProgress({ percent: '0%', speed: '', eta: '' })

    const params = new URLSearchParams({
      url,
      format_id: selectedFormat,
      channel: selectedChannel,
    })
    const es = new EventSource(`/api/download/start?${params}`)
    esRef.current = es

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.status === 'progress') {
        setProgress({ percent: data.percent, speed: data.speed, eta: data.eta })
      } else if (data.status === 'done') {
        setDlStatus('done')
        setSaveDir(data.save_dir)
        loadHistory(historyChannelFilter)
        es.close()
      } else if (data.status === 'error') {
        setDlStatus('error')
        setError(data.message)
        es.close()
      }
    }
    es.onerror = () => {
      setDlStatus('error')
      setError('다운로드 중 연결이 끊겼습니다.')
      es.close()
    }
  }

  return (
    <div className="downloader">
      {/* URL 입력 & 채널 선택 */}
      <div className="card url-section">
        {/* 채널 선택 바 */}
        <div className="dl-channel-select-row">
          <span className="channel-label">📺 저장 대상 채널:</span>
          <div className="channel-chips">
            {CHANNELS_CONFIG.map(ch => (
              <button
                key={ch.id}
                type="button"
                className={`dl-channel-chip ${selectedChannel === ch.id ? 'active' : ''}`}
                onClick={() => setSelectedChannel(ch.id)}
                style={{ '--ch-color': ch.color }}
              >
                {ch.name}
              </button>
            ))}
          </div>
        </div>

        <div className="url-row">
          <input
            className="input url-input"
            placeholder="YouTube URL을 붙여넣으세요 (예: https://youtube.com/watch?v=...)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>
            {loading ? '⏳ 불러오는 중...' : '🔍 영상 정보 가져오기'}
          </button>
        </div>
        {error && <p className="error-msg">❌ {error}</p>}
      </div>

      {/* 영상 정보 */}
      {info && (
        <div className="card video-info-card">
          <div className="video-info">
            <img className="thumbnail" src={info.thumbnail} alt="썸네일" />
            <div className="video-meta">
              <h2 className="video-title">{info.title}</h2>
              <div className="meta-tags">
                {info.uploader && <span className="tag">👤 {info.uploader}</span>}
                {info.duration && <span className="tag">⏱ {formatDuration(info.duration)}</span>}
                {info.view_count && (
                  <span className="tag">👁 {info.view_count.toLocaleString()}회</span>
                )}
                <span className="tag channel-tag">
                  📁 {CHANNELS_CONFIG.find(c => c.id === selectedChannel)?.name}
                </span>
              </div>
            </div>
          </div>

          {/* 화질 선택 */}
          <div className="format-section">
            <h3 className="format-title">📺 화질 / 형식 선택</h3>
            <div className="format-grid">
              {info.formats.map((f) => (
                <button
                  key={f.format_id}
                  className={`format-btn ${selectedFormat === f.format_id ? 'selected' : ''}`}
                  onClick={() => setSelectedFormat(f.format_id)}
                >
                  <span className="format-label">{f.label}</span>
                  {f.filesize && (
                    <span className="format-size">{formatSize(f.filesize)}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 다운로드 버튼 */}
          {dlStatus !== 'downloading' && dlStatus !== 'done' && (
            <button className="btn btn-primary dl-btn" onClick={handleDownload}>
              ⬇️ [{CHANNELS_CONFIG.find(c => c.id === selectedChannel)?.name}] 채널 폴더로 다운로드
            </button>
          )}
        </div>
      )}

      {/* 진행률 */}
      {dlStatus === 'downloading' && (
        <div className="card progress-card">
          <h3>⬇️ [{CHANNELS_CONFIG.find(c => c.id === selectedChannel)?.name}] 다운로드 중...</h3>
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: progress.percent }} />
          </div>
          <div className="progress-info">
            <span className="progress-pct">{progress.percent}</span>
            <span>{progress.speed}</span>
            <span>남은 시간: {progress.eta}</span>
          </div>
        </div>
      )}

      {/* 완료 */}
      {dlStatus === 'done' && (
        <div className="card done-card">
          <div className="done-icon">✅</div>
          <h3>다운로드 완료!</h3>
          <p className="save-dir">📁 저장 위치: <code>{saveDir}</code></p>
          <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                const targetFile = history[0]?.rel_path || history[0]?.name
                if (targetFile) {
                  navigate(`/editor?file=${encodeURIComponent(targetFile)}&channel=${selectedChannel}`)
                }
              }}
            >
              ✂️ 바로 편집기로 열기 (채널 맞춤 세팅)
            </button>
            <button className="btn btn-secondary" onClick={() => handleOpenFolder(selectedChannel)}>
              📂 Finder에서 열기
            </button>
            <button className="btn btn-secondary" onClick={() => { setDlStatus(null); setInfo(null); setUrl('') }}>
              🔄 새로 다운로드
            </button>
          </div>
        </div>
      )}

      {/* 최근 다운로드 목록 */}
      <div className="card history-card">
        <div className="history-header">
          <div className="history-header-left">
            <h3>📂 다운로드 파일 목록 ({history.length}개)</h3>
            {/* 채널 필터 탭 */}
            <div className="history-channel-tabs">
              <button
                className={`filter-tab ${historyChannelFilter === 'all' ? 'active' : ''}`}
                onClick={() => setHistoryChannelFilter('all')}
              >
                전체
              </button>
              {CHANNELS_CONFIG.map(ch => (
                <button
                  key={ch.id}
                  className={`filter-tab ${historyChannelFilter === ch.id ? 'active' : ''}`}
                  onClick={() => setHistoryChannelFilter(ch.id)}
                >
                  {ch.name}
                </button>
              ))}
            </div>
          </div>

          <div className="history-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => handleOpenFolder(historyChannelFilter)}>
              📁 폴더 열기
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => loadHistory(historyChannelFilter)}>
              🔄 새로고침
            </button>
          </div>
        </div>

        {history.length === 0 ? (
          <p className="empty-history">해당 채널에 다운로드된 파일이 없습니다.</p>
        ) : (
          <div className="history-list">
            {history.map((item, idx) => (
              <div
                key={idx}
                className="history-item clickable"
                onClick={() => {
                  const targetPath = item.rel_path || item.name
                  const chParam = item.channel ? `&channel=${item.channel}` : ''
                  navigate(`/editor?file=${encodeURIComponent(targetPath)}${chParam}`)
                }}
                title="클릭하여 동영상 편집기에서 열기"
              >
                <span className="file-icon">🎬</span>
                <div className="file-name-block">
                  <span className="file-name">{item.name}</span>
                  {item.channel_label && (
                    <span className="history-channel-badge">{item.channel_label}</span>
                  )}
                </div>
                <span className="file-size">{formatSize(item.size)}</span>
                <span className="file-date">{formatDate(item.modified)}</span>
                <button
                  className="btn btn-primary btn-sm edit-shortcut-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    const targetPath = item.rel_path || item.name
                    const chParam = item.channel ? `&channel=${item.channel}` : ''
                    navigate(`/editor?file=${encodeURIComponent(targetPath)}${chParam}`)
                  }}
                >
                  ✂️ 편집
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}

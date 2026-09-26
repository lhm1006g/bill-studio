import { useState, useRef } from 'react'
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
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${m}:${String(s).padStart(2,'0')}`
}

export default function Downloader() {
  const [url, setUrl] = useState('')
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selectedFormat, setSelectedFormat] = useState(null)
  const [dlStatus, setDlStatus] = useState(null) // null | 'downloading' | 'done' | 'error'
  const [progress, setProgress] = useState({ percent: '0%', speed: '', eta: '' })
  const [saveDir, setSaveDir] = useState('')
  const [error, setError] = useState('')
  const esRef = useRef(null)

  async function handleSearch() {
    if (!url.trim()) return
    setLoading(true)
    setInfo(null)
    setError('')
    setDlStatus(null)
    try {
      const res = await fetch('/api/download/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
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

    const params = new URLSearchParams({ url, format_id: selectedFormat })
    const es = new EventSource(`/api/download/start?${params}`)
    esRef.current = es

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.status === 'progress') {
        setProgress({ percent: data.percent, speed: data.speed, eta: data.eta })
      } else if (data.status === 'done') {
        setDlStatus('done')
        setSaveDir(data.save_dir)
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

  const percentNum = parseInt(progress.percent) || 0

  return (
    <div className="downloader">
      {/* URL 입력 */}
      <div className="card url-section">
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
              ⬇️ 다운로드 시작
            </button>
          )}
        </div>
      )}

      {/* 진행률 */}
      {dlStatus === 'downloading' && (
        <div className="card progress-card">
          <h3>⬇️ 다운로드 중...</h3>
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
          <button className="btn btn-secondary" onClick={() => { setDlStatus(null); setInfo(null); setUrl('') }}>
            🔄 새로 다운로드
          </button>
        </div>
      )}
    </div>
  )
}

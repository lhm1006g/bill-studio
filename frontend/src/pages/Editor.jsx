import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import './Editor.css'

function formatSeconds(sec) {
  if (isNaN(sec) || sec === null || sec === undefined) return '00:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.floor((sec % 1) * 10)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`
}

function formatSize(bytes) {
  if (!bytes) return '알 수 없음'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

export default function Editor() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const currentFile = searchParams.get('file')

  const [fileList, setFileList] = useState([])
  const [loadingFiles, setLoadingFiles] = useState(false)

  // 선택된 파일 상세 정보
  const [mediaInfo, setMediaInfo] = useState(null)
  const [loadingInfo, setLoadingInfo] = useState(false)
  const [infoError, setInfoError] = useState('')

  // 플레이어 제어
  const videoRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  // 구간 자르기 상태
  const [startTime, setStartTime] = useState(0)
  const [endTime, setEndTime] = useState(0)
  const [customOutName, setCustomOutName] = useState('')
  const [cutting, setCutting] = useState(false)
  const [cutResult, setCutResult] = useState(null)
  const [cutError, setCutError] = useState('')

  useEffect(() => {
    loadFiles()
  }, [])

  useEffect(() => {
    if (currentFile) {
      loadMediaInfo(currentFile)
    } else {
      setMediaInfo(null)
    }
  }, [currentFile])

  async function loadFiles() {
    setLoadingFiles(true)
    try {
      const res = await fetch('/api/editor/files')
      if (res.ok) {
        const data = await res.json()
        setFileList(data.files || [])
      }
    } catch {
      // ignore
    } finally {
      setLoadingFiles(false)
    }
  }

  async function loadMediaInfo(filename) {
    setLoadingInfo(true)
    setInfoError('')
    setCutResult(null)
    setCutError('')
    try {
      const res = await fetch(`/api/editor/info?file=${encodeURIComponent(filename)}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '영상 정보를 불러오지 못했습니다.')
      }
      const data = await res.json()
      setMediaInfo(data)
      setDuration(data.duration || 0)
      setStartTime(0)
      setEndTime(data.duration ? Math.min(data.duration, 30) : 0)
    } catch (e) {
      setInfoError(e.message)
    } finally {
      setLoadingInfo(false)
    }
  }

  function handleSelectFile(name) {
    setSearchParams({ file: name })
  }

  function handleTimeUpdate() {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime)
    }
  }

  function handleLoadedMetadata() {
    if (videoRef.current) {
      const dur = videoRef.current.duration
      setDuration(dur)
      if (endTime === 0 || endTime > dur) {
        setEndTime(dur)
      }
    }
  }

  function setStartToCurrent() {
    if (videoRef.current) {
      const t = parseFloat(videoRef.current.currentTime.toFixed(1))
      setStartTime(t)
      if (t >= endTime) {
        setEndTime(Math.min(duration, t + 10))
      }
    }
  }

  function setEndToCurrent() {
    if (videoRef.current) {
      const t = parseFloat(videoRef.current.currentTime.toFixed(1))
      setEndTime(t)
      if (t <= startTime) {
        setStartTime(Math.max(0, t - 10))
      }
    }
  }

  async function handleCutVideo() {
    if (!currentFile) return
    if (endTime <= startTime) {
      alert('종료 시간은 시작 시간보다 커야 합니다.')
      return
    }

    setCutting(true)
    setCutError('')
    setCutResult(null)

    try {
      const res = await fetch('/api/editor/cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          start_time: startTime,
          end_time: endTime,
          output_name: customOutName || undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '자르기 작업에 실패했습니다.')
      }

      const data = await res.json()
      setCutResult(data)
      loadFiles() // 파일 목록 갱신
    } catch (e) {
      setCutError(e.message)
    } finally {
      setCutting(false)
    }
  }

  return (
    <div className="editor-page">
      {/* 상단 네비게이션 */}
      <div className="editor-topbar">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/downloader')}>
          ← 다운로더로 돌아가기
        </button>
        {currentFile && (
          <button className="btn btn-secondary btn-sm" onClick={() => setSearchParams({})}>
            📂 다른 영상 선택
          </button>
        )}
      </div>

      {!currentFile ? (
        /* 파일 선택 화면 */
        <div className="card file-picker-card">
          <div className="picker-header">
            <h2>🎬 편집할 영상을 선택하세요</h2>
            <p>다운로드된 영상 목록에서 편집할 파일을 클릭하세요.</p>
          </div>

          {loadingFiles ? (
            <div className="loading-state">⏳ 파일 목록 불러오는 중...</div>
          ) : fileList.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">📁</span>
              <p>다운로드된 영상 파일이 없습니다.</p>
              <button className="btn btn-primary" onClick={() => navigate('/downloader')}>
                ⬇️ 유튜브 다운로더로 이동
              </button>
            </div>
          ) : (
            <div className="picker-grid">
              {fileList.map((f, idx) => (
                <div
                  key={idx}
                  className="picker-item"
                  onClick={() => handleSelectFile(f.name)}
                >
                  <div className="picker-item-icon">🎬</div>
                  <div className="picker-item-info">
                    <h4 className="picker-name" title={f.name}>{f.name}</h4>
                    <span className="picker-meta">{formatSize(f.size)} • {f.ext.toUpperCase()}</span>
                  </div>
                  <button className="btn btn-primary btn-sm">선택</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* 영상 상세 및 편집기 화면 */
        <div className="editor-workspace">
          {loadingInfo ? (
            <div className="card loading-card">⏳ 영상 정보를 분석하는 중...</div>
          ) : infoError ? (
            <div className="card error-card">
              <p>❌ {infoError}</p>
              <button className="btn btn-secondary" onClick={() => setSearchParams({})}>
                다른 영상 선택
              </button>
            </div>
          ) : (
            <>
              {/* 비디오 플레이어 & 파일 헤더 */}
              <div className="card player-card">
                <div className="media-header">
                  <h2 className="current-filename">{mediaInfo?.name}</h2>
                  <div className="media-badges">
                    {mediaInfo?.video?.height && (
                      <span className="badge badge-resolution">
                        📺 {mediaInfo.video.width}×{mediaInfo.video.height}
                      </span>
                    )}
                    {mediaInfo?.duration > 0 && (
                      <span className="badge badge-duration">
                        ⏱ {formatSeconds(mediaInfo.duration)}
                      </span>
                    )}
                    {mediaInfo?.video?.codec && (
                      <span className="badge badge-codec">
                        🎞 {mediaInfo.video.codec.toUpperCase()} {mediaInfo.video.fps ? `(${mediaInfo.video.fps}fps)` : ''}
                      </span>
                    )}
                    {mediaInfo?.size && (
                      <span className="badge badge-size">
                        📦 {formatSize(mediaInfo.size)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="video-wrapper">
                  <video
                    ref={videoRef}
                    className="video-player"
                    controls
                    src={mediaInfo?.url}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                  />
                </div>

                <div className="playback-status">
                  <span>현재 위치: <strong>{formatSeconds(currentTime)}</strong></span>
                  <span>전체 길이: <strong>{formatSeconds(duration)}</strong></span>
                </div>
              </div>

              {/* 편집 도구 패널 */}
              <div className="editor-panels">
                {/* 1. 구간 자르기 도구 */}
                <div className="card tool-card">
                  <div className="tool-title">
                    <h3>✂️ 구간 자르기 (Fast Cut)</h3>
                    <span className="tool-desc">원하는 구간을 초고속 무손실로 추출합니다.</span>
                  </div>

                  <div className="cut-controls">
                    <div className="time-input-group">
                      <label>시작 시간 (Start)</label>
                      <div className="time-row">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max={duration}
                          className="input time-input"
                          value={startTime}
                          onChange={(e) => setStartTime(parseFloat(e.target.value) || 0)}
                        />
                        <button className="btn btn-secondary btn-sm" onClick={setStartToCurrent}>
                          📍 현재 위치로 설정
                        </button>
                      </div>
                      <span className="time-display">{formatSeconds(startTime)}</span>
                    </div>

                    <div className="time-input-group">
                      <label>종료 시간 (End)</label>
                      <div className="time-row">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max={duration}
                          className="input time-input"
                          value={endTime}
                          onChange={(e) => setEndTime(parseFloat(e.target.value) || 0)}
                        />
                        <button className="btn btn-secondary btn-sm" onClick={setEndToCurrent}>
                          📍 현재 위치로 설정
                        </button>
                      </div>
                      <span className="time-display">{formatSeconds(endTime)}</span>
                    </div>
                  </div>

                  <div className="cut-summary">
                    <span>추출될 구간 길이: <strong>{formatSeconds(Math.max(0, endTime - startTime))}</strong></span>
                  </div>

                  <div className="cut-filename-row">
                    <input
                      className="input"
                      placeholder="저장할 파일명 (비워두면 자동 생성)"
                      value={customOutName}
                      onChange={(e) => setCustomOutName(e.target.value)}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={handleCutVideo}
                      disabled={cutting || endTime <= startTime}
                    >
                      {cutting ? '⏳ 자르는 중...' : '✂️ 구간 자르기 실행'}
                    </button>
                  </div>

                  {cutError && <p className="error-msg">❌ {cutError}</p>}

                  {cutResult && (
                    <div className="cut-success-box">
                      <div className="success-icon">🎉</div>
                      <div className="success-info">
                        <strong>구간 자르기 완료!</strong>
                        <p>새 파일: <code>{cutResult.output_file}</code> ({formatSize(cutResult.output_size)})</p>
                      </div>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleSelectFile(cutResult.output_file)}
                      >
                        이 파일 열기
                      </button>
                    </div>
                  )}
                </div>

                {/* 2. AI 자막 생성 파이프라인 연계 */}
                <div className="card pipeline-card">
                  <div className="tool-title">
                    <h3>🎙️ AI 자막 연계 (Phase 3)</h3>
                    <span className="tool-desc">이 영상의 음성을 인식해 자동으로 자막을 생성합니다.</span>
                  </div>
                  <div className="pipeline-action">
                    <button
                      className="btn btn-accent-glow"
                      onClick={() => navigate(`/subtitle?file=${encodeURIComponent(currentFile)}`)}
                    >
                      ✨ 이 영상으로 AI 자막 생성하기
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

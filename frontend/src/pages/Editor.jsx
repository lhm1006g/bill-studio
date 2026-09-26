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

  // AI 자막 상태
  const [subtitles, setSubtitles] = useState([])
  const [subtitlesLoaded, setSubtitlesLoaded] = useState(false)
  const [extractingSubs, setExtractingSubs] = useState(false)
  const [subsModel, setSubsModel] = useState('base')
  const [showSubtitles, setShowSubtitles] = useState(true)
  const [subError, setSubError] = useState('')
  const [savingSubs, setSavingSubs] = useState(false)
  const [subsSavedNotice, setSubsSavedNotice] = useState(false)
  const [activeTab, setActiveTab] = useState('subtitle') // 'subtitle' | 'tts' | 'cut'
  const [converting, setConverting] = useState(false)

  // AI 내레이션 (더빙) 상태
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState('ko-KR-SunHiNeural')
  const [ttsRate, setTtsRate] = useState('+10%')
  const [origVolume, setOrigVolume] = useState(0.15)
  const [dubbing, setDubbing] = useState(false)
  const [dubResult, setDubResult] = useState(null)
  const [dubError, setDubError] = useState('')
  const [previewing, setPreviewing] = useState(false)



  const activeSegmentRef = useRef(null)
  const scriptListRef = useRef(null)

  useEffect(() => {
    loadFiles()
    loadVoices()
  }, [])

  async function loadVoices() {
    try {
      const res = await fetch('/api/tts/voices')
      if (res.ok) {
        const data = await res.json()
        setVoices(data.voices || [])
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (currentFile) {
      loadMediaInfo(currentFile)
      loadExistingSubtitles(currentFile)
      setDubResult(null)
      setDubError('')
    } else {
      setMediaInfo(null)
      setSubtitles([])
      setSubtitlesLoaded(false)
      setDubResult(null)
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

  // H.264 변환 실행
  async function handleConvertH264() {
    if (!currentFile) return
    setConverting(true)
    try {
      const res = await fetch('/api/editor/convert-h264', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: currentFile }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'H.264 변환 실패')
      }
      const data = await res.json()
      loadFiles()
      handleSelectFile(data.output_file)
    } catch (e) {
      alert('변환 중 오류: ' + e.message)
    } finally {
      setConverting(false)
    }
  }

  // TTS 성우 목소리 미리듣기
  async function handlePreviewTTS() {
    const sampleText = subtitles[0]?.text || '안녕하세요! 빌 스튜디오 AI 내레이션 목소리 테스트입니다.'
    setPreviewing(true)
    try {
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sampleText,
          voice: selectedVoice,
          rate: ttsRate,
        }),
      })
      if (!res.ok) throw new Error('미리듣기 생성 실패')
      const blob = await res.blob()
      const audioUrl = URL.createObjectURL(blob)
      const audio = new Audio(audioUrl)
      audio.play()
    } catch (e) {
      alert(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  // AI 내레이션 더빙 영상 생성
  async function handleDubVideo() {
    if (!currentFile) return
    if (subtitles.length === 0) {
      alert('더빙할 자막 대본이 없습니다. 먼저 [🎙️ AI 자막] 탭에서 자막을 추출해주세요.')
      setActiveTab('subtitle')
      return
    }

    setDubbing(true)
    setDubError('')
    setDubResult(null)

    try {
      const res = await fetch('/api/tts/dub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          voice: selectedVoice,
          rate: ttsRate,
          original_volume: origVolume,
          tts_volume: 1.0,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '더빙 영상 제작에 실패했습니다.')
      }

      const data = await res.json()
      setDubResult(data)
      loadFiles()
    } catch (e) {
      setDubError(e.message)
    } finally {
      setDubbing(false)
    }
  }

  // 기존 저장된 자막 불러오기


  async function loadExistingSubtitles(filename) {
    setSubError('')
    try {
      const res = await fetch(`/api/subtitle/get?file=${encodeURIComponent(filename)}`)
      if (res.ok) {
        const data = await res.json()
        if (data.exists && data.segments) {
          setSubtitles(data.segments)
          setSubtitlesLoaded(true)
        } else {
          setSubtitles([])
          setSubtitlesLoaded(false)
        }
      }
    } catch {
      setSubtitles([])
      setSubtitlesLoaded(false)
    }
  }

  // AI 자막 추출 실행
  async function handleExtractSubtitles() {
    if (!currentFile) return
    setExtractingSubs(true)
    setSubError('')
    try {
      const res = await fetch('/api/subtitle/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          model_size: subsModel,
          language: 'ko',
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '자막 추출에 실패했습니다.')
      }

      const data = await res.json()
      setSubtitles(data.segments || [])
      setSubtitlesLoaded(true)
    } catch (e) {
      setSubError(e.message)
    } finally {
      setExtractingSubs(false)
    }
  }

  // 자막 수정 내용 저장
  async function handleSaveSubtitles() {
    if (!currentFile || subtitles.length === 0) return
    setSavingSubs(true)
    try {
      const res = await fetch('/api/subtitle/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          segments: subtitles,
        }),
      })
      if (res.ok) {
        setSubsSavedNotice(true)
        setTimeout(() => setSubsSavedNotice(false), 2500)
      }
    } catch (e) {
      alert('자막 저장 실패: ' + e.message)
    } finally {
      setSavingSubs(false)
    }
  }

  function handleSegmentTextChange(idx, newText) {
    const updated = [...subtitles]
    updated[idx] = { ...updated[idx], text: newText }
    setSubtitles(updated)
  }

  function handleSeekTo(sec) {
    if (videoRef.current) {
      videoRef.current.currentTime = sec
      videoRef.current.play().catch(() => {})
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
      loadFiles()
    } catch (e) {
      setCutError(e.message)
    } finally {
      setCutting(false)
    }
  }

  // 현재 시간에 일치하는 자막 세그먼트
  const activeSegment = subtitles.find(
    (s) => currentTime >= s.start && currentTime <= s.end
  )

  return (
    <div className="editor-page">
      {/* 상단 네비게이션 */}
      <div className="editor-topbar">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/downloader')}>
          ← 다운로더로 돌아가기
        </button>
        {currentFile && (
          <div className="topbar-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setSearchParams({})}>
              📂 다른 영상 선택
            </button>
          </div>
        )}
      </div>

      {!currentFile ? (
        /* 파일 선택 화면 */
        <div className="card file-picker-card">
          <div className="picker-header">
            <h2>🎬 편집할 영상을 선택하세요</h2>
            <p>다운로드된 영상 목록에서 편집 및 자막을 생성할 파일을 클릭하세요.</p>
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

                {/* 브라우저 비호환 코덱(VP9/Opus in MP4) 자동 감지 및 1초 변환 안내 */}
                {mediaInfo?.is_browser_friendly === false && (
                  <div className="codec-warning-banner">
                    <div className="codec-warning-info">
                      <span className="warning-icon">⚠️</span>
                      <div>
                        <strong>브라우저 비호환 코덱 감지 ({mediaInfo.video?.codec || 'VP9'})</strong>
                        <p>현재 영상은 Safari 등 일부 브라우저에서 재생이 원활하지 않을 수 있습니다.</p>
                      </div>
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={handleConvertH264}
                      disabled={converting}
                    >
                      {converting ? '⚡ 초고속 변환 중...' : '⚡ 브라우저 호환 H.264로 변환'}
                    </button>
                  </div>
                )}

                {/* 플레이어 래퍼 */}
                <div className="video-wrapper">
                  <video
                    ref={videoRef}
                    key={mediaInfo?.url}
                    className="video-player"
                    controls
                    preload="auto"
                    src={mediaInfo?.url}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                  />
                </div>


                {/* 💬 핵심 기능: 영상 밑 실시간 자막 디스플레이 바 */}
                <div className="subtitle-display-container">
                  <div className="subtitle-display-header">
                    <span className="sub-title-tag">
                      💬 실시간 자막 {subtitlesLoaded ? `(${subtitles.length}문장)` : ''}
                    </span>
                    <div className="sub-display-actions">
                      <button
                        className={`sub-toggle-btn ${showSubtitles ? 'active' : ''}`}
                        onClick={() => setShowSubtitles(!showSubtitles)}
                        title="자막 표시 토글"
                      >
                        {showSubtitles ? '👁️ 자막 켜짐' : '🚫 자막 숨김'}
                      </button>
                    </div>
                  </div>

                  {showSubtitles && (
                    <div className={`live-subtitle-bar ${activeSegment ? 'active' : 'idle'}`}>
                      {activeSegment ? (
                        <span className="subtitle-active-text">{activeSegment.text}</span>
                      ) : (
                        <span className="subtitle-placeholder">
                          {subtitlesLoaded
                            ? '⋯ (음성 대기 중)'
                            : '자막이 아직 없습니다. 아래에서 [AI 자막 추출]을 눌러보세요.'}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="playback-status">
                  <span>현재 위치: <strong>{formatSeconds(currentTime)}</strong></span>
                  <span>전체 길이: <strong>{formatSeconds(duration)}</strong></span>
                </div>
              </div>

              {/* 하단 탭 메뉴: AI 자막 / AI 더빙 / 구간 자르기 */}
              <div className="tab-nav">
                <button
                  className={`tab-btn ${activeTab === 'subtitle' ? 'active' : ''}`}
                  onClick={() => setActiveTab('subtitle')}
                >
                  🎙️ AI 자막 {subtitlesLoaded && `(${subtitles.length})`}
                </button>
                <button
                  className={`tab-btn ${activeTab === 'tts' ? 'active' : ''}`}
                  onClick={() => setActiveTab('tts')}
                >
                  🗣️ AI 내레이션 더빙 (TTS)
                </button>
                <button
                  className={`tab-btn ${activeTab === 'cut' ? 'active' : ''}`}
                  onClick={() => setActiveTab('cut')}
                >
                  ✂️ 구간 자르기 (Fast Cut)
                </button>
              </div>


              {/* 탭 1: AI 자막 패널 */}
              {activeTab === 'subtitle' && (
                <div className="card subtitle-panel-card">
                  <div className="sub-panel-header">
                    <div>
                      <h3>🎙️ AI 음성인식 자막 스크립트</h3>
                      <p className="tool-desc">
                        로컬 AI가 한국어 음성을 문장 단위로 자동 추출하며, 클릭 시 해당 시간대로 점프합니다.
                      </p>
                    </div>

                    <div className="sub-header-controls">
                      {!subtitlesLoaded && (
                        <div className="model-selector-row">
                          <label>모델:</label>
                          <select
                            className="input select-input"
                            value={subsModel}
                            onChange={(e) => setSubsModel(e.target.value)}
                            disabled={extractingSubs}
                          >
                            <option value="tiny">초고속 (tiny)</option>
                            <option value="base">표준 추천 (base)</option>
                            <option value="small">고정밀 (small)</option>
                          </select>
                          <button
                            className="btn btn-primary"
                            onClick={handleExtractSubtitles}
                            disabled={extractingSubs}
                          >
                            {extractingSubs ? '⏳ AI 음성 분석 중...' : '✨ AI 자막 추출하기'}
                          </button>
                        </div>
                      )}

                      {subtitlesLoaded && (
                        <div className="sub-loaded-actions">
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={handleExtractSubtitles}
                            disabled={extractingSubs}
                          >
                            {extractingSubs ? '⏳ 재추출 중...' : '🔄 다시 추출'}
                          </button>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={handleSaveSubtitles}
                            disabled={savingSubs}
                          >
                            {savingSubs ? '💾 저장 중...' : '💾 자막 저장'}
                          </button>
                          <a
                            className="btn btn-secondary btn-sm"
                            href={`/api/subtitle/export/srt?file=${encodeURIComponent(currentFile)}`}
                            download
                          >
                            📥 .SRT 다운로드
                          </a>
                        </div>
                      )}
                    </div>
                  </div>

                  {subsSavedNotice && (
                    <div className="notice-banner success">
                      ✅ 자막 수정 내용이 성공적으로 저장되었습니다!
                    </div>
                  )}

                  {subError && <p className="error-msg">❌ {subError}</p>}

                  {extractingSubs && (
                    <div className="extracting-box">
                      <div className="spinner"></div>
                      <p>로컬 AI(Whisper)가 영상의 음성을 한글로 변환하는 중입니다...</p>
                      <span className="extracting-hint">영상 길이에 따라 수 초~수십 초 소요됩니다.</span>
                    </div>
                  )}

                  {/* 전체 자막 스크립트 목록 */}
                  {subtitlesLoaded && subtitles.length > 0 && (
                    <div className="script-container" ref={scriptListRef}>
                      <div className="script-list">
                        {subtitles.map((seg, idx) => {
                          const isActive = currentTime >= seg.start && currentTime <= seg.end
                          return (
                            <div
                              key={seg.id || idx}
                              ref={isActive ? activeSegmentRef : null}
                              className={`script-item ${isActive ? 'active' : ''}`}
                            >
                              <button
                                className="script-time-btn"
                                onClick={() => handleSeekTo(seg.start)}
                                title="이 시간대로 영상 재생 이동"
                              >
                                ⏱ {formatSeconds(seg.start)}
                              </button>

                              <input
                                className="script-text-input"
                                value={seg.text}
                                onChange={(e) => handleSegmentTextChange(idx, e.target.value)}
                                placeholder="자막 내용 입력..."
                              />

                              <span className="script-dur">
                                {formatSeconds(seg.end)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {!subtitlesLoaded && !extractingSubs && (
                    <div className="empty-sub-state">
                      <span className="empty-sub-icon">🎙️</span>
                      <h4>아직 생성된 자막이 없습니다</h4>
                      <p>위의 <strong>[✨ AI 자막 추출하기]</strong> 버튼을 누르면 영상의 음성을 즉시 한글 자막으로 만듭니다.</p>
                    </div>
                  )}
                </div>
              )}

              {/* 탭 2: AI 내레이션 더빙 (TTS) 패널 */}
              {activeTab === 'tts' && (
                <div className="card tts-panel-card">
                  <div className="tts-panel-header">
                    <div>
                      <h3>🗣️ AI 내레이션 자동 더빙</h3>
                      <p className="tool-desc">
                        추출된 자막 대본을 고품질 한국어 AI 성우 목소리로 읽어 원본 영상의 오디오와 믹싱합니다.
                      </p>
                    </div>
                    {subtitles.length > 0 && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={handlePreviewTTS}
                        disabled={previewing}
                      >
                        {previewing ? '🔊 음성 생성 중...' : '🎧 목소리 미리듣기'}
                      </button>
                    )}
                  </div>

                  {subtitles.length === 0 ? (
                    <div className="empty-sub-state">
                      <span className="empty-sub-icon">📝</span>
                      <h4>더빙할 자막 대본이 없습니다</h4>
                      <p>먼저 <strong>[🎙️ AI 자막]</strong> 탭에서 자막을 추출하거나 생성해주세요.</p>
                      <button className="btn btn-primary" onClick={() => setActiveTab('subtitle')}>
                        🎙️ AI 자막 탭으로 이동
                      </button>
                    </div>
                  ) : (
                    <div className="tts-controls-wrapper">
                      {/* 성우 선택 */}
                      <div className="tts-section">
                        <label className="section-label">👩 성우 목소리 선택</label>
                        <div className="voice-grid">
                          {voices.map((v) => (
                            <div
                              key={v.id}
                              className={`voice-card ${selectedVoice === v.id ? 'selected' : ''}`}
                              onClick={() => setSelectedVoice(v.id)}
                            >
                              <div className="voice-card-header">
                                <span className="voice-name">{v.name}</span>
                                <span className="voice-tag">{v.gender === 'Female' ? '여성' : '남성'}</span>
                              </div>
                              <p className="voice-desc">{v.desc}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 오디오 믹싱 & 속도 조절 */}
                      <div className="tts-settings-grid">
                        <div className="setting-box">
                          <label className="setting-label">
                            🔊 원본 영상 배경음 (BGM) 볼륨: <strong>{Math.round(origVolume * 100)}%</strong>
                          </label>
                          <input
                            type="range"
                            min="0"
                            max="0.5"
                            step="0.05"
                            className="range-input"
                            value={origVolume}
                            onChange={(e) => setOrigVolume(parseFloat(e.target.value))}
                          />
                          <div className="range-hints">
                            <span>0% (음소거)</span>
                            <span>15% (추천 은은한 BGM)</span>
                            <span>50%</span>
                          </div>
                        </div>

                        <div className="setting-box">
                          <label className="setting-label">⚡ 말하기 속도</label>
                          <select
                            className="input select-input full-width"
                            value={ttsRate}
                            onChange={(e) => setTtsRate(e.target.value)}
                          >
                            <option value="-10%">차분하게 느림 (-10%)</option>
                            <option value="+0%">보통 표준 속도 (+0%)</option>
                            <option value="+10%">생동감 있는 추천 (+10%)</option>
                            <option value="+20%">빠른 쇼츠 속도 (+20%)</option>
                          </select>
                          <p className="setting-hint">유튜브 쇼츠 영상은 +10% ~ +20% 속도를 추천합니다.</p>
                        </div>
                      </div>

                      {/* 더빙 실행 버튼 */}
                      <div className="tts-action-row">
                        <button
                          className="btn btn-accent-glow dub-start-btn"
                          onClick={handleDubVideo}
                          disabled={dubbing}
                        >
                          {dubbing ? '⏳ AI 음성 생성 및 오디오 믹싱 중...' : '✨ AI 내레이션 더빙 영상 제작'}
                        </button>
                      </div>

                      {dubError && <p className="error-msg">❌ {dubError}</p>}

                      {/* 제작 완료 카드 */}
                      {dubResult && (
                        <div className="cut-success-box dub-success-box">
                          <div className="success-icon">🎉</div>
                          <div className="success-info">
                            <strong>AI 내레이션 더빙 영상 제작 완료!</strong>
                            <p>새 영상: <code>{dubResult.output_file}</code> ({formatSize(dubResult.output_size)})</p>
                          </div>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleSelectFile(dubResult.output_file)}
                          >
                            🎬 더빙된 영상 바로 열기
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 탭 3: 구간 자르기 패널 */}
              {activeTab === 'cut' && (

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
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

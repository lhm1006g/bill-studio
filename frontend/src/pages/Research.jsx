/**
 * Phase: YouTube Content Research & Benchmarking (콘텐츠 발굴 & 리서치)
 * - 유튜브 실시간 검색 및 떡상 영상 탐색 (yt-dlp)
 * - Gemini 3.8 Flash 기반 원클릭 AI 벤치마킹 기획 (흥행요인 + 쇼츠 3종 기획 + 3초 후킹 멘트 + 60초 대본 구조)
 * - 스튜디오 다운로더 & 편집기 원클릭 연동
 * - 나만의 영감 보관함 (Idea Board)
 */
import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import './Research.css'

const API = 'http://localhost:8000/api/research'

const STUDIO_CHANNELS = [
  { id: 'humanity', name: '💧 인류애 & 감동 실화', query: '감동적인 동영상', desc: '선행, 인류애, 감동 실화', color: '#38bdf8' },
  { id: 'sports', name: '⚡ 스포츠 명장면 & 리스펙트', query: '스포츠 명장면 쇼츠', desc: '페어플레이, 역전극, 매너 순간', color: '#f59e0b' },
  { id: 'animals', name: '🐾 동물 구조 & 힐링', query: '귀여운 동물 감동 쇼츠', desc: '유기견 구조, 감동 교감', color: '#10b981' },
  { id: 'tech', name: '🧠 미래 테크 & 글로벌 머니', query: '반도체 AI 엔비디아 뉴스', desc: 'AI, 빅테크 혁신 데모', color: '#a855f7' },
]

export default function Research() {
  const navigate = useNavigate()

  // ─── 상태 ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('search') // search | board
  const [selectedChannel, setSelectedChannel] = useState('humanity')
  const [searchQuery, setSearchQuery] = useState('감동적인 동영상')
  const [sortBy, setSortBy] = useState('views') // views | relevance
  const [isLoading, setIsLoading] = useState(false)
  const [videos, setVideos] = useState([])
  const [ideas, setIdeas] = useState([])
  const [selectedCategory, setSelectedCategory] = useState('전체')

  const [foreignOnly, setForeignOnly] = useState(true) // 기본값: 해외 순수 원본 (한글자막 없음) 모드
  const [actualQuery, setActualQuery] = useState('')

  // AI 벤치마킹 분석 모달
  const [showAiModal, setShowAiModal] = useState(false)
  const [targetVideo, setTargetVideo] = useState(null)
  const [aiAnalysisText, setAiAnalysisText] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const abortRef = useRef(null)

  // 보관함 저장 모달
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [saveCategory, setSaveCategory] = useState('감동 실화')
  const [saveNotes, setSaveNotes] = useState('')

  // 토스트
  const [toast, setToast] = useState({ show: false, msg: '', type: 'info' })

  // ─── 초기 로딩 ──────────────────────────────────────────────────────
  useEffect(() => {
    handleSearch('감동적인 동영상', true)
    loadIdeas()
  }, [])

  const showToast = (msg, type = 'info') => {
    setToast({ show: true, msg, type })
    setTimeout(() => setToast(t => ({ ...t, show: false })), 3000)
  }

  // ─── 유튜브 검색 ──────────────────────────────────────────────────
  const handleSearch = async (overrideQuery = null, overrideForeignOnly = null) => {
    const q = (overrideQuery !== null ? overrideQuery : searchQuery).trim()
    if (!q) return

    const isForeign = overrideForeignOnly !== null ? overrideForeignOnly : foreignOnly
    setIsLoading(true)
    if (overrideQuery !== null) setSearchQuery(q)

    try {
      const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}&sort=${sortBy}&foreign_only=${isForeign}&limit=24`)
      if (!res.ok) throw new Error('검색 실패')
      const data = await res.json()
      setVideos(data.results || [])
      setActualQuery(data.actual_query || '')
    } catch (e) {
      showToast('❌ 영상 검색에 실패했습니다: ' + e.message, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  // ─── 영감 보관함 로드 ──────────────────────────────────────────────
  const loadIdeas = async () => {
    try {
      const res = await fetch(`${API}/ideas`)
      const data = await res.json()
      setIdeas(data)
    } catch (e) {
      console.error(e)
    }
  }

  // ─── AI 벤치마킹 분석 시작 (스트리밍) ───────────────────────────────
  const handleOpenAiAnalysis = async (video) => {
    setTargetVideo(video)
    setAiAnalysisText('')
    setShowAiModal(true)
    setIsAnalyzing(true)

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: video.id,
          title: video.title,
          channel: video.channel,
          views: video.views_formatted || String(video.view_count || ''),
          url: video.url,
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error('AI 분석 서버 오류')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6)
          if (payload === '[DONE]') break

          try {
            const data = JSON.parse(payload)
            if (data.type === 'token') {
              setAiAnalysisText(prev => prev + data.text)
            } else if (data.type === 'done') {
              if (data.full_text) setAiAnalysisText(data.full_text)
            } else if (data.type === 'error') {
              setAiAnalysisText(prev => prev + '\n\n⚠️ 오류: ' + data.message)
            }
          } catch {
            /* 파싱 패스 */
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setAiAnalysisText('⚠️ AI 분석 중 문제가 발생했습니다: ' + e.message)
      }
    } finally {
      setIsAnalyzing(false)
      abortRef.current = null
    }
  }

  // ─── 스튜디오 다운로더로 직행 ──────────────────────────────────────
  const handleGoDownloader = (videoUrl) => {
    navigate(`/downloader?url=${encodeURIComponent(videoUrl)}&channel=${selectedChannel}`)
  }

  // ─── 보관함에 저장하기 ──────────────────────────────────────────────
  const handleOpenSaveModal = (video) => {
    setTargetVideo(video)
    setSaveCategory('감동 실화')
    setSaveNotes('')
    setShowSaveModal(true)
  }

  const handleSaveToBoard = async () => {
    if (!targetVideo) return
    try {
      const res = await fetch(`${API}/ideas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: targetVideo.id,
          title: targetVideo.title,
          channel: targetVideo.channel,
          views: targetVideo.view_count || 0,
          duration: targetVideo.duration_formatted || targetVideo.duration || '',
          thumbnail: targetVideo.thumbnail,
          url: targetVideo.url,
          category: saveCategory,
          notes: saveNotes,
          ai_analysis: aiAnalysisText || '',
        }),
      })
      if (!res.ok) throw new Error('저장 실패')
      showToast('📌 영감 보관함에 저장되었습니다!', 'success')
      setShowSaveModal(false)
      await loadIdeas()
    } catch (e) {
      showToast('❌ 저장 실패: ' + e.message, 'error')
    }
  }

  const handleDeleteIdea = async (ideaId, e) => {
    e.stopPropagation()
    if (!confirm('이 보관된 아이디어를 삭제할까요?')) return
    try {
      await fetch(`${API}/ideas/${ideaId}`, { method: 'DELETE' })
      showToast('삭제되었습니다.', 'info')
      await loadIdeas()
    } catch (e) {
      showToast('❌ 삭제 실패', 'error')
    }
  }

  // 보관함 카테고리 목록
  const ideaCategories = ['전체', ...new Set(ideas.map(i => i.category || '일반'))]
  const filteredIdeas = selectedCategory === '전체'
    ? ideas
    : ideas.filter(i => i.category === selectedCategory)

  return (
    <div className="research-page">
      {/* ═══ 상단 헤더 & 검색 바 ═══ */}
      <header className="research-header">
        <div className="research-header-top">
          <div className="header-titles">
            <h1>💡 유튜브 콘텐츠 발굴 & 기획실</h1>
            <p>
              시청자를 사로잡은 실시간 떡상 영상을 탐색하고, <strong>Gemini 3.8 Flash</strong>와 함께 나만의 쇼츠 킬러 콘텐츠를 기획해보세요.
            </p>
          </div>

          {/* 탭 전환 */}
          <div className="research-tabs">
            <button
              className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`}
              onClick={() => setActiveTab('search')}
            >
              🔍 영상 탐색
            </button>
            <button
              className={`tab-btn ${activeTab === 'board' ? 'active' : ''}`}
              onClick={() => setActiveTab('board')}
            >
              📌 영감 보관함 ({ideas.length})
            </button>
          </div>
        </div>

        {/* 내 운영 채널 레이더 선택기 */}
        <div className="channel-radar-bar">
          <span className="radar-label">📡 타겟 채널 레이더:</span>
          <div className="radar-channels-list">
            {STUDIO_CHANNELS.map(ch => (
              <button
                key={ch.id}
                type="button"
                className={`radar-channel-btn ${selectedChannel === ch.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedChannel(ch.id)
                  setSearchQuery(ch.query)
                  handleSearch(ch.query)
                }}
                style={{
                  '--channel-color': ch.color,
                }}
                title={`${ch.name} - ${ch.desc}`}
              >
                <span className="channel-title">{ch.name}</span>
                <span className="channel-desc">{ch.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 검색 폼 (탐색 탭일 때) */}
        {activeTab === 'search' && (
          <div className="research-search-section">
            <div className="search-bar-row">
              <div className="search-input-wrapper">
                <span className="search-icon">🔍</span>
                <input
                  type="text"
                  className="search-input"
                  placeholder="벤치마킹할 주제나 키워드를 입력하세요 (예: 감동적인 동영상, 해외 감동 실화, 스포츠 쇼츠...)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
              </div>

              {/* 해외 순수 원본 (한글자막 없음) 필터 토글 */}
              <button
                type="button"
                className={`foreign-toggle-btn ${foreignOnly ? 'active' : ''}`}
                onClick={() => {
                  const nextState = !foreignOnly
                  setForeignOnly(nextState)
                  handleSearch(null, nextState)
                }}
                title="한글 자막이 이미 각인된 2차 편집 영상은 제외하고, 100% 순수 해외 원작 영상만 찾습니다."
              >
                <span className="toggle-icon">{foreignOnly ? '🌐' : '🇰🇷'}</span>
                <span className="toggle-text">
                  {foreignOnly ? '해외 순수 원본 (자막 없음)' : '국내/해외 전체 탐색'}
                </span>
                <span className={`toggle-pill ${foreignOnly ? 'on' : 'off'}`} />
              </button>

              <select
                className="sort-select"
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value)
                  setTimeout(() => handleSearch(), 50)
                }}
              >
                <option value="views">🔥 조회수 높은순 (인기순)</option>
                <option value="relevance">🎯 관련도순</option>
              </select>

              <button
                className="search-submit-btn"
                onClick={() => handleSearch()}
                disabled={isLoading}
              >
                {isLoading ? '검색 중...' : '영상 발굴'}
              </button>
            </div>

            {/* 해외 원본 영문 자동 변환 힌트 배너 */}
            {foreignOnly && actualQuery && (
              <div className="actual-query-hint">
                <span className="hint-icon">💡</span>
                <span className="hint-text">
                  <strong>순수 해외 원본 발굴 모드 가동 중:</strong> 한글 2차 가공물(자막 영상)을 배제하고 글로벌 원작 영상 타겟 영문 <strong>"{actualQuery}"</strong>으로 실시간 검색했습니다. (한글 자막 없는 깨끗한 클린 원본)
                </span>
              </div>
            )}
          </div>
        )}

        {/* 보관함 탭일 때 카테고리 필터 */}
        {activeTab === 'board' && (
          <div className="board-filter-row">
            <span className="chips-label">카테고리:</span>
            <div className="chips-list">
              {ideaCategories.map(cat => (
                <button
                  key={cat}
                  className={`preset-chip ${selectedCategory === cat ? 'active' : ''}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      {/* ═══ 메인 콘텐츠 영역 ═══ */}
      <main className="research-content">
        {/* 탭 1: 유튜브 영상 탐색 그리드 */}
        {activeTab === 'search' && (
          <>
            {isLoading ? (
              <div className="research-loading">
                <div className="spinner" />
                <p>유튜브에서 인기 떡상 영상을 발굴하는 중입니다...</p>
              </div>
            ) : videos.length === 0 ? (
              <div className="research-empty">
                <span className="empty-icon">📺</span>
                <h3>검색된 영상이 없습니다.</h3>
                <p>다른 검색어를 입력하거나 위의 추천 탐색 키워드를 눌러보세요.</p>
              </div>
            ) : (
              <div className="video-grid">
                {videos.map(video => (
                  <div key={video.id} className="video-card">
                    {/* 썸네일 & 재생시간 */}
                    <div className="video-thumb-wrapper">
                      <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="video-thumb"
                        loading="lazy"
                        onError={(e) => {
                          e.target.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
                        }}
                      />
                      {video.duration_formatted && (
                        <span className="video-duration">{video.duration_formatted}</span>
                      )}
                      {video.is_foreign && (
                        <span className="foreign-badge" title="한글 자막이 각인되지 않은 100% 순수 해외 원작 영상입니다.">
                          🌐 해외 원본 (자막 없음)
                        </span>
                      )}
                      <a
                        href={video.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="play-overlay"
                        title="유튜브 원본 보기"
                      >
                        ▶
                      </a>
                    </div>

                    {/* 카드 정보 */}
                    <div className="video-info">
                      <h3 className="video-title" title={video.title}>
                        <a href={video.url} target="_blank" rel="noopener noreferrer">
                          {video.title}
                        </a>
                      </h3>

                      <div className="video-meta">
                        <span className="video-channel">👤 {video.channel}</span>
                        <span className="video-views">🔥 {video.views_formatted}</span>
                      </div>

                      {/* 3대 핵심 액션 버튼 */}
                      <div className="video-card-actions">
                        <button
                          className="action-btn ai-plan"
                          onClick={() => handleOpenAiAnalysis(video)}
                          title="Gemini AI로 흥행요인 분석 & 쇼츠 기획안 작성"
                        >
                          💡 AI 벤치마킹
                        </button>
                        <button
                          className="action-btn download"
                          onClick={() => handleGoDownloader(video.url)}
                          title="Bill Studio 다운로더로 다운로드"
                        >
                          ⬇️ 다운로드
                        </button>
                        <button
                          className="action-btn scrap"
                          onClick={() => handleOpenSaveModal(video)}
                          title="영감 보관함에 스크랩"
                        >
                          📌 보관
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* 탭 2: 나만의 영감 보관함 (Idea Board) */}
        {activeTab === 'board' && (
          <>
            {filteredIdeas.length === 0 ? (
              <div className="research-empty">
                <span className="empty-icon">📌</span>
                <h3>보관된 아이디어가 없습니다.</h3>
                <p>영상 탐색 탭에서 마음에 드는 떡상 영상을 찾아 [📌 보관] 버튼을 눌러보세요.</p>
              </div>
            ) : (
              <div className="video-grid">
                {filteredIdeas.map(idea => (
                  <div key={idea.id} className="video-card idea-card">
                    <div className="video-thumb-wrapper">
                      <img src={idea.thumbnail} alt={idea.title} className="video-thumb" />
                      {idea.duration && <span className="video-duration">{idea.duration}</span>}
                      <span className="idea-cat-badge">{idea.category}</span>
                    </div>

                    <div className="video-info">
                      <h3 className="video-title">{idea.title}</h3>
                      <div className="video-meta">
                        <span className="video-channel">{idea.channel}</span>
                        <span className="video-date">{idea.created_at?.slice(0, 10)}</span>
                      </div>

                      {idea.notes && (
                        <div className="idea-notes">
                          💬 {idea.notes}
                        </div>
                      )}

                      <div className="video-card-actions">
                        <button
                          className="action-btn ai-plan"
                          onClick={() => handleOpenAiAnalysis(idea)}
                        >
                          💡 AI 기획 다시보기
                        </button>
                        <button
                          className="action-btn download"
                          onClick={() => handleGoDownloader(idea.url)}
                        >
                          ⬇️ 다운로드
                        </button>
                        <button
                          className="action-btn delete"
                          onClick={(e) => handleDeleteIdea(idea.id, e)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* ═══ AI 벤치마킹 분석 모달 ═══ */}
      {showAiModal && (
        <div className="research-modal-overlay" onClick={() => setShowAiModal(false)}>
          <div className="research-modal ai-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-title">
                <span className="modal-badge">Gemini 3.8 Flash</span>
                <h2>💡 AI 벤치마킹 & 쇼츠 콘텐츠 기획안</h2>
              </div>
              <button className="modal-close-btn" onClick={() => setShowAiModal(false)}>✕</button>
            </div>

            {targetVideo && (
              <div className="target-video-summary">
                <img src={targetVideo.thumbnail} alt="" className="target-mini-thumb" />
                <div className="target-meta">
                  <div className="target-title">{targetVideo.title}</div>
                  <div className="target-sub">
                    <span>채널: {targetVideo.channel}</span>
                    <span>조회수: {targetVideo.views_formatted || targetVideo.views}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="modal-body ai-body">
              {isAnalyzing && !aiAnalysisText && (
                <div className="ai-thinking">
                  <div className="spinner" />
                  <p>Gemini 3.8 Flash가 영상의 흥행 요인을 분석하고 킬러 쇼츠 대본을 기획하고 있습니다...</p>
                </div>
              )}

              {aiAnalysisText && (
                <div className="ai-rendered-content">
                  <div className="ai-markdown-view">
                    {aiAnalysisText.split('\n').map((line, idx) => {
                      if (line.startsWith('## ')) return <h2 key={idx}>{line.replace('## ', '')}</h2>
                      if (line.startsWith('### ')) return <h3 key={idx}>{line.replace('### ', '')}</h3>
                      if (line.startsWith('- ') || line.startsWith('* ')) {
                        return <div key={idx} className="ai-bullet">• {line.replace(/^[-*]\s+/, '')}</div>
                      }
                      if (/^\d+\.\s+/.test(line)) {
                        return <div key={idx} className="ai-num-item">{line}</div>
                      }
                      if (!line.trim()) return <div key={idx} style={{ height: 8 }} />
                      return <p key={idx}>{line}</p>
                    })}
                  </div>
                  {isAnalyzing && <span className="streaming-cursor" />}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="modal-action-btn copy"
                onClick={() => {
                  navigator.clipboard.writeText(aiAnalysisText)
                  showToast('📋 기획안이 복사되었습니다!', 'success')
                }}
                disabled={!aiAnalysisText}
              >
                📋 기획안 전체 복사
              </button>

              {targetVideo && (
                <button
                  className="modal-action-btn primary"
                  onClick={() => {
                    setShowAiModal(false)
                    handleGoDownloader(targetVideo.url)
                  }}
                >
                  ⬇️ 이 영상 스튜디오로 다운로드하기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ 영감 보관함 저장 모달 ═══ */}
      {showSaveModal && (
        <div className="research-modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="research-modal save-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>📌 영감 보관함에 저장</h2>
              <button className="modal-close-btn" onClick={() => setShowSaveModal(false)}>✕</button>
            </div>

            <div className="modal-body">
              {targetVideo && (
                <div className="target-video-summary" style={{ marginBottom: 16 }}>
                  <img src={targetVideo.thumbnail} alt="" className="target-mini-thumb" />
                  <div className="target-meta">
                    <div className="target-title">{targetVideo.title}</div>
                    <div className="target-sub">{targetVideo.channel}</div>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label>카테고리 / 채널 주제</label>
                <input
                  type="text"
                  className="modal-input"
                  placeholder="예: 감동 실화, 스포츠 쇼츠, AI 테크 뉴스 등"
                  value={saveCategory}
                  onChange={(e) => setSaveCategory(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>내 메모 / 벤치마킹 아이디어</label>
                <textarea
                  className="modal-textarea"
                  rows={3}
                  placeholder="예: 25초 지점 포옹 장면에서 BGM 페이드아웃 효과 벤치마킹할 것"
                  value={saveNotes}
                  onChange={(e) => setSaveNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="modal-cancel-btn" onClick={() => setShowSaveModal(false)}>
                취소
              </button>
              <button className="modal-action-btn primary" onClick={handleSaveToBoard}>
                📌 보관함 저장
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 토스트 */}
      <div className={`research-toast ${toast.show ? 'show' : ''} ${toast.type}`}>
        {toast.msg}
      </div>
    </div>
  )
}

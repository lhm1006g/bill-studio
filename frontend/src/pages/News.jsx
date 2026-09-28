/**
 * Phase 6 - 뉴스 리서치 페이지
 * 3패널: 소스목록 | 기사리스트 | 기사상세+AI요약(스트리밍)
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import './News.css'

const API = 'http://localhost:8000/api/news'

// 날짜 포맷
function formatDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now - d
    const diffMin = Math.floor(diffMs / 60000)
    const diffHour = Math.floor(diffMin / 60)
    const diffDay = Math.floor(diffHour / 24)
    if (diffMin < 60) return `${diffMin}분 전`
    if (diffHour < 24) return `${diffHour}시간 전`
    if (diffDay < 7) return `${diffDay}일 전`
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

// AI 요약 텍스트 마크다운 렌더링 (간단 파싱)
function AiMarkdown({ text }) {
  const lines = text.split('\n')
  return (
    <div className="news-ai-text">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) {
          return <h2 key={i}>{line.replace('## ', '')}</h2>
        }
        if (line.startsWith('- ') || line.startsWith('• ')) {
          return <div key={i} style={{ paddingLeft: 8, marginBottom: 4 }}>{line}</div>
        }
        if (/^\d+\. /.test(line)) {
          return <div key={i} style={{ paddingLeft: 8, marginBottom: 4 }}>{line}</div>
        }
        return <div key={i}>{line}</div>
      })}
    </div>
  )
}

export default function News() {
  // ─── 상태 ────────────────────────────────────────────────────
  const [sources, setSources] = useState([])
  const [articles, setArticles] = useState([])
  const [selectedSource, setSelectedSource] = useState(null) // null = 전체
  const [selectedStock, setSelectedStock] = useState(null) // null = 전체, '__all__' = 모든 관심종목, 또는 종목명('삼성전자' 등)
  const [selectedArticle, setSelectedArticle] = useState(null)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [showBookmarked, setShowBookmarked] = useState(false)
  const [counts, setCounts] = useState({ total: 0, unread: 0, bookmarked: 0, stocks: 0 })
  const [trends, setTrends] = useState([])
  const [isFetching, setIsFetching] = useState(false)
  const [isLoadingArticles, setIsLoadingArticles] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showAddStockModal, setShowAddStockModal] = useState(false)
  const [isRescanning, setIsRescanning] = useState(false)
  const [toast, setToast] = useState({ show: false, msg: '', type: 'info' })

  // 관심 종목 (워치리스트)
  const [watchlist, setWatchlist] = useState([])
  const [newStock, setNewStock] = useState({ name: '', keywords: '', icon: '📊', color: '#8b5cf6' })

  // AI 요약
  const [aiText, setAiText] = useState('')
  const [aiStatus, setAiStatus] = useState('idle') // idle | loading | done | error | cached
  const [aiKeywords, setAiKeywords] = useState([])
  const aiAbortRef = useRef(null)

  // 소스 추가 모달 폼
  const [newSource, setNewSource] = useState({ name: '', url: '', category: 'IT/기술', icon: '📰' })

  // 날짜 기반 필터 및 데일리 브리핑
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(null) // null = 전체, 또는 'YYYY-MM-DD'
  const [showBriefingModal, setShowBriefingModal] = useState(false)
  const [briefingData, setBriefingData] = useState({ date: '', content: '', isLoading: false, isStreaming: false, error: '' })
  const briefingAbortRef = useRef(null)

  // 🎙️ AI 오디오 데일리 팟캐스트 상태
  const [showPodcastModal, setShowPodcastModal] = useState(false)
  const [podcastMode, setPodcastMode] = useState('deep') // 'deep' (7~10분) | 'quick' (3분)
  const [podcastVoice, setPodcastVoice] = useState('ko-KR-InJoonNeural') // 'ko-KR-InJoonNeural' | 'ko-KR-SunHiNeural'
  const [podcastData, setPodcastData] = useState(null)
  const [isPodcastLoading, setIsPodcastLoading] = useState(false)
  const [podcastError, setPodcastError] = useState('')
  const [podcastPlaybackRate, setPodcastPlaybackRate] = useState(1.0)
  const [isPlayingPodcast, setIsPlayingPodcast] = useState(false)
  const [podcastCurrentTime, setPodcastCurrentTime] = useState(0)
  const [podcastDuration, setPodcastDuration] = useState(0)
  const audioRef = useRef(null)

  // ─── 초기 데이터 로딩 ────────────────────────────────────────
  useEffect(() => {
    loadSources()
    loadCounts()
    loadTrends()
    loadWatchlist()
    loadDates()
  }, [])

  useEffect(() => {
    loadArticles()
  }, [selectedSource, selectedStock, showBookmarked, selectedDate])

  const loadDates = async () => {
    try {
      const res = await fetch(`${API}/dates`)
      if (res.ok) {
        const data = await res.json()
        setDates(data)
        // 기본값: 오늘 기사가 있으면 오늘, 오늘 기사가 0건이고 어제 기사가 있으면 어제를 기본 추천하거나 오늘 선택
        // 사용자 편의를 위해 첫 진입 시 '오늘' 날짜를 기본 선택
        if (data.length > 0 && selectedDate === null) {
          // 기사가 있는 가장 최근 일자 또는 오늘
          const todayItem = data.find(d => d.label === '오늘')
          const firstWithCount = data.find(d => d.total_count > 0)
          if (todayItem && todayItem.total_count > 0) {
            setSelectedDate(todayItem.date)
          } else if (firstWithCount) {
            setSelectedDate(firstWithCount.date)
          } else if (todayItem) {
            setSelectedDate(todayItem.date)
          }
        }
      }
    } catch (e) {
      console.error('날짜 목록 로드 실패:', e)
    }
  }

  const loadSources = async () => {
    try {
      const res = await fetch(`${API}/sources`)
      setSources(await res.json())
    } catch (e) {
      console.error(e)
    }
  }

  const loadWatchlist = async () => {
    try {
      const res = await fetch(`${API}/watchlist`)
      setWatchlist(await res.json())
    } catch (e) {
      console.error(e)
    }
  }

  const loadCounts = async () => {
    try {
      const res = await fetch(`${API}/articles/count`)
      setCounts(await res.json())
    } catch (e) {
      console.error(e)
    }
  }

  const loadTrends = async () => {
    try {
      const res = await fetch(`${API}/trends?limit=12`)
      setTrends(await res.json())
    } catch (e) {
      console.error(e)
    }
  }

  const loadArticles = useCallback(async () => {
    setIsLoadingArticles(true)
    try {
      const params = new URLSearchParams({ limit: 100 })
      if (selectedDate) params.set('date', selectedDate)
      if (selectedSource) params.set('source_id', selectedSource)
      if (selectedStock) params.set('stock', selectedStock)
      if (showBookmarked) params.set('bookmarked', 'true')
      if (searchKeyword) params.set('keyword', searchKeyword)
      const res = await fetch(`${API}/articles?${params}`)
      setArticles(await res.json())
    } catch (e) {
      console.error(e)
    } finally {
      setIsLoadingArticles(false)
    }
  }, [selectedSource, selectedStock, showBookmarked, searchKeyword, selectedDate])

  // 특정 날짜 전체 읽음 처리
  const handleMarkDateRead = async (dateStr) => {
    if (!dateStr) return
    try {
      const res = await fetch(`${API}/dates/${dateStr}/read-all`, { method: 'POST' })
      if (res.ok) {
        showToast(`✅ ${dateStr} 기사를 모두 읽음 처리했습니다.`, 'success')
        await loadArticles()
        await loadCounts()
        await loadDates()
      }
    } catch (e) {
      showToast('❌ 읽음 처리 실패: ' + e.message, 'error')
    }
  }

  // 데일리 AI 종합 브리핑 열기/생성
  const handleOpenBriefing = async (dateStr, force = false) => {
    const targetDate = dateStr || selectedDate
    if (!targetDate) return

    setShowBriefingModal(true)
    setBriefingData({ date: targetDate, content: '', isLoading: true, isStreaming: false, error: '' })

    if (briefingAbortRef.current) {
      briefingAbortRef.current.abort()
    }
    briefingAbortRef.current = new AbortController()

    try {
      const response = await fetch(`${API}/dates/${targetDate}/briefing?force=${force}`, {
        method: 'POST',
        signal: briefingAbortRef.current.signal
      })

      if (!response.ok) {
        throw new Error(`브리핑 요청 실패 (${response.status})`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let buffer = ''

      setBriefingData(prev => ({ ...prev, isLoading: false, isStreaming: true }))

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') break

          try {
            const parsed = JSON.parse(dataStr)
            if (parsed.error || (parsed.type === 'error' && parsed.message)) {
              setBriefingData(prev => ({
                ...prev,
                isStreaming: false,
                isLoading: false,
                error: parsed.error || parsed.message
              }))
              return
            } else if (parsed.type === 'cached' && parsed.text) {
              setBriefingData(prev => ({
                ...prev,
                content: parsed.text,
                isStreaming: false,
                isLoading: false
              }))
              loadDates()
              return
            } else if (parsed.type === 'token' && parsed.text) {
              accumulated += parsed.text
              setBriefingData(prev => ({ ...prev, content: accumulated }))
            } else if (parsed.type === 'done' && parsed.full_text) {
              accumulated = parsed.full_text
              setBriefingData(prev => ({ ...prev, content: accumulated }))
            }
          } catch {
            // JSON 파싱 실패 무시
          }
        }
      }

      setBriefingData(prev => ({
        ...prev,
        content: accumulated,
        isStreaming: false,
        isLoading: false
      }))
      loadDates()
    } catch (err) {
      if (err.name !== 'AbortError') {
        setBriefingData(prev => ({
          ...prev,
          isLoading: false,
          isStreaming: false,
          error: `⚠️ 오류가 발생했습니다: ${err.message}`
        }))
      }
    }
  }

  // ─── 🎙️ 팟캐스트 관련 핸들러 ──────────────────────────────
  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds)) return '00:00'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }

  const handleOpenPodcast = (dateStr) => {
    const targetDate = dateStr || selectedDate
    if (!targetDate) return
    setShowPodcastModal(true)
    setPodcastError('')
    fetchPodcastInfo(targetDate, podcastMode, podcastVoice)
  }

  const fetchPodcastInfo = async (dateStr, mode, voice) => {
    setIsPodcastLoading(true)
    setPodcastError('')
    try {
      const res = await fetch(`${API}/dates/${dateStr}/podcast?mode=${mode}&voice=${voice}`)
      if (res.ok) {
        const data = await res.json()
        setPodcastData(data)
      } else {
        setPodcastData(null)
      }
    } catch (e) {
      console.error('팟캐스트 조회 실패:', e)
      setPodcastError('팟캐스트 상태를 불러오지 못했습니다.')
    } finally {
      setIsPodcastLoading(false)
    }
  }

  const handleModeChange = (newMode) => {
    setPodcastMode(newMode)
    const targetDate = selectedDate || (dates.length > 0 ? dates[0].date : '')
    if (targetDate) {
      fetchPodcastInfo(targetDate, newMode, podcastVoice)
    }
  }

  const handleVoiceChange = (newVoice) => {
    setPodcastVoice(newVoice)
    const targetDate = selectedDate || (dates.length > 0 ? dates[0].date : '')
    if (targetDate) {
      fetchPodcastInfo(targetDate, podcastMode, newVoice)
    }
  }

  const handleGeneratePodcast = async (force = false) => {
    const targetDate = selectedDate || (dates.length > 0 ? dates[0].date : '')
    if (!targetDate) return

    setIsPodcastLoading(true)
    setPodcastError('')
    try {
      const res = await fetch(`${API}/dates/${targetDate}/podcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: podcastMode,
          voice: podcastVoice,
          force: force,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '팟캐스트 생성에 실패했습니다.')
      }

      const data = await res.json()
      setPodcastData({ ...data, exists: true })
      showToast('🎉 AI 라디오 팟캐스트 녹음이 완료되었습니다!', 'success')
    } catch (e) {
      setPodcastError(e.message)
      showToast('❌ ' + e.message, 'error')
    } finally {
      setIsPodcastLoading(false)
    }
  }

  const togglePlayPodcast = () => {
    if (!audioRef.current) return
    if (isPlayingPodcast) {
      audioRef.current.pause()
      setIsPlayingPodcast(false)
    } else {
      audioRef.current.play().then(() => {
        setIsPlayingPodcast(true)
      }).catch(err => {
        console.error('재생 실패:', err)
      })
    }
  }

  const seekPodcast = (diffSeconds) => {
    if (!audioRef.current) return
    const newTime = Math.max(0, Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + diffSeconds))
    audioRef.current.currentTime = newTime
    setPodcastCurrentTime(newTime)
  }

  const handleSeekChange = (e) => {
    const newTime = parseFloat(e.target.value)
    if (audioRef.current) {
      audioRef.current.currentTime = newTime
    }
    setPodcastCurrentTime(newTime)
  }

  const handleRateChange = (rate) => {
    setPodcastPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }

  // 검색 디바운스
  useEffect(() => {
    const t = setTimeout(() => loadArticles(), 350)
    return () => clearTimeout(t)
  }, [searchKeyword])

  // ─── RSS 수집 ─────────────────────────────────────────────────
  const handleFetch = async () => {
    setIsFetching(true)
    showToast('📡 RSS 수집 중...', 'info')
    try {
      const res = await fetch(`${API}/fetch`, { method: 'POST' })
      const data = await res.json()
      showToast(`✅ ${data.total_new}개 새 기사 수집 완료`, 'success')
      await loadArticles()
      await loadCounts()
      await loadTrends()
    } catch (e) {
      showToast('❌ 수집 실패: ' + e.message, 'error')
    } finally {
      setIsFetching(false)
    }
  }

  // ─── 기사 선택 + AI 요약 ──────────────────────────────────────
  const handleSelectArticle = async (article) => {
    // 읽음 처리
    if (!article.is_read) {
      fetch(`${API}/articles/${article.id}/read`, { method: 'PATCH' })
        .then(() => {
          setArticles(prev => prev.map(a => a.id === article.id ? { ...a, is_read: 1 } : a))
          setCounts(prev => ({ ...prev, unread: Math.max(0, prev.unread - 1) }))
        })
    }

    setSelectedArticle(article)
    setAiText('')
    setAiKeywords([])

    // 이전 스트림 중단
    if (aiAbortRef.current) aiAbortRef.current.abort()

    // 이미 AI 요약 있으면 바로 표시
    if (article.ai_summary) {
      setAiText(article.ai_summary)
      setAiStatus('cached')
      if (article.keywords) {
        setAiKeywords(article.keywords.split(',').map(k => k.trim()).filter(Boolean))
      }
      return
    }

    // AI 요약 스트리밍 시작
    await startAiSummary(article.id)
  }

  const startAiSummary = async (articleId) => {
    setAiStatus('loading')
    setAiText('')
    setAiKeywords([])

    const controller = new AbortController()
    aiAbortRef.current = controller

    try {
      const res = await fetch(`${API}/articles/${articleId}/summarize`, {
        signal: controller.signal,
      })

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
          if (payload === '[DONE]') {
            setAiStatus('done')
            continue
          }
          try {
            const data = JSON.parse(payload)
            if (data.type === 'token') {
              setAiText(prev => prev + data.text)
            } else if (data.type === 'cached') {
              setAiText(data.text)
              setAiStatus('cached')
              if (data.keywords) {
                setAiKeywords(data.keywords.split(',').map(k => k.trim()).filter(Boolean))
              }
            } else if (data.type === 'done') {
              setAiStatus('done')
              if (data.keywords) {
                setAiKeywords(data.keywords.split(',').map(k => k.trim()).filter(Boolean))
              }
            } else if (data.type === 'error') {
              setAiStatus('error')
              setAiText('⚠️ AI 요약 생성 실패: ' + data.message)
            }
          } catch { /* 무시 */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setAiStatus('error')
        setAiText('⚠️ 연결 오류: Ollama가 실행 중인지 확인하세요.\n\n`ollama serve` 명령어로 실행할 수 있습니다.')
      }
    }
  }

  // ─── 읽음 빠른 처리 (AI 요약 없이) ─────────────────────────
  const handleMarkRead = async (article, e) => {
    e.stopPropagation()  // 카드 클릭(AI 요약) 이벤트 차단
    const newRead = article.is_read ? 0 : 1
    try {
      await fetch(`${API}/articles/${article.id}/read`, { method: 'PATCH' })
      setArticles(prev =>
        prev.map(a => a.id === article.id ? { ...a, is_read: newRead } : a)
      )
      if (newRead === 1) {
        setCounts(prev => ({ ...prev, unread: Math.max(0, prev.unread - 1) }))
      } else {
        setCounts(prev => ({ ...prev, unread: prev.unread + 1 }))
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleBookmark = async (article, e) => {
    e.stopPropagation()
    try {
      const res = await fetch(`${API}/articles/${article.id}/bookmark`, { method: 'PATCH' })
      const data = await res.json()
      setArticles(prev =>
        prev.map(a => a.id === article.id ? { ...a, is_bookmarked: data.is_bookmarked } : a)
      )
      if (selectedArticle?.id === article.id) {
        setSelectedArticle(prev => ({ ...prev, is_bookmarked: data.is_bookmarked }))
      }
      await loadCounts()
      showToast(data.is_bookmarked ? '⭐ 북마크 추가됨' : '북마크 해제됨', 'info')
    } catch (e) {
      console.error(e)
    }
  }

  // ─── 소스 추가 ────────────────────────────────────────────────
  const handleAddSource = async () => {
    if (!newSource.name || !newSource.url) {
      showToast('이름과 URL을 입력해주세요.', 'error')
      return
    }
    try {
      const res = await fetch(`${API}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSource),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast('❌ ' + err.detail, 'error')
        return
      }
      showToast('✅ 소스가 추가되었습니다.', 'success')
      setShowAddModal(false)
      setNewSource({ name: '', url: '', category: 'IT/기술', icon: '📰' })
      await loadSources()
    } catch (e) {
      showToast('❌ 추가 실패: ' + e.message, 'error')
    }
  }

  // ─── 소스 삭제 ────────────────────────────────────────────────
  const handleDeleteSource = async (srcId, e) => {
    e.stopPropagation()
    if (!confirm('이 소스와 관련 기사를 모두 삭제할까요?')) return
    try {
      await fetch(`${API}/sources/${srcId}`, { method: 'DELETE' })
      showToast('소스가 삭제되었습니다.', 'info')
      if (selectedSource === srcId) setSelectedSource(null)
      await loadSources()
      await loadArticles()
      await loadCounts()
    } catch (e) {
      showToast('❌ 삭제 실패', 'error')
    }
  }

  // ─── 관심종목 추가 ───────────────────────────────────────────
  const handleAddStock = async () => {
    if (!newStock.name || !newStock.keywords) {
      showToast('종목명과 검색 키워드를 입력해주세요.', 'error')
      return
    }
    try {
      const res = await fetch(`${API}/watchlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newStock),
      })
      if (!res.ok) {
        const err = await res.json()
        showToast('❌ ' + err.detail, 'error')
        return
      }
      showToast(`✅ [${newStock.name}] 관심종목이 추가되었습니다.`, 'success')
      setShowAddStockModal(false)
      setNewStock({ name: '', keywords: '', icon: '📊', color: '#8b5cf6' })
      await loadWatchlist()
      await loadArticles()
      await loadCounts()
    } catch (e) {
      showToast('❌ 추가 실패: ' + e.message, 'error')
    }
  }

  // ─── 관심종목 삭제 ───────────────────────────────────────────
  const handleDeleteStock = async (stockId, stockName, e) => {
    e.stopPropagation()
    if (!confirm(`[${stockName}] 관심종목을 삭제할까요?`)) return
    try {
      await fetch(`${API}/watchlist/${stockId}`, { method: 'DELETE' })
      showToast(`[${stockName}] 관심종목이 삭제되었습니다.`, 'info')
      if (selectedStock === stockName) setSelectedStock(null)
      await loadWatchlist()
      await loadArticles()
      await loadCounts()
    } catch (e) {
      showToast('❌ 삭제 실패', 'error')
    }
  }

  // ─── 관심종목 전체 재스캔 ─────────────────────────────────────
  const handleRescanWatchlist = async () => {
    setIsRescanning(true)
    showToast('🔄 기사 키워드 재스캔 중...', 'info')
    try {
      const res = await fetch(`${API}/watchlist/rescan`, { method: 'POST' })
      const data = await res.json()
      showToast(`✅ ${data.matched_articles}개 기사에서 관심종목 매칭 완료`, 'success')
      await loadWatchlist()
      await loadArticles()
      await loadCounts()
    } catch (e) {
      showToast('❌ 재스캔 실패: ' + e.message, 'error')
    } finally {
      setIsRescanning(false)
    }
  }

  // ─── 토스트 ──────────────────────────────────────────────────
  const showToast = (msg, type = 'info') => {
    setToast({ show: true, msg, type })
    setTimeout(() => setToast(t => ({ ...t, show: false })), 3000)
  }

  // ─── 카테고리별 소스 그룹핑 ──────────────────────────────────
  const sourcesByCategory = sources.reduce((acc, src) => {
    if (!acc[src.category]) acc[src.category] = []
    acc[src.category].push(src)
    return acc
  }, {})

  // ─── 현재 선택된 뷰 이름 ──────────────────────────────────
  const currentViewTitle = selectedStock
    ? (selectedStock === '__all__' ? '📊 관심 종목 전체 뉴스' : `🎯 [${selectedStock}] 관련 뉴스`)
    : selectedSource
    ? (sources.find(s => s.id === selectedSource)?.name || '알 수 없음')
    : showBookmarked ? '⭐ 북마크' : '📰 전체 뉴스'

  // ─── 렌더 ─────────────────────────────────────────────────────
  return (
    <div className="news-page">

      {/* ═══ 왼쪽: 소스 사이드바 ═══ */}
      <aside className="news-sidebar">
        <div className="news-sidebar-header">
          <div className="news-sidebar-title">뉴스 센터</div>
          <button className="news-add-source-btn" onClick={() => setShowAddModal(true)}>
            ＋ 소스 추가
          </button>
        </div>

        <div className="news-source-list">
          {/* 전체 / 북마크 / 관심종목 전체 */}
          <div className="news-source-special">
            <div
              className={`news-source-item ${!selectedSource && !selectedStock && !showBookmarked ? 'active' : ''}`}
              onClick={() => { setSelectedSource(null); setSelectedStock(null); setShowBookmarked(false) }}
            >
              <span className="news-source-icon">📰</span>
              <span className="news-source-name">전체 뉴스</span>
              {counts.unread > 0 && (
                <span className="news-source-count">{counts.unread}</span>
              )}
            </div>

            <div
              className={`news-source-item ${selectedStock === '__all__' ? 'active' : ''}`}
              onClick={() => { setSelectedStock('__all__'); setSelectedSource(null); setShowBookmarked(false) }}
              style={{ background: selectedStock === '__all__' ? 'rgba(139, 92, 246, 0.25)' : undefined }}
            >
              <span className="news-source-icon">📊</span>
              <span className="news-source-name" style={{ fontWeight: 600 }}>관심종목 전체</span>
              {counts.stocks > 0 && (
                <span className="news-source-count" style={{ background: '#8b5cf6', color: '#fff' }}>{counts.stocks}</span>
              )}
            </div>

            <div
              className={`news-source-item ${showBookmarked ? 'active' : ''}`}
              onClick={() => { setSelectedSource(null); setSelectedStock(null); setShowBookmarked(true) }}
            >
              <span className="news-source-icon">⭐</span>
              <span className="news-source-name">북마크</span>
              {counts.bookmarked > 0 && (
                <span className="news-source-count">{counts.bookmarked}</span>
              )}
            </div>
          </div>

          {/* ═══ 📈 관심 종목 (워치리스트) 섹션 ═══ */}
          <div className="news-watchlist-section">
            <div className="news-watchlist-header">
              <span className="news-watchlist-title">📈 관심 종목</span>
              <div className="news-watchlist-actions">
                <button
                  className="news-rescan-btn"
                  onClick={handleRescanWatchlist}
                  disabled={isRescanning}
                  title="기존 기사에서 종목 키워드 재스캔"
                >
                  {isRescanning ? '⏳' : '🔄'}
                </button>
                <button
                  className="news-add-stock-btn"
                  onClick={() => setShowAddStockModal(true)}
                  title="새 관심 종목 추가"
                >
                  ＋
                </button>
              </div>
            </div>

            <div className="news-watchlist-list">
              {watchlist.map(w => {
                const isSelected = selectedStock === w.name
                return (
                  <div
                    key={w.id}
                    className={`news-watchlist-item ${isSelected ? 'active' : ''}`}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedStock(null)
                      } else {
                        setSelectedStock(w.name)
                        setSelectedSource(null)
                        setShowBookmarked(false)
                      }
                    }}
                    title={`키워드: ${w.keywords}`}
                  >
                    <span className="stock-icon">{w.icon || '📊'}</span>
                    <span className="stock-name">{w.name}</span>
                    {w.article_count > 0 ? (
                      <span className="stock-count-badge" style={{ backgroundColor: `${w.color || '#8b5cf6'}33`, color: w.color || '#a78bfa', borderColor: `${w.color || '#8b5cf6'}55` }}>
                        {w.article_count}
                      </span>
                    ) : (
                      <span className="stock-count-zero">0</span>
                    )}
                    <button
                      onClick={(e) => handleDeleteStock(w.id, w.name, e)}
                      className="delete-stock-btn"
                      title="종목 삭제"
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 카테고리별 소스 */}
          {Object.entries(sourcesByCategory).map(([cat, srcList]) => (
            <div key={cat} className="news-source-section">
              <div className="news-source-category">{cat}</div>
              {srcList.map(src => (
                <div
                  key={src.id}
                  className={`news-source-item ${selectedSource === src.id ? 'active' : ''} ${!src.is_active ? 'news-source-inactive' : ''}`}
                  onClick={() => { setSelectedSource(src.id); setSelectedStock(null); setShowBookmarked(false) }}
                  title={src.url}
                >
                  <span className="news-source-icon">{src.icon}</span>
                  <span className="news-source-name">{src.name}</span>
                  {src.article_count > 0 && (
                    <span className="news-source-count">{src.article_count}</span>
                  )}
                  <button
                    onClick={(e) => handleDeleteSource(src.id, e)}
                    style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: '0 2px', fontSize: 11, opacity: 0 }}
                    className="delete-src-btn"
                    title="소스 삭제"
                  >✕</button>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* 트렌드 키워드 */}
        {trends.length > 0 && (
          <div className="news-trends-section">
            <div className="news-trends-title">🔥 트렌드</div>
            <div className="news-trends-chips">
              {trends.slice(0, 8).map(t => (
                <span
                  key={t.keyword}
                  className="trend-chip"
                  onClick={() => setSearchKeyword(t.keyword)}
                >
                  {t.keyword}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* RSS 수집 버튼 */}
        <button
          className={`news-fetch-btn ${isFetching ? 'fetching' : ''}`}
          onClick={handleFetch}
          disabled={isFetching}
        >
          <span className="fetch-icon">⟳</span>
          {isFetching ? '수집 중...' : '새 기사 수집'}
        </button>
      </aside>

      {/* ═══ 가운데: 기사 목록 ═══ */}
      <section className="news-list-panel">
        <div className="news-list-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2>{currentViewTitle}</h2>
            {selectedStock && (
              <button
                onClick={() => setSelectedStock(null)}
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#f87171',
                  borderRadius: 6,
                  padding: '2px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                ✕ 필터 해제
              </button>
            )}
          </div>
          {counts.unread > 0 && !showBookmarked && !selectedStock && (
            <span className="news-unread-badge">미읽음 {counts.unread}</span>
          )}
          <input
            className="news-search-input"
            type="text"
            placeholder="🔍 검색..."
            value={searchKeyword}
            onChange={e => setSearchKeyword(e.target.value)}
          />
        </div>

        {/* 📅 날짜 기반 타임라인 필터 스트립 */}
        <div className="news-date-strip">
          <div className="date-strip-scroll">
            <button
              type="button"
              className={`date-chip ${selectedDate === null ? 'active' : ''}`}
              onClick={() => setSelectedDate(null)}
            >
              <span className="date-chip-label">🌐 전체 기간</span>
              <span className="date-chip-count">{counts.total}</span>
            </button>

            {dates.map(d => {
              const isSelected = selectedDate === d.date
              return (
                <button
                  key={d.date}
                  type="button"
                  className={`date-chip ${isSelected ? 'active' : ''} ${d.label === '오늘' ? 'is-today' : ''}`}
                  onClick={() => setSelectedDate(d.date)}
                >
                  <span className="date-chip-label">
                    {d.label === '오늘' ? '🔥 오늘' : d.label === '어제' ? '📅 어제' : d.label}
                    <span className="date-chip-sub">({d.date.slice(5)})</span>
                  </span>
                  <span className="date-chip-count">{d.total_count}</span>
                  {d.unread_count > 0 && (
                    <span className="date-unread-dot" title={`미읽음 ${d.unread_count}건`} />
                  )}
                  {d.has_briefing && (
                    <span className="date-briefing-tag" title="AI 브리핑 완료">✨</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* ⚡ 선택된 날짜 데일리 액션 & 브리핑 배너 */}
        {selectedDate && (
          <div className="news-date-action-banner">
            <div className="date-action-left">
              <span className="date-action-icon">📅</span>
              <span className="date-action-title">
                <strong>
                  {dates.find(d => d.date === selectedDate)?.label || selectedDate}
                  <span className="date-badge-date">({selectedDate.slice(5)})</span>
                </strong>
                {' · '}기사 {articles.length}건
              </span>
              {dates.find(d => d.date === selectedDate)?.unread_count > 0 && (
                <span className="date-action-unread">
                  미읽음 {dates.find(d => d.date === selectedDate)?.unread_count}
                </span>
              )}
            </div>

            <div className="date-action-right">
              <button
                type="button"
                className="date-podcast-btn"
                onClick={() => handleOpenPodcast(selectedDate)}
                title="일하면서 귀로 듣는 AI 라디오 팟캐스트 (7~10분 심층 / 3분 요약)"
              >
                🎙️ AI 오디오 팟캐스트
              </button>
              <button
                type="button"
                className="date-briefing-btn"
                onClick={() => handleOpenBriefing(selectedDate)}
                title="이 날짜의 주요 기사를 AI가 종합 3분 브리핑"
              >
                {dates.find(d => d.date === selectedDate)?.has_briefing
                  ? '📜 AI 데일리 브리핑'
                  : '✨ AI 3분 브리핑'}
              </button>
              {dates.find(d => d.date === selectedDate)?.unread_count > 0 && (
                <button
                  type="button"
                  className="date-read-all-btn"
                  onClick={() => handleMarkDateRead(selectedDate)}
                  title="이 날짜 기사 모두 읽음 처리"
                >
                  ✓ 모두 읽음
                </button>
              )}
            </div>
          </div>
        )}

        <div className="news-articles-list">
          {isLoadingArticles ? (
            <div className="news-loading">기사 불러오는 중...</div>
          ) : articles.length === 0 ? (
            <div className="news-empty-state">
              <span className="empty-icon">📭</span>
              <p>기사가 없습니다.</p>
              {selectedStock ? (
                <button onClick={() => setSelectedStock(null)}>
                  전체 기사 보기
                </button>
              ) : (
                <button onClick={handleFetch} disabled={isFetching}>
                  {isFetching ? '수집 중...' : '📡 지금 수집하기'}
                </button>
              )}
            </div>
          ) : (
            articles.map(article => (
              <div
                key={article.id}
                className={`news-article-card ${!article.is_read ? 'unread' : ''} ${selectedArticle?.id === article.id ? 'selected' : ''}`}
                onClick={() => handleSelectArticle(article)}
              >
                {/* 호버 시 빠른 액션 버튼 */}
                <div className="article-quick-actions">
                  <button
                    className={`article-read-btn ${article.is_read ? 'is-read' : ''}`}
                    onClick={(e) => handleMarkRead(article, e)}
                    title={article.is_read ? '안읽음으로 변경' : '읽음 처리 (AI 요약 없이)'}
                  >
                    {article.is_read ? '↩' : '✓ 읽음'}
                  </button>
                  <button
                    className={`article-bm-btn ${article.is_bookmarked ? 'bookmarked' : ''}`}
                    onClick={(e) => handleBookmark(article, e)}
                    title={article.is_bookmarked ? '북마크 해제' : '북마크'}
                  >
                    {article.is_bookmarked ? '⭐' : '☆'}
                  </button>
                </div>
                <div className="news-article-meta">
                  {/* 안읽음 파란 점 / 읽음 체크 */}
                  {!article.is_read
                    ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0, boxShadow: '0 0 6px #3b82f6' }} title="안읽음" />
                    : <span style={{ fontSize: 11, color: '#374151', flexShrink: 0 }} title="읽음">✓</span>
                  }
                  <span className="article-source-badge">{article.source_icon} {article.source_name}</span>
                  <span className="article-date">{formatDate(article.published_at)}</span>

                  {/* 📊 관심종목 언급 태그 뱃지 */}
                  {article.mentioned_stocks && (
                    <div className="article-stocks-wrapper">
                      {article.mentioned_stocks.split(',').filter(Boolean).map(stockName => {
                        const stockObj = watchlist.find(w => w.name === stockName)
                        return (
                          <span
                            key={stockName}
                            className="article-stock-tag"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedStock(stockName)
                              setSelectedSource(null)
                              setShowBookmarked(false)
                            }}
                            title={`클릭: [${stockName}] 기사만 모아보기`}
                          >
                            {stockObj?.icon || '📈'} {stockName}
                          </span>
                        )
                      })}
                    </div>
                  )}

                  {article.ai_summary && <span className="article-has-ai" title="AI 요약 완료">✦ AI</span>}
                </div>
                <div className="article-title">{article.title}</div>
                {article.summary && (
                  <div className="article-summary">{article.summary}</div>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* ═══ 오른쪽: 기사 상세 + AI 요약 ═══ */}
      <aside className="news-detail-panel">
        {!selectedArticle ? (
          <div className="news-detail-empty">
            <span className="empty-icon">🤖</span>
            <p>기사를 선택하면<br />AI가 자동으로 요약해드립니다</p>
          </div>
        ) : (
          <div className="news-detail-content">
            {/* 상단바 */}
            <div className="news-detail-topbar">
              <span className="news-detail-source">
                {selectedArticle.source_icon} {selectedArticle.source_name}
              </span>
              <span className="news-detail-date">{formatDate(selectedArticle.published_at)}</span>
              <div className="news-detail-actions">
                <button
                  className={`detail-action-btn ${selectedArticle.is_bookmarked ? 'bookmarked' : ''}`}
                  onClick={(e) => handleBookmark(selectedArticle, e)}
                  title={selectedArticle.is_bookmarked ? '북마크 해제' : '북마크'}
                >
                  {selectedArticle.is_bookmarked ? '⭐' : '☆'} 북마크
                </button>
                <a
                  className="detail-action-btn open-link"
                  href={selectedArticle.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                >
                  🔗 원문
                </a>
              </div>
            </div>

            {/* 언급된 관심종목 태그 */}
            {selectedArticle.mentioned_stocks && (
              <div className="detail-stocks-tags">
                <span className="detail-stocks-label">언급된 관심종목:</span>
                {selectedArticle.mentioned_stocks.split(',').filter(Boolean).map(stockName => {
                  const stockObj = watchlist.find(w => w.name === stockName)
                  return (
                    <span
                      key={stockName}
                      className="article-stock-tag"
                      onClick={() => {
                        setSelectedStock(stockName)
                        setSelectedSource(null)
                        setShowBookmarked(false)
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      {stockObj?.icon || '📈'} {stockName}
                    </span>
                  )
                })}
              </div>
            )}

            {/* 제목 */}
            <div className="news-detail-title">{selectedArticle.title}</div>

            {/* RSS 요약 */}
            {selectedArticle.summary && (
              <div className="news-detail-rss-summary">{selectedArticle.summary}</div>
            )}

            {/* AI 요약 */}
            <div className="news-ai-summary">
              <div className="news-ai-header">
                <div className={`news-ai-badge ${aiStatus === 'loading' ? 'loading' : ''}`}>
                  <div className="ai-dot" />
                  {aiStatus === 'loading' ? 'AI 분석 중...' :
                   aiStatus === 'cached' ? 'AI 요약 (캐시)' :
                   aiStatus === 'done' ? 'AI 요약 완료' :
                   aiStatus === 'error' ? 'AI 오류' : 'AI 요약'}
                </div>
                {(aiStatus === 'done' || aiStatus === 'cached') && (
                  <span className="news-ai-model">Ollama</span>
                )}
                {(aiStatus === 'error') && (
                  <button
                    className="news-ai-retry-btn"
                    onClick={() => startAiSummary(selectedArticle.id)}
                  >
                    재시도
                  </button>
                )}
              </div>

              {aiText ? (
                <>
                  <AiMarkdown text={aiText} />
                  {aiKeywords.length > 0 && (
                    <div className="news-ai-keywords">
                      {aiKeywords.map(kw => (
                        <span
                          key={kw}
                          className="keyword-chip"
                          onClick={() => setSearchKeyword(kw)}
                          style={{ cursor: 'pointer' }}
                          title="이 키워드로 검색"
                        >
                          #{kw}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : aiStatus === 'loading' ? (
                <div className="news-ai-start">
                  <span className="ai-start-icon">🤖</span>
                  <p>Ollama가 기사를 분석하고 있습니다...</p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </aside>

      {/* ═══ 관심 종목 추가 모달 ═══ */}
      {showAddStockModal && (
        <div className="news-modal-overlay" onClick={() => setShowAddStockModal(false)}>
          <div className="news-modal" onClick={e => e.stopPropagation()}>
            <h3>📈 관심 종목 추가</h3>

            <div className="news-modal-field">
              <label>종목명 *</label>
              <input
                type="text"
                placeholder="예: 카카오, 애플, 인텔"
                value={newStock.name}
                onChange={e => setNewStock(p => ({ ...p, name: e.target.value }))}
              />
            </div>

            <div className="news-modal-field">
              <label>검색 키워드 (쉼표 구분) *</label>
              <input
                type="text"
                placeholder="예: 카카오,카카오페이,카카오뱅크,kakao"
                value={newStock.keywords}
                onChange={e => setNewStock(p => ({ ...p, keywords: e.target.value }))}
              />
              <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                기사 제목이나 본문에 이 키워드가 포함되면 자동으로 종목으로 태깅됩니다.
              </span>
            </div>

            <div style={{ display: 'flex', gap: 16 }}>
              <div className="news-modal-field" style={{ flex: 1 }}>
                <label>아이콘 (이모지)</label>
                <input
                  type="text"
                  placeholder="📊"
                  value={newStock.icon}
                  onChange={e => setNewStock(p => ({ ...p, icon: e.target.value }))}
                />
              </div>

              <div className="news-modal-field" style={{ flex: 1 }}>
                <label>테마 색상</label>
                <input
                  type="color"
                  value={newStock.color}
                  onChange={e => setNewStock(p => ({ ...p, color: e.target.value }))}
                  style={{ height: 42, padding: '2px 4px', cursor: 'pointer', background: 'transparent' }}
                />
              </div>
            </div>

            <div className="news-modal-actions">
              <button className="news-modal-cancel" onClick={() => setShowAddStockModal(false)}>
                취소
              </button>
              <button className="news-modal-submit" onClick={handleAddStock}>
                ＋ 종목 등록
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 소스 추가 모달 ═══ */}
      {showAddModal && (
        <div className="news-modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="news-modal" onClick={e => e.stopPropagation()}>
            <h3>📡 RSS 소스 추가</h3>

            <div className="news-modal-field">
              <label>소스 이름 *</label>
              <input
                type="text"
                placeholder="예: YTN 뉴스"
                value={newSource.name}
                onChange={e => setNewSource(p => ({ ...p, name: e.target.value }))}
              />
            </div>

            <div className="news-modal-field">
              <label>RSS URL *</label>
              <input
                type="url"
                placeholder="https://example.com/rss.xml"
                value={newSource.url}
                onChange={e => setNewSource(p => ({ ...p, url: e.target.value }))}
              />
            </div>

            <div className="news-modal-field">
              <label>카테고리</label>
              <select
                value={newSource.category}
                onChange={e => setNewSource(p => ({ ...p, category: e.target.value }))}
              >
                <option>IT/기술</option>
                <option>AI</option>
                <option>경제/증권</option>
                <option>국내 뉴스</option>
                <option>유튜브/크리에이터</option>
                <option>기타</option>
              </select>
            </div>

            <div className="news-modal-field">
              <label>아이콘 (이모지)</label>
              <input
                type="text"
                placeholder="📰"
                value={newSource.icon}
                onChange={e => setNewSource(p => ({ ...p, icon: e.target.value }))}
                style={{ width: 60 }}
              />
            </div>

            <div className="news-modal-actions">
              <button className="news-modal-cancel" onClick={() => setShowAddModal(false)}>
                취소
              </button>
              <button className="news-modal-submit" onClick={handleAddSource}>
                ＋ 추가하기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 📰 데일리 AI 종합 브리핑 모달 ═══ */}
      {showBriefingModal && (
        <div className="news-modal-overlay" onClick={() => setShowBriefingModal(false)}>
          <div className="news-briefing-modal" onClick={e => e.stopPropagation()}>
            <div className="news-briefing-header">
              <div className="briefing-header-left">
                <span className="briefing-header-icon">📰</span>
                <div>
                  <h3 className="briefing-header-title">
                    {briefingData.date} 데일리 AI 뉴스 종합 브리핑
                  </h3>
                  <span className="briefing-header-sub">
                    Gemini 3.8 Flash 애널리스트 심층 분석
                  </span>
                </div>
              </div>
              <div className="briefing-header-actions">
                <button
                  type="button"
                  className="briefing-action-btn"
                  onClick={() => handleOpenBriefing(briefingData.date, true)}
                  disabled={briefingData.isStreaming || briefingData.isLoading}
                  title="다시 분석하기"
                >
                  🔄 다시 요약
                </button>
                <button
                  type="button"
                  className="briefing-action-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(briefingData.content)
                    showToast('📋 브리핑이 클립보드에 복사되었습니다.', 'success')
                  }}
                  disabled={!briefingData.content}
                  title="클립보드 복사"
                >
                  📋 복사
                </button>
                <button
                  type="button"
                  className="news-modal-close-btn"
                  onClick={() => setShowBriefingModal(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="news-briefing-body">
              {briefingData.isLoading ? (
                <div className="briefing-loading-state">
                  <div className="briefing-spinner" />
                  <p>기사들을 심층 분석하여 데일리 브리핑을 작성하고 있습니다...</p>
                  <span>(핵심 3대 이슈, 테크/AI 트렌드, 관심종목 영향 분석)</span>
                </div>
              ) : briefingData.error ? (
                <div className="briefing-error-state">
                  <span className="briefing-error-icon">⚠️</span>
                  <p>{briefingData.error}</p>
                  <button onClick={() => handleOpenBriefing(briefingData.date, true)}>
                    다시 시도
                  </button>
                </div>
              ) : (
                <div className="briefing-content-view">
                  <AiMarkdown text={briefingData.content} />
                  {briefingData.isStreaming && (
                    <span className="briefing-cursor">▋</span>
                  )}
                </div>
              )}
            </div>

            <div className="news-briefing-footer">
              <span className="briefing-footer-tip">
                💡 오늘 하루의 흐름을 1분 만에 파악할 수 있도록 핵심만 선별했습니다.
              </span>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setShowBriefingModal(false)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 🎙️ 데일리 AI 오디오 팟캐스트 모달 ═══ */}
      {showPodcastModal && (
        <div className="news-modal-overlay" onClick={() => {
          if (isPlayingPodcast && audioRef.current) audioRef.current.pause()
          setIsPlayingPodcast(false)
          setShowPodcastModal(false)
        }}>
          <div className="news-podcast-modal" onClick={e => e.stopPropagation()}>
            <div className="news-podcast-header">
              <div className="podcast-header-left">
                <span className="podcast-header-icon">🎙️</span>
                <div>
                  <h3 className="podcast-header-title">
                    {selectedDate || (dates.length > 0 ? dates[0].date : '')} AI 오디오 라디오 팟캐스트
                  </h3>
                  <span className="podcast-header-sub">
                    일하면서 이어폰으로 편안하게 듣는 데일리 경제·IT 심층 해설 방송
                  </span>
                </div>
              </div>
              <div className="podcast-header-actions">
                {podcastData?.exists && (
                  <button
                    type="button"
                    className="podcast-recreate-btn"
                    onClick={() => handleGeneratePodcast(true)}
                    disabled={isPodcastLoading}
                    title="대본을 다시 쓰고 새로 녹음하기"
                  >
                    🔄 다시 녹음
                  </button>
                )}
                <button
                  type="button"
                  className="news-modal-close-btn"
                  onClick={() => {
                    if (isPlayingPodcast && audioRef.current) audioRef.current.pause()
                    setIsPlayingPodcast(false)
                    setShowPodcastModal(false)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>

            {/* 상단 옵션 바: 모드 선택 & 성우 선택 */}
            <div className="podcast-options-bar">
              <div className="podcast-opt-group">
                <span className="podcast-opt-label">방송 포맷:</span>
                <div className="podcast-pill-toggle">
                  <button
                    type="button"
                    className={`pill-btn ${podcastMode === 'deep' ? 'active' : ''}`}
                    onClick={() => handleModeChange('deep')}
                    disabled={isPodcastLoading}
                  >
                    🎧 7~10분 심층 데일리 방송 (추천)
                  </button>
                  <button
                    type="button"
                    className={`pill-btn ${podcastMode === 'quick' ? 'active' : ''}`}
                    onClick={() => handleModeChange('quick')}
                    disabled={isPodcastLoading}
                  >
                    ⚡ 3분 퀵 브리핑
                  </button>
                </div>
              </div>

              <div className="podcast-opt-group">
                <span className="podcast-opt-label">AI 성우:</span>
                <div className="podcast-pill-toggle">
                  <button
                    type="button"
                    className={`pill-btn ${podcastVoice === 'ko-KR-InJoonNeural' ? 'active' : ''}`}
                    onClick={() => handleVoiceChange('ko-KR-InJoonNeural')}
                    disabled={isPodcastLoading}
                  >
                    🎙️ 인준 (차분한 앵커)
                  </button>
                  <button
                    type="button"
                    className={`pill-btn ${podcastVoice === 'ko-KR-SunHiNeural' ? 'active' : ''}`}
                    onClick={() => handleVoiceChange('ko-KR-SunHiNeural')}
                    disabled={isPodcastLoading}
                  >
                    🎙️ 선희 (또렷한 아나운서)
                  </button>
                </div>
              </div>
            </div>

            <div className="news-podcast-body">
              {isPodcastLoading ? (
                <div className="podcast-loading-state">
                  <div className="podcast-soundwave">
                    <span /><span /><span /><span /><span />
                  </div>
                  <h4>AI 앵커가 라디오 방송을 녹음하고 있습니다...</h4>
                  <p>
                    Gemini 3.8 Flash가 주요 25건 기사를 심층 분석하여 4대 코너 방송 대본을 집필하고,<br />
                    Microsoft Edge-TTS 초고음질 음성으로 녹음 중입니다. (약 10~15초 소요)
                  </p>
                </div>
              ) : podcastError ? (
                <div className="podcast-error-state">
                  <span className="podcast-error-icon">⚠️</span>
                  <p>{podcastError}</p>
                  <button onClick={() => handleGeneratePodcast(false)}>
                    다시 시도하기
                  </button>
                </div>
              ) : !podcastData?.exists ? (
                <div className="podcast-empty-state">
                  <div className="podcast-empty-icon-wrap">
                    <span className="podcast-empty-icon">🎧</span>
                  </div>
                  <h3>아직 녹음된 팟캐스트가 없습니다.</h3>
                  <p>
                    오늘 수집된 뉴스를 바탕으로 <strong>배경·수치·파급 효과까지 생생하게 해설해주는</strong><br />
                    맞춤형 데일리 라디오 방송을 지금 생성해보세요.
                  </p>
                  <div className="podcast-corner-features">
                    <div className="feature-item">
                      <span className="feat-num">1부</span>
                      <span className="feat-title">오늘의 톱 헤드라인 심층 해설</span>
                    </div>
                    <div className="feature-item">
                      <span className="feat-num">2부</span>
                      <span className="feat-title">글로벌 IT · AI 테크 시장 동향</span>
                    </div>
                    <div className="feature-item">
                      <span className="feat-num">3부</span>
                      <span className="feat-title">관심 기업(반도체/빅테크) 집중 포커스</span>
                    </div>
                    <div className="feature-item">
                      <span className="feat-num">4부</span>
                      <span className="feat-title">클로징 및 하루 1줄 인사이트</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="podcast-start-record-btn"
                    onClick={() => handleGeneratePodcast(false)}
                  >
                    🎙️ {selectedDate} AI 라디오 방송 녹음 시작 (100% 무료)
                  </button>
                </div>
              ) : (
                <div className="podcast-ready-view">
                  {/* 오디오 플레이어 카드 */}
                  <div className="podcast-player-card">
                    <div className="player-meta-top">
                      <div className="player-title-box">
                        <span className="player-badge">
                          {podcastData.mode === 'deep' ? '🎧 7~10분 심층 방송' : '⚡ 3분 퀵 브리핑'}
                        </span>
                        <h4 className="player-title">{podcastData.title}</h4>
                      </div>
                      <div className="player-voice-info">
                        <span className="voice-tag">
                          {podcastData.voice.includes('InJoon') ? '🎙️ 인준 앵커' : '🎙️ 선희 아나운서'}
                        </span>
                        <a
                          className="podcast-download-btn"
                          href={podcastData.audio_url}
                          download={`뉴스팟캐스트_${podcastData.date}_${podcastData.mode}.mp3`}
                          title="스마트폰이나 다른 기기에서 들을 수 있도록 MP3 파일 다운로드"
                        >
                          ⬇️ MP3 다운로드
                        </a>
                      </div>
                    </div>

                    {/* 재생 슬라이더 바 */}
                    <div className="player-slider-row">
                      <span className="time-text current">{formatTime(podcastCurrentTime)}</span>
                      <input
                        type="range"
                        className="player-progress-bar"
                        min="0"
                        max={podcastDuration || podcastData.duration || 100}
                        step="0.1"
                        value={podcastCurrentTime}
                        onChange={handleSeekChange}
                      />
                      <span className="time-text total">
                        {formatTime(podcastDuration || podcastData.duration)}
                      </span>
                    </div>

                    {/* 재생 컨트롤 버튼 군 */}
                    <div className="player-controls-row">
                      <div className="speed-buttons">
                        {[1.0, 1.2, 1.5, 2.0].map(rate => (
                          <button
                            key={rate}
                            type="button"
                            className={`rate-btn ${podcastPlaybackRate === rate ? 'active' : ''}`}
                            onClick={() => handleRateChange(rate)}
                          >
                            {rate}x
                          </button>
                        ))}
                      </div>

                      <div className="main-play-controls">
                        <button
                          type="button"
                          className="seek-btn"
                          onClick={() => seekPodcast(-10)}
                          title="10초 뒤로"
                        >
                          ⏪ 10초
                        </button>
                        <button
                          type="button"
                          className="main-play-btn"
                          onClick={togglePlayPodcast}
                          title={isPlayingPodcast ? '일시정지' : '재생'}
                        >
                          {isPlayingPodcast ? '⏸️' : '▶️'}
                        </button>
                        <button
                          type="button"
                          className="seek-btn"
                          onClick={() => seekPodcast(10)}
                          title="10초 앞으로"
                        >
                          10초 ⏩
                        </button>
                      </div>

                      <div className="player-volume-placeholder">
                        <span className="listening-tip">🎧 일하면서 재생 켜두기</span>
                      </div>
                    </div>

                    {/* HTML5 Audio 태그 */}
                    <audio
                      ref={audioRef}
                      src={podcastData.audio_url}
                      onTimeUpdate={() => {
                        if (audioRef.current) setPodcastCurrentTime(audioRef.current.currentTime)
                      }}
                      onLoadedMetadata={() => {
                        if (audioRef.current) setPodcastDuration(audioRef.current.duration)
                      }}
                      onEnded={() => setIsPlayingPodcast(false)}
                      onError={(e) => {
                        console.error('오디오 에러:', e)
                        setPodcastError('오디오를 재생할 수 없습니다.')
                      }}
                    />
                  </div>

                  {/* 라디오 방송 대본 스크립트 뷰어 */}
                  <div className="podcast-script-card">
                    <div className="script-card-header">
                      <div className="script-header-left">
                        <span className="script-icon">📜</span>
                        <span className="script-title">라디오 방송 원고 전문</span>
                        <span className="script-len">
                          (약 {podcastData.script?.length?.toLocaleString() || 0}자)
                        </span>
                      </div>
                      <button
                        type="button"
                        className="script-copy-btn"
                        onClick={() => {
                          navigator.clipboard.writeText(podcastData.script)
                          showToast('📋 방송 원고가 클립보드에 복사되었습니다.', 'success')
                        }}
                      >
                        📋 원고 복사
                      </button>
                    </div>

                    <div className="script-card-body">
                      {podcastData.script?.split('\n\n').map((paragraph, idx) => (
                        <p key={idx} className="script-paragraph">
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="news-podcast-footer">
              <span className="podcast-footer-tip">
                💡 팟캐스트 창을 닫아도 브라우저 탭을 끄지 않는 한 오디오는 백그라운드에서 계속 재생됩니다.
              </span>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setShowPodcastModal(false)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 토스트 ═══ */}
      <div className={`news-toast ${toast.show ? 'show' : ''} ${toast.type}`}>
        {toast.msg}
      </div>

      {/* 소스/종목 카드 hover 시 삭제 버튼 표시 CSS */}
      <style>{`
        .news-source-item:hover .delete-src-btn { opacity: 1 !important; }
        .news-source-item.active .delete-src-btn { opacity: 0.5 !important; }
        .news-source-item.active:hover .delete-src-btn { opacity: 1 !important; }
        .news-watchlist-item:hover .delete-stock-btn { opacity: 1 !important; }
      `}</style>
    </div>
  )
}

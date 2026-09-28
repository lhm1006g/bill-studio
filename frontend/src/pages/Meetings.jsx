import { useState, useEffect, useRef } from 'react'
import './Meetings.css'

const API_BASE = 'http://localhost:8000/api/meetings'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 타임코드 문자열(00:00, 11:45 등)을 초 단위로 변환
function timeStrToSeconds(str) {
  if (!str) return 0
  const clean = str.trim()
  const parts = clean.split(':')
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 60 + parseFloat(parts[1])
  } else if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2])
  }
  return 0
}

// **볼드** 및 강조 텍스트 리치 렌더링 헬퍼
function renderFormattedText(text) {
  if (!text) return ''
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={idx} className="summary-highlight">{part.slice(2, -2)}</strong>
    }
    return part
  })
}

// 마크다운 회의록을 인터랙티브 카드 데이터로 구조화 파싱
function parseMeetingSummary(md) {
  if (!md) return null

  const result = {
    title: '',
    keySummary: [],
    agendaList: [],
    decisions: [],
    tags: [],
    isStructured: false,
  }

  const sections = md.split(/(?=^##\s+)/m)

  for (const sec of sections) {
    const trimmed = sec.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('# ') && !result.title) {
      const titleMatch = trimmed.match(/^#\s+(.+)$/m)
      if (titleMatch) {
        result.title = titleMatch[1].replace(/\[제목\]/g, '').replace(/^\[|\]$/g, '').trim()
      }
    }

    if (trimmed.includes('핵심 요약')) {
      const lines = trimmed.split('\n').slice(1)
      for (const line of lines) {
        const l = line.trim()
        if (l.startsWith('-') || l.startsWith('*') || /^\d+\./.test(l)) {
          const clean = l.replace(/^[-*]\s*(\d+\.\s*)?/, '').replace(/^\d+\.\s*/, '').trim()
          if (clean) result.keySummary.push(clean)
        }
      }
      continue
    }

    if (trimmed.includes('주요 논의')) {
      const lines = trimmed.split('\n').slice(1)
      let currentItem = null

      for (const line of lines) {
        const l = line.trim()
        if (!l) continue

        const isHeader = l.startsWith('- **') || l.startsWith('* **') || l.startsWith('###')
        if (isHeader) {
          if (currentItem) {
            result.agendaList.push(currentItem)
          }

          let timeStr = ''
          let titleStr = ''
          let descStr = ''

          const fullBoldMatch = l.match(/^[-*]\s*\*\*(.+?)\*\*[:\s]*(.*)/)
          const h3Match = l.match(/^###\s*(.+)/)

          if (fullBoldMatch) {
            const boldPart = fullBoldMatch[1]
            descStr = fullBoldMatch[2] || ''

            const timeMatch = boldPart.match(/\[?(\d{1,2}:\d{2}\s*(?:~|-)\s*\d{1,2}:\d{2}|\d{1,2}:\d{2})\]?/)
            if (timeMatch) {
              timeStr = timeMatch[1]
              titleStr = boldPart.replace(timeMatch[0], '').replace(/^\[|\]$/g, '').trim()
            } else {
              titleStr = boldPart.trim()
            }
          } else if (h3Match) {
            titleStr = h3Match[1].trim()
          }

          let startSec = 0
          if (timeStr) {
            const firstTime = timeStr.split(/[~-]/)[0].trim()
            startSec = timeStrToSeconds(firstTime)
          }

          currentItem = {
            id: `agenda_${result.agendaList.length + 1}`,
            timeRange: timeStr,
            startSec,
            title: titleStr || '논의 안건',
            details: descStr ? [descStr] : [],
          }
        } else if (currentItem) {
          const detailClean = l.replace(/^[-*]\s*/, '').trim()
          if (detailClean) {
            currentItem.details.push(detailClean)
          }
        }
      }
      if (currentItem) {
        result.agendaList.push(currentItem)
      }
      continue
    }

    if (trimmed.includes('최종 결정')) {
      const lines = trimmed.split('\n').slice(1)
      for (const line of lines) {
        const l = line.trim()
        if (l.startsWith('-') || l.startsWith('*') || /^\d+\./.test(l)) {
          const clean = l.replace(/^[-*]\s*(\d+\.\s*)?/, '').replace(/^\d+\.\s*/, '').trim()
          if (clean) result.decisions.push(clean)
        }
      }
      continue
    }

    if (trimmed.includes('태그')) {
      const tagMatches = trimmed.match(/#([\w가-힣]+)/g)
      if (tagMatches) {
        result.tags = tagMatches.map(t => t.replace('#', ''))
      }
      continue
    }
  }

  result.isStructured = result.agendaList.length > 0 || result.keySummary.length > 0 || result.decisions.length > 0
  return result
}

function Meetings() {
  const [viewMode, setViewMode] = useState('calendar') // 'calendar' | 'list'
  const [currentDate, setCurrentDate] = useState(new Date())
  const [meetings, setMeetings] = useState([])
  const [loading, setLoading] = useState(false)

  // 상세 모달 상태
  const [selectedMeeting, setSelectedMeeting] = useState(null)
  const [detailTab, setDetailTab] = useState('summary') // 'summary' | 'actions' | 'transcript'
  const [summaryViewMode, setSummaryViewMode] = useState('card') // 'card' | 'raw'
  const [collapsedAgendas, setCollapsedAgendas] = useState(new Set())
  const [isResummarizing, setIsResummarizing] = useState(false)
  const audioRef = useRef(null)

  // 안건 접기/펼치기 토글
  const toggleAgendaCollapse = (id) => {
    setCollapsedAgendas(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 안건 모두 접기 / 모두 펼치기
  const toggleAllAgendas = (allIds) => {
    if (collapsedAgendas.size >= allIds.length) {
      setCollapsedAgendas(new Set())
    } else {
      setCollapsedAgendas(new Set(allIds))
    }
  }

  // 분석 & 생성 모달 상태
  const [isProcessModalOpen, setIsProcessModalOpen] = useState(false)
  const [sourceType, setSourceType] = useState('obs') // 'obs' | 'upload'
  const [recordingFiles, setRecordingFiles] = useState([])
  const [selectedFile, setSelectedFile] = useState('')
  const [uploadedFile, setUploadedFile] = useState(null)
  const [customTitle, setCustomTitle] = useState('')
  const [meetingDate, setMeetingDate] = useState(new Date().toISOString().slice(0, 10))
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash-medium')
  const [whisperSize, setWhisperSize] = useState('base')

  // SSE 스트리밍 상태
  const [isProcessing, setIsProcessing] = useState(false)
  const [processStep, setProcessStep] = useState(1)
  const [processMsg, setProcessMsg] = useState('')
  const [processError, setProcessError] = useState(null)

  // 미등록 파일 및 자동 동기화 상태
  const [unregisteredFiles, setUnregisteredFiles] = useState([])
  const [isAutoProcessing, setIsAutoProcessing] = useState(false)
  const [autoProgress, setAutoProgress] = useState({
    current: 1,
    total: 1,
    currentFile: '',
    meetingDate: '',
    startTime: '',
    step: 1,
    message: '',
  })

  // 수동 생성 모달
  const [isManualModalOpen, setIsManualModalOpen] = useState(false)
  const [manualForm, setManualForm] = useState({
    title: '',
    meeting_date: new Date().toISOString().slice(0, 10),
    start_time: '14:00',
    summary: '',
    tags: '컴짱회의',
  })

  // 1. 회의 목록 가져오기
  const fetchMeetings = async () => {
    setLoading(true)
    try {
      const year = currentDate.getFullYear()
      const month = currentDate.getMonth() + 1
      const res = await fetch(`${API_BASE}?year=${year}&month=${month}`)
      if (res.ok) {
        const data = await res.json()
        setMeetings(data)
      }
    } catch (e) {
      console.error('회의 목록 조회 실패:', e)
    } finally {
      setLoading(false)
    }
  }

  // 2. 미등록 녹화 파일 목록 가져오기
  const fetchUnregisteredFiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/unregistered`)
      if (res.ok) {
        const data = await res.json()
        setUnregisteredFiles(data)
      }
    } catch (e) {
      console.error('미등록 녹화본 조회 실패:', e)
    }
  }

  // 3. 녹화 파일 전체 목록 가져오기 (수동 선택용)
  const fetchRecordingFiles = async () => {
    try {
      const res = await fetch(`${API_BASE}/files`)
      if (res.ok) {
        const data = await res.json()
        setRecordingFiles(data)
        if (data.length > 0 && !selectedFile) {
          setSelectedFile(data[0].rel_path)
        }
      }
    } catch (e) {
      console.error('파일 목록 조회 실패:', e)
    }
  }

  useEffect(() => {
    fetchMeetings()
    fetchUnregisteredFiles()

    // 10초마다 미등록 파일 자동 감지 폴링
    const timer = setInterval(() => {
      fetchUnregisteredFiles()
    }, 10000)
    return () => clearInterval(timer)
  }, [currentDate])

  useEffect(() => {
    if (isProcessModalOpen) {
      fetchRecordingFiles()
    }
  }, [isProcessModalOpen])

  // 달력 네비게이션
  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))
  }
  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))
  }
  const handleToday = () => {
    setCurrentDate(new Date())
  }

  // 회의 상세 조회 열기
  const handleOpenDetail = async (meetingId) => {
    try {
      const res = await fetch(`${API_BASE}/${meetingId}`)
      if (res.ok) {
        const data = await res.json()
        setSelectedMeeting(data)
        setDetailTab('summary')
      }
    } catch (e) {
      console.error('회의 상세 조회 실패:', e)
    }
  }

  // 액션 아이템 토글
  const handleToggleAction = async (itemId, currentDone) => {
    if (!selectedMeeting) return
    const newDone = !currentDone
    try {
      const res = await fetch(`${API_BASE}/${selectedMeeting.id}/action-item`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId, done: newDone }),
      })
      if (res.ok) {
        const data = await res.json()
        setSelectedMeeting(prev => ({
          ...prev,
          action_items: data.action_items,
        }))
        // 목록도 갱신
        fetchMeetings()
      }
    } catch (e) {
      console.error('액션 아이템 수정 실패:', e)
    }
  }

  // 회의 삭제
  const handleDeleteMeeting = async (meetingId) => {
    if (!window.confirm('정말 이 회의 기록을 삭제하시겠습니까?')) return
    try {
      const res = await fetch(`${API_BASE}/${meetingId}`, { method: 'DELETE' })
      if (res.ok) {
        setSelectedMeeting(null)
        fetchMeetings()
      }
    } catch (e) {
      console.error('회의 삭제 실패:', e)
    }
  }

  // 대본 타임코드 클릭 시 오디오 seek
  const handleSeekAudio = (seconds) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds
      audioRef.current.play()
    }
  }

  // 회의록 클립보드 복사
  const handleCopySummary = () => {
    if (!selectedMeeting || !selectedMeeting.summary) return
    navigator.clipboard.writeText(selectedMeeting.summary)
    alert('📋 회의록 내용이 클립보드에 복사되었습니다!')
  }

  // 실제 녹음 진행 순서(시간 흐름)에 맞춰 다시 요약하기
  const handleResummarize = async () => {
    if (!selectedMeeting) return
    if (!window.confirm('실제 녹음된 시간 흐름(타임라인 순서)에 맞춰 회의록과 주요 논의 사항을 다시 요약하시겠습니까?')) return

    setIsResummarizing(true)
    try {
      const res = await fetch(`${API_BASE}/${selectedMeeting.id}/resummarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: selectedModel || 'gemini-3.8-flash-medium' }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        setSelectedMeeting(prev => ({
          ...prev,
          title: data.title,
          summary: data.summary,
          action_items: data.action_items,
          tags: data.tags,
        }))
        fetchMeetings()
        alert('🎉 실제 녹음 진행 시간 순서(타임라인)에 맞추어 회의록이 성공적으로 재요약되었습니다!')
      } else {
        alert(data.detail || '회의록 재요약에 실패했습니다.')
      }
    } catch (err) {
      console.error('재요약 오류:', err)
      alert('회의록 재요약 중 오류가 발생했습니다.')
    } finally {
      setIsResummarizing(false)
    }
  }

  // 파일 업로드 핸들러
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)

    try {
      setProcessMsg('파일 업로드 중...')
      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      })
      if (res.ok) {
        const data = await res.json()
        setSelectedFile(data.rel_path)
        setUploadedFile(data)
        alert(`✅ 파일이 업로드되었습니다: ${data.name}`)
      }
    } catch (err) {
      console.error('업로드 실패:', err)
      alert('파일 업로드에 실패했습니다.')
    }
  }

  // AI 분석 및 회의록 생성 실행 (SSE)
  const handleStartProcess = async () => {
    if (!selectedFile) {
      alert('분석할 녹화/음성 파일을 선택해주세요.')
      return
    }

    setIsProcessing(true)
    setProcessError(null)
    setProcessStep(1)
    setProcessMsg('회의 분석 준비 중...')

    try {
      const response = await fetch(`${API_BASE}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: selectedFile,
          title: customTitle.trim() || undefined,
          meeting_date: meetingDate,
          model_name: selectedModel,
          whisper_size: whisperSize,
        }),
      })

      if (!response.ok) {
        throw new Error('회의 분석 요청에 실패했습니다.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // 불완전한 마지막 줄 보존

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const rawData = line.slice(6).trim()
            if (rawData === '[DONE]') {
              setIsProcessing(false)
              setIsProcessModalOpen(false)
              fetchMeetings()
              fetchUnregisteredFiles()
              break
            }
            try {
              const data = JSON.parse(rawData)
              if (data.step) setProcessStep(data.step)
              if (data.message) setProcessMsg(data.message)
              if (data.type === 'done' && data.meeting_id) {
                // 완료 시 자동으로 상세 모달 열기
                handleOpenDetail(data.meeting_id)
              }
            } catch (err) {
              // JSON 파싱 에러 무시
            }
          }
        }
      }
    } catch (err) {
      console.error('분석 에러:', err)
      setProcessError(err.message || '회의록 분석 중 오류가 발생했습니다.')
      setIsProcessing(false)
    }
  }

  // 날짜별 자동 정리 및 일괄 등록 (SSE)
  const handleAutoProcess = async (targetFiles = null) => {
    if (isAutoProcessing) return

    const targets = targetFiles || unregisteredFiles.map(f => f.rel_path)
    if (targets.length === 0) {
      alert('자동 정리할 미등록 회의 파일이 없습니다.')
      return
    }

    setIsAutoProcessing(true)
    setAutoProgress({
      current: 1,
      total: targets.length,
      currentFile: (targetFiles && unregisteredFiles.find(f => f.rel_path === targets[0])?.name) || unregisteredFiles[0]?.name || '',
      meetingDate: (targetFiles && unregisteredFiles.find(f => f.rel_path === targets[0])?.meeting_date) || unregisteredFiles[0]?.meeting_date || '',
      startTime: (targetFiles && unregisteredFiles.find(f => f.rel_path === targets[0])?.start_time) || unregisteredFiles[0]?.start_time || '',
      step: 1,
      message: '날짜별 자동 정리 준비 중...',
    })

    try {
      const response = await fetch(`${API_BASE}/auto-process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: targets,
          model_name: selectedModel,
          whisper_size: whisperSize,
        }),
      })

      if (!response.ok) {
        throw new Error('자동 등록 요청에 실패했습니다.')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastCreatedId = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const rawData = line.slice(6).trim()
            if (rawData === '[DONE]') {
              setIsAutoProcessing(false)
              fetchMeetings()
              fetchUnregisteredFiles()
              if (lastCreatedId && targets.length === 1) {
                handleOpenDetail(lastCreatedId)
              }
              break
            }
            try {
              const data = JSON.parse(rawData)
              setAutoProgress(prev => ({
                ...prev,
                current: data.file_index || prev.current,
                total: data.total_files || prev.total,
                currentFile: data.file_name || prev.currentFile,
                meetingDate: data.meeting_date || prev.meetingDate,
                startTime: data.start_time || prev.startTime,
                step: data.step || prev.step,
                message: data.message || prev.message,
              }))

              if (data.type === 'file_done' && data.meeting?.meeting_id) {
                lastCreatedId = data.meeting.meeting_id
              }
            } catch (err) {
              // JSON 파싱 무시
            }
          }
        }
      }
    } catch (err) {
      console.error('자동 정리 오류:', err)
      alert(err.message || '자동 정리 중 오류가 발생했습니다.')
      setIsAutoProcessing(false)
    }
  }

  // 수동 회의 생성 제출
  const handleManualSubmit = async (e) => {
    e.preventDefault()
    if (!manualForm.title.trim()) {
      alert('회의 제목을 입력해주세요.')
      return
    }

    try {
      const tagsArray = manualForm.tags.split(',').map(t => t.trim()).filter(Boolean)
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: manualForm.title,
          meeting_date: manualForm.meeting_date,
          start_time: manualForm.start_time,
          summary: manualForm.summary,
          tags: tagsArray,
        }),
      })

      if (res.ok) {
        setIsManualModalOpen(false)
        setManualForm({
          title: '',
          meeting_date: new Date().toISOString().slice(0, 10),
          start_time: '14:00',
          summary: '',
          tags: '컴짱회의',
        })
        fetchMeetings()
      }
    } catch (e) {
      console.error('수동 등록 실패:', e)
    }
  }

  // ─── 캘린더 그리드 날짜 계산 ──────────────────────────────────────────
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const firstDayOfMonth = new Date(year, month, 1).getDay()
  const lastDateOfMonth = new Date(year, month + 1, 0).getDate()
  const prevMonthLastDate = new Date(year, month, 0).getDate()

  const calendarDays = []

  // 이전 달의 끝 날짜들
  for (let i = firstDayOfMonth - 1; i >= 0; i--) {
    const d = prevMonthLastDate - i
    const m = month === 0 ? 12 : month
    const y = month === 0 ? year - 1 : year
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    calendarDays.push({ date: d, isCurrentMonth: false, dateStr })
  }

  // 이번 달 날짜들
  for (let d = 1; d <= lastDateOfMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    calendarDays.push({ date: d, isCurrentMonth: true, dateStr })
  }

  // 다음 달 시작 날짜들 (총 35 또는 42칸 맞추기)
  const totalSlots = calendarDays.length > 35 ? 42 : 35
  const remainingSlots = totalSlots - calendarDays.length
  for (let d = 1; d <= remainingSlots; d++) {
    const m = month + 2 > 12 ? 1 : month + 2
    const y = month + 2 > 12 ? year + 1 : year
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    calendarDays.push({ date: d, isCurrentMonth: false, dateStr })
  }

  const todayStr = new Date().toISOString().slice(0, 10)

  // 날짜별 회의 매핑
  const meetingsByDate = {}
  meetings.forEach(m => {
    if (!meetingsByDate[m.meeting_date]) {
      meetingsByDate[m.meeting_date] = []
    }
    meetingsByDate[m.meeting_date].push(m)
  })

  // 날짜별 미등록 녹화 파일 매핑
  const unregisteredByDate = {}
  unregisteredFiles.forEach(f => {
    if (!unregisteredByDate[f.meeting_date]) {
      unregisteredByDate[f.meeting_date] = []
    }
    unregisteredByDate[f.meeting_date].push(f)
  })

  // 소요 시간 포맷터
  const formatDuration = (sec) => {
    if (!sec) return ''
    const m = Math.floor(sec / 60)
    const s = sec % 60
    if (m === 0) return `${s}초`
    return `${m}분 ${s > 0 ? `${s}초` : ''}`
  }

  return (
    <div className="meetings-page">
      {/* ─── 상단 헤더 배너 ─────────────────────────────────────────── */}
      <div className="meetings-header">
        <div className="meetings-title-box">
          <h1>🎙️ 컴짱회의 캘린더</h1>
          <p>OBS 회의 녹화 파일 ➔ Faster-Whisper 로컬 음성인식 ➔ Gemini 3.8 Flash AI 실무 회의록 원클릭 자동 관리</p>
        </div>
        <div className="meetings-actions">
          <div className="view-mode-toggle">
            <button
              className={`toggle-btn ${viewMode === 'calendar' ? 'active' : ''}`}
              onClick={() => setViewMode('calendar')}
            >
              📅 캘린더
            </button>
            <button
              className={`toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
            >
              📋 목록
            </button>
          </div>

          <button
            className="btn-secondary"
            title="OBS 녹화 폴더 새로고침"
            onClick={() => {
              fetchMeetings()
              fetchUnregisteredFiles()
            }}
          >
            🔄 새로고침
          </button>

          <button
            className="btn-secondary"
            onClick={() => setIsManualModalOpen(true)}
          >
            ✍️ 직접 작성
          </button>

          <button
            className="btn-primary-gradient"
            onClick={() => setIsProcessModalOpen(true)}
          >
            <span>⚡</span> 새 회의록 생성
          </button>
        </div>
      </div>

      {/* ─── 미등록 OBS 녹화 파일 감지 배너 ─────────────────────────── */}
      {unregisteredFiles.length > 0 && (
        <div className="unregistered-alert-banner">
          <div className="unregistered-banner-left">
            <span className="banner-alert-icon">🎥</span>
            <div className="banner-alert-info">
              <div className="banner-alert-title">
                OBS 회의 녹화본 <strong>{unregisteredFiles.length}건</strong>이 감지되었습니다!
                <span className="banner-auto-sub"> (녹화 파일의 날짜·시간을 자동 판별하여 캘린더에 표시됨)</span>
              </div>
              <div className="banner-file-chips">
                {unregisteredFiles.map(f => (
                  <span
                    key={f.rel_path}
                    className="unregistered-file-chip"
                    onClick={() => handleAutoProcess([f.rel_path])}
                    title="클릭 시 이 녹화본만 즉시 AI 회의록 생성"
                  >
                    📅 <strong>{f.meeting_date} {f.start_time}</strong> ({f.size_mb}MB · {f.duration_sec > 0 ? `${f.duration_sec}초` : '영상'}) ⚡
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="unregistered-banner-right">
            <button
              className="btn-auto-organize-all"
              disabled={isAutoProcessing}
              onClick={() => handleAutoProcess(null)}
            >
              <span>⚡</span> 날짜별 자동 일괄 등록 ({unregisteredFiles.length}건)
            </button>
          </div>
        </div>
      )}

      {/* ─── 캘린더 네비게이션 바 ────────────────────────────────────── */}
      <div className="calendar-top-bar">
        <div className="calendar-nav">
          <button className="nav-arrow-btn" onClick={handlePrevMonth}>◀</button>
          <div className="current-month-label">
            {year}년 {month + 1}월
          </div>
          <button className="nav-arrow-btn" onClick={handleNextMonth}>▶</button>
          <button className="today-chip" onClick={handleToday}>오늘</button>
        </div>
        <div className="meeting-count-badge">
          이번 달 기록된 회의: <span className="count-highlight">{meetings.length}건</span>
          {unregisteredFiles.length > 0 && (
            <span className="unreg-highlight-badge">미등록 녹화본: {unregisteredFiles.length}건 대기 중</span>
          )}
        </div>
      </div>

      {/* ─── 월간 캘린더 뷰 ─────────────────────────────────────────── */}
      {viewMode === 'calendar' ? (
        <div className="calendar-grid-wrapper">
          <div className="calendar-weekdays-row">
            {WEEKDAYS.map((day, idx) => (
              <div
                key={day}
                className={`weekday-col ${idx === 0 ? 'sunday' : ''} ${idx === 6 ? 'saturday' : ''}`}
              >
                {day}
              </div>
            ))}
          </div>

          <div className="calendar-days-grid">
            {calendarDays.map((cell, idx) => {
              const isToday = cell.dateStr === todayStr
              const dayMeetings = meetingsByDate[cell.dateStr] || []
              const dayUnregistered = unregisteredByDate[cell.dateStr] || []

              return (
                <div
                  key={idx}
                  className={`day-cell ${!cell.isCurrentMonth ? 'other-month' : ''} ${isToday ? 'is-today' : ''} ${dayUnregistered.length > 0 ? 'has-unregistered' : ''}`}
                  onClick={() => {
                    if (dayUnregistered.length > 0) {
                      handleAutoProcess([dayUnregistered[0].rel_path])
                    } else if (dayMeetings.length > 0) {
                      handleOpenDetail(dayMeetings[0].id)
                    } else {
                      setMeetingDate(cell.dateStr)
                      setIsProcessModalOpen(true)
                    }
                  }}
                >
                  <div className="day-cell-header">
                    <span className="day-number">{cell.date}</span>
                    <button
                      className="day-add-quick-btn"
                      title="이 날짜에 회의 등록"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMeetingDate(cell.dateStr)
                        setIsProcessModalOpen(true)
                      }}
                    >
                      +
                    </button>
                  </div>

                  <div className="day-meetings-list">
                    {/* 1. 미등록 녹화 파일 뱃지 (원클릭 즉시 등록) */}
                    {dayUnregistered.map(unreg => (
                      <div
                        key={unreg.rel_path}
                        className="unregistered-pill"
                        title={`OBS 녹화 파일: ${unreg.name} (${unreg.size_mb}MB)\n클릭 시 날짜·시간 자동 인식 AI 회의록 생성`}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleAutoProcess([unreg.rel_path])
                        }}
                      >
                        <div className="unreg-pill-header">
                          <span className="unreg-pulse-icon">⚡</span>
                          <span className="unreg-time-text">{unreg.start_time} 녹화본</span>
                        </div>
                        <span className="unreg-action-badge">원클릭 등록</span>
                      </div>
                    ))}

                    {/* 2. 등록 완료된 회의 */}
                    {dayMeetings.map(m => (
                      <div
                        key={m.id}
                        className="meeting-pill"
                        title={m.title}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleOpenDetail(m.id)
                        }}
                      >
                        <div className="pill-title">
                          <span className="pill-icon">🎙️</span>
                          <span className="pill-title-text">{m.title}</span>
                        </div>
                        <div className="pill-meta">
                          <span>{m.start_time || '회의'}</span>
                          {m.duration_sec > 0 && <span>{formatDuration(m.duration_sec)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        /* ─── 목록 뷰 (타임라인 리스트) ─────────────────────────────── */
        <div className="meetings-list-view">
          {/* 미등록 녹화본 빠른 등록 섹션 */}
          {unregisteredFiles.length > 0 && (
            <div className="unregistered-list-section">
              <div className="unregistered-section-header">
                <h3>⚡ 등록 대기 중인 녹화본 ({unregisteredFiles.length}건)</h3>
                <button
                  className="btn-auto-organize-all-small"
                  disabled={isAutoProcessing}
                  onClick={() => handleAutoProcess(null)}
                >
                  ⚡ 전체 일괄 등록
                </button>
              </div>
              <div className="unregistered-cards-grid">
                {unregisteredFiles.map(f => (
                  <div key={f.rel_path} className="unregistered-card">
                    <div className="unreg-card-info">
                      <div className="unreg-card-title">
                        <span>🎥</span> {f.suggested_title}
                      </div>
                      <div className="unreg-card-meta">
                        <span>📅 {f.meeting_date} {f.start_time}</span>
                        <span>📦 {f.size_mb} MB</span>
                        {f.duration_sec > 0 && <span>⏳ {formatDuration(f.duration_sec)}</span>}
                      </div>
                    </div>
                    <button
                      className="btn-quick-register"
                      disabled={isAutoProcessing}
                      onClick={() => handleAutoProcess([f.rel_path])}
                    >
                      ⚡ 원클릭 등록
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {meetings.length === 0 ? (
            <div className="empty-state">
              <span>📋</span>
              <p>기록된 컴짱회의가 없습니다. 녹화 파일로 AI 회의록을 생성해보세요!</p>
            </div>
          ) : (
            meetings.map(m => {
              const totalActions = m.action_items?.length || 0
              const doneActions = m.action_items?.filter(a => a.done)?.length || 0
              const progressPct = totalActions > 0 ? Math.round((doneActions / totalActions) * 100) : 0

              return (
                <div
                  key={m.id}
                  className="meeting-card"
                  onClick={() => handleOpenDetail(m.id)}
                >
                  <div className="meeting-card-left">
                    <div className="card-date-badge">
                      <span>📅 {m.meeting_date}</span>
                      <span>⏱️ {m.start_time}</span>
                      {m.duration_sec > 0 && <span>⏳ {formatDuration(m.duration_sec)}</span>}
                    </div>
                    <h3 className="card-title">{m.title}</h3>
                    <p className="card-summary-preview">
                      {m.summary?.replace(/#|\*|\[|\]/g, '').slice(0, 140)}...
                    </p>
                    <div className="card-tags">
                      {m.tags?.map((t, i) => (
                        <span key={i} className="tag-badge">#{t}</span>
                      ))}
                    </div>
                  </div>

                  <div className="meeting-card-right">
                    {totalActions > 0 && (
                      <div className="action-status-box">
                        <span className="action-status-label">
                          할 일: {doneActions}/{totalActions} ({progressPct}%)
                        </span>
                        <div className="progress-bar-bg">
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    )}
                    <button className="btn-secondary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.82rem' }}>
                      상세 보기 →
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ─── AI 회의록 원클릭 분석 & 생성 모달 ─────────────────────── */}
      {isProcessModalOpen && (
        <div className="modal-overlay" onClick={() => !isProcessing && setIsProcessModalOpen(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2><span>⚡</span> AI 회의록 원클릭 자동 생성</h2>
              {!isProcessing && (
                <button className="close-btn" onClick={() => setIsProcessModalOpen(false)}>×</button>
              )}
            </div>

            <div className="modal-body">
              {isProcessing ? (
                /* 처리 중 프로그레스 */
                <div className="processing-status-card">
                  <div className="step-indicator">
                    <div className={`step-bubble ${processStep === 1 ? 'active' : ''} ${processStep > 1 ? 'completed' : ''}`}>
                      <div className="step-circle">{processStep > 1 ? '✓' : '1'}</div>
                      <span>Whisper 음성인식</span>
                    </div>
                    <div className={`step-bubble ${processStep === 2 ? 'active' : ''} ${processStep > 2 ? 'completed' : ''}`}>
                      <div className="step-circle">{processStep > 2 ? '✓' : '2'}</div>
                      <span>AI 회의록 요약</span>
                    </div>
                    <div className={`step-bubble ${processStep === 3 ? 'active' : ''}`}>
                      <div className="step-circle">3</div>
                      <span>캘린더 저장</span>
                    </div>
                  </div>

                  <div className="stream-progress-msg">
                    <span className="spinner">⏳</span>
                    <strong>{processMsg}</strong>
                  </div>
                </div>
              ) : (
                /* 입력 폼 */
                <>
                  <div className="source-selection-tabs">
                    <button
                      className={`source-tab-btn ${sourceType === 'obs' ? 'active' : ''}`}
                      onClick={() => setSourceType('obs')}
                    >
                      📁 OBS 녹화 파일에서 선택 ({recordingFiles.length}개)
                    </button>
                    <button
                      className={`source-tab-btn ${sourceType === 'upload' ? 'active' : ''}`}
                      onClick={() => setSourceType('upload')}
                    >
                      ⬆️ 내 컴퓨터에서 파일 업로드
                    </button>
                  </div>

                  {sourceType === 'obs' ? (
                    <div className="file-list-picker">
                      {recordingFiles.length === 0 ? (
                        <div className="empty-state" style={{ padding: '1rem' }}>
                          녹화된 파일이 없습니다. OBS에서 녹화 후 다시 시도하거나 직접 업로드해주세요.
                        </div>
                      ) : (
                        recordingFiles.map(f => (
                          <div
                            key={f.rel_path}
                            className={`file-pick-item ${selectedFile === f.rel_path ? 'selected' : ''}`}
                            onClick={() => setSelectedFile(f.rel_path)}
                          >
                            <span className="file-item-name">
                              <span>🎥</span> {f.name}
                            </span>
                            <span className="file-item-meta">
                              {f.size_mb} MB • {f.mtime.slice(5, 16)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  ) : (
                    <label className="upload-dropzone">
                      <input
                        type="file"
                        accept="audio/*,video/*"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                      />
                      <span style={{ fontSize: '2rem' }}>📂</span>
                      <p style={{ margin: '0.5rem 0', fontWeight: 600 }}>
                        {uploadedFile ? `선택됨: ${uploadedFile.name}` : '클릭하여 오디오/영상 파일 업로드'}
                      </p>
                      <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                        mp4, mkv, mov, m4a, mp3, wav 지원
                      </span>
                    </label>
                  )}

                  <div className="form-group-grid">
                    <div className="form-field">
                      <label>회의 일자</label>
                      <input
                        type="date"
                        className="form-input"
                        value={meetingDate}
                        onChange={e => setMeetingDate(e.target.value)}
                      />
                    </div>
                    <div className="form-field">
                      <label>회의 제목 (선택사항 - 미입력 시 AI가 자동 생성)</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="예: 2026 Q4 신규 프로젝트 킥오프 회의"
                        value={customTitle}
                        onChange={e => setCustomTitle(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="form-group-grid">
                    <div className="form-field">
                      <label>AI 요약 모델</label>
                      <select
                        className="form-select"
                        value={selectedModel}
                        onChange={e => setSelectedModel(e.target.value)}
                      >
                        <option value="gemini-3.8-flash-medium">⚡ Gemini 3.8 Flash (초고속·추천)</option>
                        <option value="gemini-3.1-pro-high">🧠 Gemini 3.1 Pro (정밀 분석)</option>
                        <option value="claude-sonnet-4-6">🎨 Claude Sonnet 4.6</option>
                        <option value="ollama:gemma3:12b">🔒 Gemma 3 (12B 온디바이스 로컬)</option>
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Whisper 음성인식 모델</label>
                      <select
                        className="form-select"
                        value={whisperSize}
                        onChange={e => setWhisperSize(e.target.value)}
                      >
                        <option value="base">빠르고 정확 (base - 추천)</option>
                        <option value="tiny">초고속 (tiny)</option>
                        <option value="small">고정밀 (small)</option>
                      </select>
                    </div>
                  </div>

                  {processError && (
                    <div style={{ color: '#f87171', fontSize: '0.88rem' }}>
                      ⚠️ {processError}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn-secondary"
                disabled={isProcessing}
                onClick={() => setIsProcessModalOpen(false)}
              >
                취소
              </button>
              <button
                className="btn-primary-gradient"
                disabled={isProcessing || !selectedFile}
                onClick={handleStartProcess}
              >
                {isProcessing ? '분석 중...' : '🚀 AI 회의록 분석 및 생성 시작'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 회의 상세 뷰어 모달 ───────────────────────────────────── */}
      {selectedMeeting && (
        <div className="modal-overlay" onClick={() => setSelectedMeeting(null)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                <span>🎙️</span> {selectedMeeting.title}
              </h2>
              <button className="close-btn" onClick={() => setSelectedMeeting(null)}>×</button>
            </div>

            <div className="modal-body">
              {/* 회의 메타 정보 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: '0.8rem', fontSize: '0.85rem', color: '#94a3b8' }}>
                  <span>📅 {selectedMeeting.meeting_date} {selectedMeeting.start_time}</span>
                  {selectedMeeting.duration_sec > 0 && (
                    <span>⏳ {formatDuration(selectedMeeting.duration_sec)}</span>
                  )}
                </div>
                <div className="card-tags">
                  {selectedMeeting.tags?.map((t, i) => (
                    <span key={i} className="tag-badge">#{t}</span>
                  ))}
                </div>
              </div>

              {/* 회의 오디오/비디오 플레이어 */}
              {selectedMeeting.audio_file && (
                <div className="audio-player-wrapper">
                  <span style={{ fontSize: '1.2rem' }}>🎧</span>
                  <audio
                    ref={audioRef}
                    controls
                    src={`http://localhost:8000/api/media/${encodeURIComponent(selectedMeeting.audio_file)}`}
                  />
                </div>
              )}

              {/* 상세 탭 네비게이션 */}
              <div className="detail-modal-tabs">
                <button
                  className={`detail-tab-btn ${detailTab === 'summary' ? 'active' : ''}`}
                  onClick={() => setDetailTab('summary')}
                >
                  📝 AI 회의록 요약
                </button>
                <button
                  className={`detail-tab-btn ${detailTab === 'actions' ? 'active' : ''}`}
                  onClick={() => setDetailTab('actions')}
                >
                  🚀 액션 아이템 ({selectedMeeting.action_items?.length || 0})
                </button>
                <button
                  className={`detail-tab-btn ${detailTab === 'transcript' ? 'active' : ''}`}
                  onClick={() => setDetailTab('transcript')}
                >
                  💬 대화록 전문 ({selectedMeeting.full_transcript?.length || 0})
                </button>
              </div>

              {/* 탭 1: AI 회의록 요약 */}
              {detailTab === 'summary' && (() => {
                const parsed = parseMeetingSummary(selectedMeeting.summary)
                const allAgendaIds = parsed?.agendaList.map(a => a.id) || []
                const isAllCollapsed = allAgendaIds.length > 0 && collapsedAgendas.size >= allAgendaIds.length

                return (
                  <div className="summary-tab-container">
                    {/* 상단 툴바 */}
                    <div className="summary-toolbar">
                      <div className="summary-toolbar-left">
                        <span className="timeline-badge">
                          ⏱️ <strong>실제 녹음 시간 순서(타임라인)</strong> 동기화
                        </span>
                        {/* 뷰 모드 토글 스위치 */}
                        <div className="view-mode-toggle">
                          <button
                            type="button"
                            className={`view-mode-btn ${summaryViewMode === 'card' ? 'active' : ''}`}
                            onClick={() => setSummaryViewMode('card')}
                          >
                            🎨 구조화 카드 뷰
                          </button>
                          <button
                            type="button"
                            className={`view-mode-btn ${summaryViewMode === 'raw' ? 'active' : ''}`}
                            onClick={() => setSummaryViewMode('raw')}
                          >
                            📝 원문 텍스트
                          </button>
                        </div>
                      </div>

                      <div className="summary-toolbar-right">
                        {summaryViewMode === 'card' && allAgendaIds.length > 0 && (
                          <button
                            type="button"
                            className="btn-toolbar-subtle"
                            onClick={() => toggleAllAgendas(allAgendaIds)}
                            title={isAllCollapsed ? '모든 안건 펼치기' : '모든 안건 접기'}
                          >
                            {isAllCollapsed ? '📂 모두 펼치기' : '📁 모두 접기'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn-toolbar-accent"
                          onClick={handleResummarize}
                          disabled={isResummarizing}
                        >
                          {isResummarizing ? '⏳ 시간순 요약 중...' : '🔄 녹음 순서대로 다시 요약'}
                        </button>
                        <button type="button" className="btn-toolbar-subtle" onClick={handleCopySummary}>
                          📋 전체 복사
                        </button>
                      </div>
                    </div>

                    {/* 카드 뷰 */}
                    {summaryViewMode === 'card' && parsed && parsed.isStructured ? (
                      <div className="structured-summary-wrapper">
                        {/* 1. 진행 순서별 3줄 핵심 요약 */}
                        {parsed.keySummary.length > 0 && (
                          <div className="summary-section-card highlight-card">
                            <div className="section-card-header">
                              <span className="section-card-icon">📌</span>
                              <h3 className="section-card-title">진행 순서별 핵심 요약</h3>
                              <span className="section-card-sub">초반 ➔ 중반 ➔ 후반 3단계 요약</span>
                            </div>
                            <div className="key-summary-grid">
                              {parsed.keySummary.map((item, idx) => {
                                const stepMeta = [
                                  { label: '1. 회의 초반', icon: '🌅', color: '#38bdf8' },
                                  { label: '2. 회의 중반', icon: '⚡', color: '#f59e0b' },
                                  { label: '3. 회의 후반/결론', icon: '🏁', color: '#10b981' },
                                ][idx] || { label: `${idx + 1}단계`, icon: '💡', color: '#a855f7' }

                                return (
                                  <div key={idx} className="key-summary-item" style={{ borderLeftColor: stepMeta.color }}>
                                    <div className="key-summary-item-header" style={{ color: stepMeta.color }}>
                                      <span>{stepMeta.icon}</span>
                                      <strong>{stepMeta.label}</strong>
                                    </div>
                                    <p className="key-summary-item-text">{renderFormattedText(item)}</p>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* 2. 타임라인 주요 논의 사항 로드맵 */}
                        {parsed.agendaList.length > 0 && (
                          <div className="summary-section-card agenda-timeline-card">
                            <div className="section-card-header">
                              <span className="section-card-icon">🗣️</span>
                              <h3 className="section-card-title">주요 논의 사항 (타임라인 로드맵)</h3>
                              <span className="section-card-sub">
                                💡 타임코드를 클릭하면 해당 구간 녹음 위치로 즉시 이동합니다
                              </span>
                            </div>

                            <div className="agenda-timeline-list">
                              {parsed.agendaList.map((agenda, aIdx) => {
                                const isCollapsed = collapsedAgendas.has(agenda.id)

                                return (
                                  <div key={agenda.id} className={`agenda-timeline-item ${isCollapsed ? 'collapsed' : ''}`}>
                                    <div className="agenda-timeline-indicator">
                                      <div className="timeline-dot" />
                                      {aIdx < parsed.agendaList.length - 1 && <div className="timeline-line" />}
                                    </div>

                                    <div className="agenda-card-box">
                                      <div
                                        className="agenda-card-top"
                                        onClick={() => toggleAgendaCollapse(agenda.id)}
                                      >
                                        <div className="agenda-top-left">
                                          {agenda.timeRange && (
                                            <button
                                              type="button"
                                              className="time-jump-badge"
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                handleSeekAudio(agenda.startSec)
                                              }}
                                              title={`${agenda.timeRange} 지점으로 오디오 이동`}
                                            >
                                              <span className="jump-icon">🎧</span>
                                              <span className="jump-time">{agenda.timeRange}</span>
                                              <span className="jump-label">바로듣기</span>
                                            </button>
                                          )}
                                          <h4 className="agenda-card-heading">
                                            {renderFormattedText(agenda.title)}
                                          </h4>
                                        </div>
                                        <div className="agenda-top-right">
                                          <span className="collapse-arrow">{isCollapsed ? '▼' : '▲'}</span>
                                        </div>
                                      </div>

                                      {!isCollapsed && agenda.details.length > 0 && (
                                        <div className="agenda-card-body">
                                          <ul className="agenda-detail-bullets">
                                            {agenda.details.map((detail, dIdx) => (
                                              <li key={dIdx} className="agenda-bullet-point">
                                                {renderFormattedText(detail)}
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* 3. 최종 결정 사항 */}
                        {parsed.decisions.length > 0 && (
                          <div className="summary-section-card decision-card">
                            <div className="section-card-header">
                              <span className="section-card-icon">✅</span>
                              <h3 className="section-card-title">최종 결정 사항</h3>
                              <span className="section-card-sub">확정된 정책 및 합의된 방향</span>
                            </div>
                            <div className="decision-list">
                              {parsed.decisions.map((dec, dIdx) => (
                                <div key={dIdx} className="decision-item">
                                  <span className="decision-number">{dIdx + 1}</span>
                                  <p className="decision-text">{renderFormattedText(dec)}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* 4. 태그 */}
                        {parsed.tags.length > 0 && (
                          <div className="summary-tags-row">
                            <span className="tag-row-label">🏷️ 키워드 태그:</span>
                            <div className="tag-badges-wrapper">
                              {parsed.tags.map((t, idx) => (
                                <span key={idx} className="rich-tag-chip">#{t}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* 원문 마크다운 텍스트 뷰 (fallback 또는 raw 모드) */
                      <div className="summary-content-rendered">
                        {selectedMeeting.summary || '(요약 내용이 없습니다)'}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* 탭 2: 액션 아이템 체크리스트 */}
              {detailTab === 'actions' && (
                <div className="action-items-checklist">
                  {(!selectedMeeting.action_items || selectedMeeting.action_items.length === 0) ? (
                    <div className="empty-state">
                      <span>✅</span>
                      <p>추출된 액션 아이템이 없습니다.</p>
                    </div>
                  ) : (
                    selectedMeeting.action_items.map(item => (
                      <div
                        key={item.id}
                        className={`action-item-row ${item.done ? 'done' : ''}`}
                        onClick={() => handleToggleAction(item.id, item.done)}
                      >
                        <input
                          type="checkbox"
                          className="action-checkbox"
                          checked={item.done}
                          onChange={() => {}} // 부모 div 클릭으로 처리
                        />
                        <span className="action-text">{item.task}</span>
                        <div className="action-meta-box">
                          {item.assignee && <span className="assignee-badge">👤 {item.assignee}</span>}
                          {item.due_date && <span className="due-badge">📅 {item.due_date}</span>}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* 탭 3: 대화록 전문 */}
              {detailTab === 'transcript' && (
                <div className="transcript-timeline">
                  {(!selectedMeeting.full_transcript || selectedMeeting.full_transcript.length === 0) ? (
                    <div className="empty-state">
                      <span>💬</span>
                      <p>추출된 대화록이 없습니다.</p>
                    </div>
                  ) : (
                    selectedMeeting.full_transcript.map(seg => (
                      <div
                        key={seg.id}
                        className="transcript-line"
                        onClick={() => handleSeekAudio(seg.start)}
                        title="클릭하여 이 시점부터 재생"
                      >
                        <span className="transcript-time">
                          {Math.floor(seg.start / 60)}:{String(Math.floor(seg.start % 60)).padStart(2, '0')}
                        </span>
                        <span className="transcript-msg">{seg.text}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn-secondary"
                style={{ color: '#f87171', borderColor: 'rgba(248, 113, 113, 0.3)' }}
                onClick={() => handleDeleteMeeting(selectedMeeting.id)}
              >
                🗑️ 회의록 삭제
              </button>
              <button className="btn-secondary" onClick={() => setSelectedMeeting(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 수동 회의록 작성 모달 ─────────────────────────────────── */}
      {isManualModalOpen && (
        <div className="modal-overlay" onClick={() => setIsManualModalOpen(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2><span>✍️</span> 회의록 직접 작성</h2>
              <button className="close-btn" onClick={() => setIsManualModalOpen(false)}>×</button>
            </div>

            <form onSubmit={handleManualSubmit}>
              <div className="modal-body">
                <div className="form-field">
                  <label>회의 제목 *</label>
                  <input
                    type="text"
                    required
                    className="form-input"
                    placeholder="예: 정기 기획 회의"
                    value={manualForm.title}
                    onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
                  />
                </div>

                <div className="form-group-grid">
                  <div className="form-field">
                    <label>회의 일자</label>
                    <input
                      type="date"
                      className="form-input"
                      value={manualForm.meeting_date}
                      onChange={e => setManualForm({ ...manualForm, meeting_date: e.target.value })}
                    />
                  </div>
                  <div className="form-field">
                    <label>시작 시간</label>
                    <input
                      type="time"
                      className="form-input"
                      value={manualForm.start_time}
                      onChange={e => setManualForm({ ...manualForm, start_time: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-field">
                  <label>태그 (콤마로 구분)</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="컴짱회의, 주간회의, 기획"
                    value={manualForm.tags}
                    onChange={e => setManualForm({ ...manualForm, tags: e.target.value })}
                  />
                </div>

                <div className="form-field">
                  <label>회의 내용 및 요약</label>
                  <textarea
                    rows={8}
                    className="form-input"
                    placeholder="회의 주요 안건, 결정 사항, 액션 아이템 등을 작성해주세요."
                    value={manualForm.summary}
                    onChange={e => setManualForm({ ...manualForm, summary: e.target.value })}
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setIsManualModalOpen(false)}
                >
                  취소
                </button>
                <button type="submit" className="btn-primary-gradient">
                  저장하기
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── 날짜별 자동 정리 및 일괄 등록 진행 모달 ────────────────── */}
      {isAutoProcessing && (
        <div className="modal-overlay">
          <div className="modal-container auto-process-modal">
            <div className="modal-header">
              <h2>
                <span className="auto-spin-icon">⚡</span> 날짜별 회의록 자동 정리 및 등록 중...
              </h2>
            </div>
            <div className="modal-body">
              <div className="auto-progress-card">
                <div className="auto-progress-header">
                  <span className="auto-batch-badge">
                    {autoProgress.total > 1 ? `진행률: ${autoProgress.current} / ${autoProgress.total}` : '원클릭 자동 등록'}
                  </span>
                  {autoProgress.meetingDate && (
                    <span className="auto-date-badge">
                      📅 {autoProgress.meetingDate} {autoProgress.startTime}
                    </span>
                  )}
                </div>

                <div className="auto-current-file-box">
                  <span className="file-icon">🎥</span>
                  <span className="file-name">{autoProgress.currentFile}</span>
                </div>

                {/* 3단계 진행 인디케이터 */}
                <div className="process-steps-indicator">
                  <div className={`step-item ${autoProgress.step >= 1 ? 'active' : ''} ${autoProgress.step > 1 ? 'done' : ''}`}>
                    <span className="step-num">{autoProgress.step > 1 ? '✓' : '1'}</span>
                    <span className="step-text">로컬 음성인식 (Whisper)</span>
                  </div>
                  <div className={`step-item ${autoProgress.step >= 2 ? 'active' : ''} ${autoProgress.step > 2 ? 'done' : ''}`}>
                    <span className="step-num">{autoProgress.step > 2 ? '✓' : '2'}</span>
                    <span className="step-text">AI 회의록 요약 (Gemini)</span>
                  </div>
                  <div className={`step-item ${autoProgress.step >= 3 ? 'active' : ''} ${autoProgress.step > 3 ? 'done' : ''}`}>
                    <span className="step-num">{autoProgress.step > 3 ? '✓' : '3'}</span>
                    <span className="step-text">캘린더 DB 등록</span>
                  </div>
                </div>

                <div className="auto-progress-msg-box">
                  <span className="pulsing-dot">●</span>
                  <span className="msg-text">{autoProgress.message || 'AI가 열심히 분석하고 정리하고 있습니다...'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Meetings

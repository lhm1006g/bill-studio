import { useState, useEffect, useRef } from 'react'
import './Schedule.css'

const API_BASE = 'http://localhost:8000/api/schedule'

// 스튜디오 특화 프리셋 템플릿
const PRESETS = [
  { label: '💻 컴짱 회의 업무', colorId: '7', color: '#039be5', defaultDesc: '컴짱 회의에서 도출된 마감 및 실행 업무', isRoutine: false, isComjjang: true },
  { label: '🎬 영상 업로드', colorId: '11', color: '#ef4444', defaultDesc: '유튜브 채널에 최종 완성본 영상 업로드 및 공개', isRoutine: false, isComjjang: false },
  { label: '✂️ 영상 편집 마감', colorId: '3', color: '#a855f7', defaultDesc: '컷 편집 및 자막 싱크 완료', isRoutine: false, isComjjang: false },
  { label: '💡 콘텐츠 기획 & 대본', colorId: '2', color: '#10b981', defaultDesc: '새 영상 주제 선정 및 스크립트 작성', isRoutine: false, isComjjang: false },
  { label: '🎙️ AI 성우 더빙/녹음', colorId: '6', color: '#f97316', defaultDesc: 'AI 목소리 더빙 렌더링 및 BGM 믹싱', isRoutine: false, isComjjang: false },
  { label: '🚲 자전거 / 운동 루틴', colorId: '5', color: '#eab308', defaultDesc: '매일 저녁 유산소 자전거 타기 및 건강 관리', isRoutine: true, isComjjang: false },
  { label: '📌 중요 일정', colorId: '9', color: '#3b82f6', defaultDesc: '', isRoutine: false, isComjjang: false },
]

// 구글 캘린더 색상 팔레트 매핑
const GOOGLE_COLORS = {
  '1': '#7986cb',  // 라벤더
  '2': '#33b679',  // 세이지/녹색
  '3': '#8e24aa',  // 포도/보라
  '4': '#e67c73',  // 플라밍고
  '5': '#f6bf26',  // 바나나/노랑
  '6': '#f4511e',  // 귤/주황
  '7': '#039be5',  // 공작/파랑 (컴짱 기본)
  '8': '#616161',  // 흑연
  '9': '#3f51b5',  // 블루베리
  '10': '#0b8043', // 바질
  '11': '#d50000', // 토마토/빨강
}

const WEEKDAYS_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']

function Schedule() {
  const [authStatus, setAuthStatus] = useState({
    has_credentials: true,
    is_authenticated: false,
    account_email: null,
    auth_in_progress: false,
    auth_url: null,
    error: null,
  })
  const [loading, setLoading] = useState(false)
  const [authPolling, setAuthPolling] = useState(false)
  const [events, setEvents] = useState([])
  const [currentDate, setCurrentDate] = useState(new Date())
  const [viewMode, setViewMode] = useState('month') // 'month' | 'agenda'
  
  // 👁️ 캘린더 보기 모드 ('all': 전체 함께 보기 | 'mine': 내 스튜디오 일정만 | 'comjjang': 컴짱 회의 일정만)
  const [calendarFilter, setCalendarFilter] = useState('all')

  // 🚲 일상 루틴 필터 (기본값: 루틴 숨김! 주요 일정만 깔끔하게 보기)
  const [hideRoutines, setHideRoutines] = useState(true)

  // 📅 해당 날짜 상세 팝업 상태 (선택된 날짜 및 아코디언 상태)
  const [dayDetailDate, setDayDetailDate] = useState(null)
  const [expandedEventIds, setExpandedEventIds] = useState(new Set())

  // 일정 작성 / 수정 모달 상태
  const [modalOpen, setModalOpen] = useState(false)
  const [modalMode, setModalMode] = useState('create') // 'create' | 'edit'
  const [selectedEventId, setSelectedEventId] = useState(null)
  const [eventForm, setEventForm] = useState({
    title: '',
    description: '',
    start_time: '',
    end_time: '',
    all_day: false,
    is_routine: false,
    is_comjjang: false,
    calendar_id: 'primary',
    color_id: '9',
    location: '',
  })
  const [notification, setNotification] = useState(null)

  const showToast = (message, type = 'info') => {
    setNotification({ message, type })
    setTimeout(() => setNotification(null), 4000)
  }

  // 1. 인증 상태 확인
  const checkAuthStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/status`)
      const data = await res.json()
      setAuthStatus(data)
      return data
    } catch (e) {
      console.error('인증 상태 조회 실패:', e)
    }
    return null
  }

  useEffect(() => {
    checkAuthStatus()
  }, [])

  // 2. 인증 시작 및 폴링
  const handleStartAuth = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/start`, { method: 'POST' })
      const data = await res.json()
      if (data.auth_url) {
        window.open(data.auth_url, '_blank')
      }
      showToast('구글 로그인 창이 열렸습니다. 권한을 승인해주세요!', 'info')
      setAuthPolling(true)
    } catch (e) {
      showToast('인증 시작 실패: ' + e.message, 'error')
    }
  }

  // 폴링으로 인증 완료 감지
  useEffect(() => {
    if (!authPolling) return
    const timer = setInterval(async () => {
      const status = await checkAuthStatus()
      if (status && status.is_authenticated) {
        setAuthPolling(false)
        showToast(`🎉 구글 캘린더 연동 성공! (${status.account_email})`, 'success')
        fetchEvents()
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [authPolling])

  // 3. 로그아웃
  const handleLogout = async () => {
    if (!confirm('구글 캘린더 연동을 해제하시겠습니까?')) return
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST' })
      showToast('구글 캘린더 연동이 해제되었습니다.', 'info')
      checkAuthStatus()
      setEvents([])
    } catch (e) {
      showToast('해제 실패: ' + e.message, 'error')
    }
  }

  // 4. 구글에 일상 루틴 캘린더 자동 생성
  const handleCreateRoutineCalendar = async () => {
    try {
      const res = await fetch(`${API_BASE}/calendars/create-routine`, { method: 'POST' })
      if (!res.ok) throw new Error('루틴 캘린더 생성 실패')
      showToast('구글 계정에 "🚲 일상 루틴" 전용 캘린더가 생성되었습니다!', 'success')
      fetchEvents()
    } catch (e) {
      showToast('오류: ' + e.message, 'error')
    }
  }

  // 4-1. 구글에 '💻 컴짱 회의' 캘린더 자동 생성
  const handleCreateComjjangCalendar = async () => {
    try {
      const res = await fetch(`${API_BASE}/calendars/create-comjjang`, { method: 'POST' })
      if (!res.ok) throw new Error('컴짱 캘린더 생성 실패')
      const data = await res.json()
      showToast(data.message || '구글 계정에 "💻 컴짱 회의" 캘린더가 준비되었습니다!', 'success')
      fetchEvents()
    } catch (e) {
      showToast('오류: ' + e.message, 'error')
    }
  }

  // 5. 일정 목록 불러오기
  const fetchEvents = async () => {
    setLoading(true)
    try {
      const year = currentDate.getFullYear()
      const month = currentDate.getMonth()
      const start = new Date(year, month - 1, 1).toISOString()
      const end = new Date(year, month + 2, 0).toISOString()

      const res = await fetch(`${API_BASE}/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}`)
      if (!res.ok) throw new Error('일정 목록 불러오기 실패')
      const data = await res.json()
      setEvents(data.events || [])
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEvents()
  }, [authStatus.is_authenticated, currentDate])

  // 월 이동 네비게이션
  const handlePrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))
  }
  const handleNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))
  }
  const handleToday = () => {
    setCurrentDate(new Date())
  }

  // 📅 날짜 상세 팝업 열기 (타이틀 위주 뷰 & 아코디언)
  const openDayDetailModal = (dateStr) => {
    setDayDetailDate(dateStr)
    const dayEvs = events.filter(ev => {
      if (!ev.start) return false
      const s = ev.start.slice(0, 10)
      const e = ev.end ? ev.end.slice(0, 10) : s
      return dateStr >= s && dateStr <= e
    })
    // 일정이 1개일 때만 자동 펼침, 2개 이상일 때는 가독성을 위해 타이틀 위주로 접어둠
    if (dayEvs.length === 1) {
      setExpandedEventIds(new Set([dayEvs[0].id]))
    } else {
      setExpandedEventIds(new Set())
    }
  }

  // 일정 펼침/접힘 토글
  const toggleEventExpand = (id) => {
    setExpandedEventIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 전체 펼치기 / 전체 접기
  const expandAllEvents = () => {
    setExpandedEventIds(new Set(selectedDayAllEvents.map(e => e.id)))
  }
  const collapseAllEvents = () => {
    setExpandedEventIds(new Set())
  }

  // 일정 생성 모달 열기
  const openCreateModal = (dateStr = null) => {
    const defaultDate = dateStr || (dayDetailDate || new Date().toISOString().slice(0, 10))
    setModalMode('create')
    setSelectedEventId(null)
    setEventForm({
      title: '',
      description: '',
      start_time: `${defaultDate}T09:00:00`,
      end_time: `${defaultDate}T10:00:00`,
      all_day: false,
      is_routine: false,
      is_comjjang: calendarFilter === 'comjjang',
      calendar_id: calendarFilter === 'comjjang' ? 'comjjang' : 'primary',
      color_id: calendarFilter === 'comjjang' ? '7' : '9',
      location: '',
    })
    setModalOpen(true)
  }

  // 일정 클릭 시 상세/수정 모달 열기
  const openEditModal = (event) => {
    setModalMode('edit')
    setSelectedEventId(event.id)
    
    let st = event.start || ''
    let et = event.end || ''
    if (event.all_day) {
      st = st.slice(0, 10)
      et = et.slice(0, 10)
    } else {
      if (st.length > 16) st = st.slice(0, 19)
      if (et.length > 16) et = et.slice(0, 19)
    }

    setEventForm({
      title: event.title || '',
      description: event.description || '',
      start_time: st,
      end_time: et,
      all_day: !!event.all_day,
      is_routine: !!event.is_routine,
      is_comjjang: !!event.is_comjjang,
      calendar_id: event.calendar_id || 'primary',
      color_id: event.color_id || '9',
      location: event.location || '',
    })
    setModalOpen(true)
  }

  // 일정 저장 (생성 / 수정)
  const handleSaveEvent = async (e) => {
    e.preventDefault()
    if (!eventForm.title.trim()) {
      showToast('일정 제목을 입력해주세요.', 'error')
      return
    }

    setLoading(true)
    try {
      let bodyData = { ...eventForm }
      if (bodyData.all_day) {
        bodyData.start_time = bodyData.start_time.slice(0, 10)
        bodyData.end_time = bodyData.end_time.slice(0, 10)
      }

      if (modalMode === 'create') {
        const res = await fetch(`${API_BASE}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyData)
        })
        if (!res.ok) throw new Error('일정 등록 실패')
        showToast('일정이 성공적으로 등록되었습니다! 📱 스마트폰 동기화', 'success')
      } else {
        const res = await fetch(`${API_BASE}/events/${selectedEventId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyData)
        })
        if (!res.ok) throw new Error('일정 수정 실패')
        showToast('일정이 수정되었습니다.', 'success')
      }

      setModalOpen(false)
      fetchEvents()
    } catch (e) {
      showToast('오류 발생: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  // 일정 삭제
  const handleDeleteEvent = async (eventId = null) => {
    const idToDelete = eventId || selectedEventId
    if (!idToDelete) return
    if (!confirm('정말로 이 일정을 삭제하시겠습니까?')) return

    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/events/${idToDelete}`, {
        method: 'DELETE'
      })
      if (!res.ok) throw new Error('일정 삭제 실패')
      showToast('일정이 삭제되었습니다.', 'info')
      setModalOpen(false)
      fetchEvents()
    } catch (e) {
      showToast('삭제 실패: ' + e.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  // 프리셋 선택 적용
  const applyPreset = (preset) => {
    setEventForm(prev => ({
      ...prev,
      title: prev.title ? `${preset.label} - ${prev.title}` : preset.label,
      color_id: preset.colorId,
      description: prev.description || preset.defaultDesc,
      is_routine: !!preset.isRoutine,
      is_comjjang: !!preset.isComjjang,
      calendar_id: preset.isComjjang ? 'comjjang' : prev.calendar_id,
    }))
  }

  // 👁️ 필터링된 이벤트 목록 (루틴 숨김 및 캘린더 모드 적용)
  const displayEvents = events.filter(ev => {
    // 1. 일상 루틴 숨김 체크
    if (hideRoutines && ev.is_routine) {
      return false
    }
    // 2. 휴일(is_holiday)은 어떤 필터 모드에서도 달력에 상시 유지 (휴일 여부를 놓치지 않도록 보장)
    if (ev.is_holiday) {
      return true
    }
    // 3. 캘린더 보기 모드 체크
    if (calendarFilter === 'mine' && ev.is_comjjang) {
      return false
    }
    if (calendarFilter === 'comjjang' && !ev.is_comjjang) {
      return false
    }
    return true
  })

  // 일정 통계
  const allEventsCount = events.filter(ev => !ev.is_routine && !ev.is_holiday).length
  const mineEventsCount = events.filter(ev => !ev.is_routine && !ev.is_comjjang && !ev.is_holiday).length
  const comjjangEventsCount = events.filter(ev => !ev.is_routine && ev.is_comjjang).length
  const holidayEventsCount = events.filter(ev => ev.is_holiday).length
  const routineEventsCount = events.filter(ev => ev.is_routine).length

  // 캘린더 날짜 계산 (월간 그리드)
  const renderMonthDays = () => {
    const year = currentDate.getFullYear()
    const month = currentDate.getMonth()

    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const prevMonthLastDay = new Date(year, month, 0)

    const startDayOfWeek = firstDay.getDay()
    const totalDays = lastDay.getDate()
    const prevDays = prevMonthLastDay.getDate()

    const days = []

    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const d = prevDays - i
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      days.push({ day: d, isCurrentMonth: false, dateStr })
    }

    for (let d = 1; d <= totalDays; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      days.push({ day: d, isCurrentMonth: true, dateStr })
    }

    const remaining = (7 - (days.length % 7)) % 7
    for (let d = 1; d <= remaining; d++) {
      const dateStr = `${year}-${String(month + 2).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      days.push({ day: d, isCurrentMonth: false, dateStr })
    }

    const todayStr = new Date().toISOString().slice(0, 10)

    return days.map((cell, idx) => {
      const isToday = cell.dateStr === todayStr
      const isSelected = cell.dateStr === dayDetailDate
      
      // 요일 판별 (0: 일요일, 6: 토요일)
      const cellDate = new Date(cell.dateStr + 'T00:00:00')
      const dayOfWeek = cellDate.getDay()
      const isSunday = dayOfWeek === 0
      const isSaturday = dayOfWeek === 6

      // 해당 날짜의 법정 공휴일 여부 판별
      const dayHoliday = events.find(ev => {
        if (!ev.is_holiday || !ev.start) return false
        const evStartStr = ev.start.slice(0, 10)
        const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
        return cell.dateStr >= evStartStr && cell.dateStr <= evEndStr
      })

      // 해당 날짜에 걸쳐 있는 표시 대상 이벤트들
      const dayEvents = displayEvents.filter(ev => {
        if (!ev.start) return false
        const evStartStr = ev.start.slice(0, 10)
        const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
        return cell.dateStr >= evStartStr && cell.dateStr <= evEndStr
      })

      // 휴일 이벤트 우선 정렬
      const sortedDayEvents = [...dayEvents].sort((a, b) => {
        if (a.is_holiday && !b.is_holiday) return -1
        if (!a.is_holiday && b.is_holiday) return 1
        return 0
      })

      // 숨겨진 루틴이 오늘 날짜에 있는지 체크
      const hiddenRoutinesToday = events.filter(ev => {
        if (!ev.is_routine) return false
        const evStartStr = ev.start.slice(0, 10)
        const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
        return cell.dateStr >= evStartStr && cell.dateStr <= evEndStr
      })

      return (
        <div
          key={idx}
          className={`calendar-cell ${cell.isCurrentMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'cell-selected' : ''} ${dayHoliday ? 'is-holiday-cell' : ''} ${isSunday ? 'is-sunday-cell' : ''} ${isSaturday ? 'is-saturday-cell' : ''}`}
          onClick={() => openDayDetailModal(cell.dateStr)}
        >
          <div className="cell-header">
            <div className="day-number-row">
              <span className={`day-number ${isToday ? 'today-badge' : ''} ${dayHoliday ? 'holiday-number' : isSunday ? 'sunday-number' : isSaturday ? 'saturday-number' : ''}`}>
                {cell.day}
              </span>

              {/* 숨겨진 루틴이 있을 때 날짜 옆에 미니 뱃지 표시 */}
              {hideRoutines && hiddenRoutinesToday.length > 0 && (
                <span
                  className="routine-mini-badge"
                  title={`오늘의 루틴 ${hiddenRoutinesToday.length}개:\n${hiddenRoutinesToday.map(r => '• ' + r.title).join('\n')}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openDayDetailModal(cell.dateStr)
                  }}
                >
                  🚲
                </span>
              )}
            </div>

            <button
              className="quick-add-btn"
              title="이 날짜에 새 일정 추가"
              onClick={(e) => {
                e.stopPropagation()
                openCreateModal(cell.dateStr)
              }}
            >
              +
            </button>
          </div>
          
          <div className="cell-events">
            {sortedDayEvents.slice(0, 3).map(ev => {
              const color = GOOGLE_COLORS[ev.color_id] || (ev.is_holiday ? '#ef4444' : '#3b82f6')
              const evStartStr = ev.start ? ev.start.slice(0, 10) : ''
              const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
              const isMultiDay = evStartStr !== evEndStr
              
              let timeDisplay = ''
              if (ev.all_day) {
                timeDisplay = ''
              } else if (isMultiDay) {
                if (cell.dateStr === evStartStr) {
                  timeDisplay = `${ev.start.slice(11, 16)}~`
                } else if (cell.dateStr === evEndStr) {
                  timeDisplay = `~${ev.end.slice(11, 16)}`
                } else {
                  timeDisplay = '종일'
                }
              } else {
                timeDisplay = ev.start.slice(11, 16)
              }

              // 🚩 휴일 전용 알약 필 렌더링
              if (ev.is_holiday) {
                return (
                  <div
                    key={`${ev.id}_${cell.dateStr}`}
                    className="event-pill holiday-pill"
                    title={`🚩 [대한민국 공휴일] ${ev.title}\n${ev.description || ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      openDayDetailModal(cell.dateStr)
                    }}
                  >
                    <span className="holiday-flag-icon">🚩</span>
                    <span className="event-title holiday-text">{ev.title}</span>
                  </div>
                )
              }

              return (
                <div
                  key={`${ev.id}_${cell.dateStr}`}
                  className={`event-pill ${isMultiDay ? 'multi-day' : ''} ${ev.is_routine ? 'routine-pill' : ''} ${ev.is_comjjang ? 'comjjang-pill' : ''}`}
                  style={{ borderLeftColor: color }}
                  title={`${ev.is_comjjang ? '💻 [컴짱 회의 일정]\n' : ''}${ev.title}\n${ev.description || ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openDayDetailModal(cell.dateStr)
                  }}
                >
                  <span className="event-color-dot" style={{ background: color }} />
                  {ev.is_comjjang && <span className="comjjang-mini-badge">💻</span>}
                  {timeDisplay && <span className="event-time">{timeDisplay}</span>}
                  <span className="event-title">{ev.title}</span>
                </div>
              )
            })}
            {sortedDayEvents.length > 3 && (
              <div className="more-events">+{sortedDayEvents.length - 3}개 더보기</div>
            )}
          </div>
        </div>
      )
    })
  }

  // 아젠다 목록 뷰 렌더링
  const renderAgendaList = () => {
    if (displayEvents.length === 0) {
      return (
        <div className="empty-agenda">
          <span className="empty-icon">📅</span>
          <p>
            {calendarFilter === 'comjjang'
              ? '컴짱 회의 일정이 없습니다. 회의를 진행하고 일정을 동기화해보세요!'
              : hideRoutines && routineEventsCount > 0
              ? `주요 일정이 없습니다. (일상 루틴 ${routineEventsCount}개가 숨겨져 있습니다)`
              : '등록된 일정이 없습니다. 새 일정을 추가해보세요!'}
          </p>
          {hideRoutines && routineEventsCount > 0 && (
            <button className="secondary-btn" onClick={() => setHideRoutines(false)} style={{ marginBottom: 12 }}>
              🚲 루틴 일정 포함해서 보기
            </button>
          )}
          <br/>
          <button className="primary-btn" onClick={() => openCreateModal()}>
            + 새 일정 만들기
          </button>
        </div>
      )
    }

    return (
      <div className="agenda-list">
        {displayEvents.map(ev => {
          const isHoliday = !!ev.is_holiday
          const color = isHoliday ? '#ef4444' : (GOOGLE_COLORS[ev.color_id] || '#3b82f6')
          const dateStr = ev.start ? ev.start.slice(0, 10) : ''
          const timeStr = isHoliday ? '대한민국 공휴일' : (ev.all_day ? '하루 종일' : `${ev.start?.slice(11, 16)} ~ ${ev.end?.slice(11, 16)}`)

          return (
            <div
              key={ev.id}
              className={`agenda-item ${ev.is_routine ? 'routine-item' : ''} ${ev.is_comjjang ? 'comjjang-agenda-item' : ''} ${isHoliday ? 'holiday-agenda-item' : ''}`}
              onClick={() => openEditModal(ev)}
            >
              <div className="agenda-color-bar" style={{ background: color }} />
              <div className="agenda-date-box">
                <span className={`agenda-date-day ${isHoliday ? 'holiday-date-text' : ''}`}>{dateStr.slice(8, 10)}</span>
                <span className="agenda-date-month">{dateStr.slice(5, 7)}월</span>
              </div>
              <div className="agenda-info">
                <div className="agenda-title-row">
                  <h4 className="agenda-title">{isHoliday ? `🚩 ${ev.title}` : ev.title}</h4>
                  {isHoliday && <span className="holiday-badge-tag">🔴 법정 공휴일</span>}
                  {ev.is_comjjang && <span className="comjjang-tag">💻 컴짱 회의</span>}
                  {ev.is_routine && <span className="routine-tag">🚲 루틴</span>}
                  <span className="agenda-badge" style={{ backgroundColor: `${color}20`, color: color }}>
                    {isHoliday ? '공휴일' : ev.all_day ? '종일' : '시간'}
                  </span>
                </div>
                <div className="agenda-meta">
                  <span className="agenda-time">⏱️ {timeStr}</span>
                  {ev.location && <span className="agenda-location">📍 {ev.location}</span>}
                </div>
                {ev.description && <p className="agenda-desc">{ev.description}</p>}
              </div>
              <div className="agenda-action">
                <button className="icon-btn edit" title="수정">✏️</button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // 선택된 날짜의 이벤트 목록 (상세 팝업용: 루틴 포함 전체)
  const selectedDayAllEvents = dayDetailDate
    ? events.filter(ev => {
        if (!ev.start) return false
        const evStartStr = ev.start.slice(0, 10)
        const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
        return dayDetailDate >= evStartStr && dayDetailDate <= evEndStr
      })
    : []

  // 선택된 날짜 정보 포맷
  const getDayDetailHeader = () => {
    if (!dayDetailDate) return ''
    const parts = dayDetailDate.split('-')
    const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
    const weekday = WEEKDAYS_KO[d.getDay()]
    return `${parts[0]}년 ${parseInt(parts[1])}월 ${parseInt(parts[2])}일 (${weekday})`
  }

  const currentYear = currentDate.getFullYear()
  const currentMonth = currentDate.getMonth() + 1
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div className="schedule-container">
      {/* 토스트 알림 */}
      {notification && (
        <div className={`toast-notification ${notification.type}`}>
          {notification.type === 'success' && '✅ '}
          {notification.type === 'error' && '⚠️ '}
          {notification.type === 'info' && '💡 '}
          {notification.message}
        </div>
      )}

      {/* 상단 헤더 & 구글 연동 상태 바 */}
      <div className="schedule-header">
        <div className="header-left">
          <div className="page-title-row">
            <span className="title-icon">📅</span>
            <div>
              <h1 className="page-title">스튜디오 일정 & 캘린더</h1>
              <p className="page-subtitle">Google Calendar와 실시간 연동되어 스마트폰 및 모든 기기에서 동기화됩니다</p>
            </div>
          </div>
        </div>

        <div className="header-right">
          {authStatus.is_authenticated ? (
            <div className="auth-connected-box">
              <span className="auth-status-dot" />
              <div className="auth-info">
                <span className="auth-account">{authStatus.account_email || 'Google Calendar'}</span>
                <span className="auth-badge">실시간 동기화 중</span>
              </div>
              <button className="sync-btn" onClick={fetchEvents} title="새로고침" disabled={loading}>
                {loading ? '동기화 중...' : '🔄 동기화'}
              </button>
              <button className="logout-btn" onClick={handleLogout} title="연동 해제">
                해제
              </button>
            </div>
          ) : (
            <button
              className="google-connect-btn"
              onClick={handleStartAuth}
              disabled={authPolling}
            >
              <svg className="google-icon" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              {authPolling ? '브라우저에서 로그인 승인 대기 중...' : 'Google 캘린더 원클릭 연동'}
            </button>
          )}

          <button className="primary-btn add-btn" onClick={() => openCreateModal()}>
            + 새 일정 추가
          </button>
        </div>
      </div>

      {/* 👁️ 캘린더 보기 모드 및 스마트 필터 바 */}
      <div className="smart-filter-bar">
        <div className="calendar-view-tabs">
          <button
            className={`cal-filter-tab ${calendarFilter === 'all' ? 'active' : ''}`}
            onClick={() => setCalendarFilter('all')}
            title="스튜디오 일정과 컴짱 회의 일정을 모두 함께 봅니다"
          >
            <span className="cal-tab-icon">🌟</span>
            <span className="cal-tab-title">전체 함께 보기</span>
            <span className="cal-tab-count">{allEventsCount}</span>
          </button>

          <button
            className={`cal-filter-tab mine ${calendarFilter === 'mine' ? 'active' : ''}`}
            onClick={() => setCalendarFilter('mine')}
            title="컴짱 회의 일정을 제외한 내 스튜디오/개인 일정만 봅니다"
          >
            <span className="cal-tab-dot primary" />
            <span className="cal-tab-title">📌 내 일정만 보기</span>
            <span className="cal-tab-count">{mineEventsCount}</span>
          </button>

          <button
            className={`cal-filter-tab comjjang ${calendarFilter === 'comjjang' ? 'active' : ''}`}
            onClick={() => setCalendarFilter('comjjang')}
            title="컴짱 회의에서 도출된 업무 및 마감 일정만 집중적으로 봅니다"
          >
            <span className="cal-tab-dot comjjang" />
            <span className="cal-tab-title">💻 컴짱 회의만 보기</span>
            <span className="cal-tab-count">{comjjangEventsCount}</span>
          </button>
        </div>

        <div className="filter-right-tools">
          <div
            className={`routine-toggle-btn ${!hideRoutines ? 'active' : 'dimmed'}`}
            onClick={() => setHideRoutines(!hideRoutines)}
            title="클릭하여 매일 반복되는 자전거/운동 루틴 표시 여부를 전환합니다"
          >
            <span className="filter-dot routine" />
            <span className="filter-title">🚲 일상 루틴 ({routineEventsCount}개)</span>
            <span className={`toggle-chip ${hideRoutines ? 'off' : 'on'}`}>
              {hideRoutines ? '숨김' : '표시'}
            </span>
          </div>

          {authStatus.is_authenticated && (
            <div className="google-subcal-actions">
              <button
                className="create-comjjang-cal-btn"
                onClick={handleCreateComjjangCalendar}
                title="구글 계정에 '💻 컴짱 회의' 전용 보조 캘린더를 생성/동기화합니다"
              >
                + 구글 '💻 컴짱' 캘린더
              </button>
              <button
                className="create-routine-cal-btn"
                onClick={handleCreateRoutineCalendar}
                title="구글 계정에 '일상 루틴' 전용 보조 캘린더를 생성합니다"
              >
                + 구글 '🚲 루틴' 캘린더
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 캘린더 툴바 (날짜 네비게이션 & 뷰 전환) */}
      <div className="calendar-toolbar">
        <div className="toolbar-left">
          <h2 className="current-month-label">
            {currentYear}년 {currentMonth}월
          </h2>
          <div className="nav-btn-group">
            <button className="toolbar-btn" onClick={handlePrevMonth} title="이전 달">◀</button>
            <button className="toolbar-btn today" onClick={handleToday}>오늘</button>
            <button className="toolbar-btn" onClick={handleNextMonth} title="다음 달">▶</button>
          </div>
        </div>

        <div className="toolbar-right">
          <div className="view-mode-toggle">
            <button
              className={`view-toggle-btn ${viewMode === 'month' ? 'active' : ''}`}
              onClick={() => setViewMode('month')}
            >
              📅 월간 뷰
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'agenda' ? 'active' : ''}`}
              onClick={() => setViewMode('agenda')}
            >
              📋 목록 뷰
            </button>
          </div>
        </div>
      </div>

      {/* 캘린더 메인 컨텐츠 영역 */}
      <div className="calendar-main-content">
        {viewMode === 'month' ? (
          <div className="month-grid-wrapper">
            <div className="weekday-header">
              <span className="weekday sunday">일</span>
              <span className="weekday">월</span>
              <span className="weekday">화</span>
              <span className="weekday">수</span>
              <span className="weekday">목</span>
              <span className="weekday">금</span>
              <span className="weekday saturday">토</span>
            </div>
            <div className="month-grid">
              {renderMonthDays()}
            </div>
          </div>
        ) : (
          renderAgendaList()
        )}
      </div>

      {/* ========================================================
          📅 1. 해당 일자 상세 팝업 (Day Details Modal)
          ======================================================== */}
      {dayDetailDate && (
        <div className="modal-backdrop" onClick={() => setDayDetailDate(null)}>
          <div className="modal-content day-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="day-detail-header-info">
                <h3>{getDayDetailHeader()}</h3>
                {dayDetailDate === todayStr && <span className="today-chip">오늘</span>}
              </div>
              <button className="close-btn" onClick={() => setDayDetailDate(null)}>✕</button>
            </div>

            <div className="day-detail-body">
              {/* 🚩 공휴일 감지 시 상단 공휴일 배너 */}
              {(() => {
                const dayHoliday = selectedDayAllEvents.find(ev => ev.is_holiday)
                if (!dayHoliday) return null
                return (
                  <div className="day-detail-holiday-banner">
                    <div className="holiday-banner-left">
                      <span className="holiday-banner-icon">🚩</span>
                      <div className="holiday-banner-text">
                        <div className="holiday-banner-header">
                          <h4 className="holiday-banner-title">{dayHoliday.title}</h4>
                          <span className="holiday-badge-tag">🔴 대한민국 공휴일</span>
                        </div>
                        <p className="holiday-banner-desc">
                          {dayHoliday.description || '대한민국 법정 공휴일 (휴무일)'}
                        </p>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* 상단 액션 바 */}
              <div className="day-detail-actions-row">
                <div className="day-detail-count-group">
                  <span className="events-count-label">
                    등록된 일정 <strong>{selectedDayAllEvents.length}</strong>개
                  </span>
                  {selectedDayAllEvents.length > 0 && (
                    <button
                      type="button"
                      className="accordion-toggle-all-btn"
                      onClick={() => {
                        if (expandedEventIds.size === selectedDayAllEvents.length) {
                          collapseAllEvents()
                        } else {
                          expandAllEvents()
                        }
                      }}
                      title={expandedEventIds.size === selectedDayAllEvents.length ? '모든 일정 접기' : '모든 일정 상세 펼치기'}
                    >
                      {expandedEventIds.size === selectedDayAllEvents.length ? '▲ 전체 접기' : '▼ 전체 펼치기'}
                    </button>
                  )}
                </div>
                <button
                  className="primary-btn quick-day-add-btn"
                  onClick={() => openCreateModal(dayDetailDate)}
                >
                  + 이 날짜에 일정 추가
                </button>
              </div>

              {/* ─────────────────────────────────────────────────────────────
                  일정 목록: 종일 일정 상단 분리 + 시간순 세로 타임라인 뷰
                  ───────────────────────────────────────────────────────────── */}
              {(() => {
                if (selectedDayAllEvents.length === 0) {
                  return (
                    <div className="day-empty-box">
                      <span className="day-empty-icon">☕</span>
                      <p>이 날짜에 등록된 일정이 없습니다.</p>
                      <button
                        className="secondary-btn"
                        onClick={() => openCreateModal(dayDetailDate)}
                      >
                        + 새 일정 추가하기
                      </button>
                    </div>
                  )
                }

                // 1. 종일/연속 일정과 시간 지정 일정 분리
                const allDayList = []
                const timedList = []

                selectedDayAllEvents.forEach(ev => {
                  const evStartStr = ev.start ? ev.start.slice(0, 10) : ''
                  const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
                  const isMultiDay = evStartStr !== evEndStr

                  if (ev.is_holiday || ev.all_day || isMultiDay || !ev.start || ev.start.length <= 10) {
                    allDayList.push(ev)
                  } else {
                    timedList.push(ev)
                  }
                })

                // 종일 일정 정렬: 공휴일 -> 컴짱 -> 일반
                allDayList.sort((a, b) => {
                  if (a.is_holiday && !b.is_holiday) return -1
                  if (!a.is_holiday && b.is_holiday) return 1
                  if (a.is_comjjang && !b.is_comjjang) return -1
                  if (!a.is_comjjang && b.is_comjjang) return 1
                  return (a.title || '').localeCompare(b.title || '')
                })

                // 시간 지정 일정 정렬: 시작 시간(HH:MM) 오름차순 (08:30 -> 12:30 -> 17:30 -> 18:20 -> 19:20 -> 20:00 -> 21:00)
                timedList.sort((a, b) => {
                  const timeA = (a.start && a.start.length > 10) ? a.start.slice(11, 16) : '00:00'
                  const timeB = (b.start && b.start.length > 10) ? b.start.slice(11, 16) : '00:00'
                  return timeA.localeCompare(timeB)
                })

                const isTodayDate = dayDetailDate === todayStr
                const nowTimeStr = new Date().toTimeString().slice(0, 5) // HH:MM

                // 시간 계산 헬퍼
                const getTimeMeta = (startStr, endStr) => {
                  if (!startStr || startStr.length < 16) {
                    return { startTime: '', endTime: '', duration: '', period: '종일', periodIcon: '📌' }
                  }
                  const startTime = startStr.slice(11, 16)
                  const endTime = (endStr && endStr.length >= 16) ? endStr.slice(11, 16) : ''
                  const hour = parseInt(startTime.slice(0, 2), 10)
                  
                  let period = '오전'
                  let periodIcon = '🌅'
                  if (hour < 6) { period = '새벽'; periodIcon = '🌌' }
                  else if (hour < 12) { period = '오전'; periodIcon = '🌅' }
                  else if (hour < 18) { period = '오후'; periodIcon = '☀️' }
                  else if (hour < 22) { period = '저녁'; periodIcon = '🌙' }
                  else { period = '밤'; periodIcon = '🌃' }

                  let duration = ''
                  if (startTime && endTime) {
                    const [sH, sM] = startTime.split(':').map(Number)
                    const [eH, eM] = endTime.split(':').map(Number)
                    const diff = (eH * 60 + eM) - (sH * 60 + sM)
                    if (diff > 0) {
                      const h = Math.floor(diff / 60)
                      const m = diff % 60
                      if (h > 0 && m > 0) duration = `${h}시간 ${m}분`
                      else if (h > 0) duration = `${h}시간`
                      else duration = `${m}분`
                    }
                  }

                  return { startTime, endTime, duration, period, periodIcon, hour }
                }

                // 현재 시간선 삽입 위치 계산
                let nowInserted = false

                return (
                  <div className="day-flow-container">
                    {/* ── 1. 하루 종일 & 기간 진행 중인 일정 랙 (All-day Rack) ── */}
                    {/* ── 1. 하루 종일 & 기간 진행 중인 일정: 초슬림 알약 칩 바 (공간 최소화 & 가독성 극대화) ── */}
                    {allDayList.length > 0 && (
                      <div className="day-allday-strip">
                        <div className="allday-strip-header">
                          <span className="strip-badge-icon">☀️</span>
                          <span className="strip-label">종일 · 기간</span>
                          <span className="strip-count">{allDayList.length}</span>
                        </div>
                        <div className="allday-strip-chips">
                          {allDayList.map(ev => {
                            const isHoliday = !!ev.is_holiday
                            const color = isHoliday ? '#ef4444' : (GOOGLE_COLORS[ev.color_id] || '#3b82f6')
                            const evStartStr = ev.start ? ev.start.slice(0, 10) : ''
                            const evEndStr = ev.end ? ev.end.slice(0, 10) : evStartStr
                            const isMultiDay = evStartStr && evEndStr && evStartStr !== evEndStr
                            const dateLabel = isMultiDay ? `${evStartStr.slice(5)}~${evEndStr.slice(5)}` : '종일'

                            return (
                              <div
                                key={ev.id}
                                className={`allday-pill-chip ${isHoliday ? 'is-holiday' : ''} ${ev.is_comjjang ? 'is-comjjang' : ''}`}
                                style={{ borderColor: `${color}66`, background: `${color}18` }}
                                onClick={() => openEditModal(ev)}
                                title={`${ev.title}${ev.description ? `\n📝 ${ev.description}` : ''}\n(클릭하여 수정)`}
                              >
                                <span className="pill-dot" style={{ background: color }} />
                                <span className="pill-icon">
                                  {isHoliday ? '🚩' : ev.is_comjjang ? '💻' : ev.is_routine ? '🚲' : '📌'}
                                </span>
                                <span className="pill-title">{ev.title}</span>
                                <span className="pill-date-badge">{dateLabel}</span>
                                {ev.is_comjjang && <span className="pill-sub-tag">컴짱</span>}
                                {!isHoliday && (
                                  <button
                                    type="button"
                                    className="pill-del-btn"
                                    title="일정 삭제"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleDeleteEvent(ev.id)
                                    }}
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* ── 2. 시간대별 세로 타임라인 (Vertical Day Timeline) ── */}
                    {timedList.length > 0 && (
                      <div className="day-timeline-section">
                        <div className="timeline-section-header">
                          <span className="timeline-section-icon">⏱️</span>
                          <span className="timeline-section-title">하루 시간대별 타임라인 흐름</span>
                          <span className="timeline-count-badge">{timedList.length}개 일정</span>
                        </div>

                        <div className="timeline-stream">
                          {timedList.map((ev, idx) => {
                            const color = GOOGLE_COLORS[ev.color_id] || '#3b82f6'
                            const meta = getTimeMeta(ev.start, ev.end)
                            const isExpanded = expandedEventIds.has(ev.id)
                            
                            // 과거/미래/현재 여부
                            const isPast = isTodayDate && meta.startTime < nowTimeStr
                            const isNow = isTodayDate && meta.startTime <= nowTimeStr && (meta.endTime ? meta.endTime >= nowTimeStr : meta.startTime === nowTimeStr)

                            // 현재 시간선 표시 체크
                            let showNowLineBefore = false
                            if (isTodayDate && !nowInserted) {
                              if (nowTimeStr < meta.startTime) {
                                showNowLineBefore = true
                                nowInserted = true
                              } else if (idx === timedList.length - 1 && nowTimeStr >= meta.startTime) {
                                // 마지막 일정 뒤에 현재 시간이 있을 때
                                // 하단에 처리
                              }
                            }

                            return (
                              <div key={ev.id} className="timeline-entry-wrapper">
                                {/* 현재 시간 인디케이터 라인 */}
                                {showNowLineBefore && (
                                  <div className="timeline-now-indicator">
                                    <div className="now-dot-pulse" />
                                    <div className="now-label">
                                      <span className="now-icon">🔴</span> 현재 {nowTimeStr}
                                    </div>
                                    <div className="now-line" />
                                  </div>
                                )}

                                <div className={`timeline-entry-row ${isPast ? 'is-past' : ''} ${isNow ? 'is-current-now' : ''}`}>
                                  {/* 왼쪽 1: 큰 시간 컬럼 */}
                                  <div className="timeline-time-col">
                                    <span className="time-period-tag">
                                      {meta.periodIcon} {meta.period}
                                    </span>
                                    <span className="time-start-main">{meta.startTime}</span>
                                    {meta.endTime && (
                                      <span className="time-end-sub">
                                        ~ {meta.endTime}
                                      </span>
                                    )}
                                    {meta.duration && (
                                      <span className="time-duration-chip">
                                        {meta.duration}
                                      </span>
                                    )}
                                  </div>

                                  {/* 가운데 2: 세로 레일 트랙 및 노드 점 */}
                                  <div className="timeline-track-col">
                                    <div className="timeline-node" style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}80` }}>
                                      <div className="timeline-node-inner" />
                                    </div>
                                    <div className="timeline-line" />
                                  </div>

                                  {/* 오른쪽 3: 인터랙티브 아코디언 일정 카드 */}
                                  <div
                                    className={`timeline-card ${isExpanded ? 'expanded' : 'collapsed'}`}
                                    style={{ borderLeftColor: color }}
                                  >
                                    <div
                                      className="timeline-card-header"
                                      onClick={() => toggleEventExpand(ev.id)}
                                      role="button"
                                      tabIndex={0}
                                    >
                                      <div className="timeline-card-title-group">
                                        <div className="timeline-card-title-row">
                                          <span className="timeline-item-icon">
                                            {ev.is_comjjang ? '💻' : ev.is_routine ? '🚲' : '📌'}
                                          </span>
                                          <h4 className="timeline-item-title">{ev.title}</h4>
                                        </div>

                                        <div className="timeline-item-badges">
                                          {ev.is_comjjang && <span className="comjjang-tag">💻 컴짱 회의</span>}
                                          {ev.is_routine && <span className="routine-tag">🚲 루틴</span>}
                                          {ev.location && <span className="timeline-loc-badge">📍 {ev.location}</span>}
                                        </div>
                                      </div>

                                      <div className="timeline-card-actions">
                                        <div className="accordion-quick-actions" onClick={e => e.stopPropagation()}>
                                          <button
                                            type="button"
                                            className="icon-btn edit"
                                            title="수정하기"
                                            onClick={() => openEditModal(ev)}
                                          >
                                            ✏️
                                          </button>
                                          <button
                                            type="button"
                                            className="icon-btn delete"
                                            title="삭제하기"
                                            onClick={() => handleDeleteEvent(ev.id)}
                                          >
                                            🗑️
                                          </button>
                                        </div>
                                        <span className="timeline-chevron">{isExpanded ? '▲' : '▼'}</span>
                                      </div>
                                    </div>

                                    {/* 펼쳐졌을 때의 상세 내용 */}
                                    {isExpanded && (
                                      <div className="timeline-card-body">
                                        <div className="detail-meta-list">
                                          <div className="detail-meta-item">
                                            <span className="meta-item-label">⏱️ 일시:</span>
                                            <span className="meta-item-value">
                                              {meta.startTime} ~ {meta.endTime || '종료 미정'} {meta.duration && `(${meta.duration})`}
                                            </span>
                                          </div>
                                          {ev.location && (
                                            <div className="detail-meta-item">
                                              <span className="meta-item-label">📍 장소:</span>
                                              <span className="meta-item-value">{ev.location}</span>
                                            </div>
                                          )}
                                          <div className="detail-meta-item">
                                            <span className="meta-item-label">🏷️ 분류:</span>
                                            <span className="meta-item-value" style={{ color: color }}>
                                              {ev.is_comjjang ? '💻 컴짱 회의' : ev.is_routine ? '🚲 일상 루틴' : (ev.source === 'google' ? 'Google Calendar' : 'Bill Studio')}
                                            </span>
                                          </div>
                                        </div>

                                        {ev.description && (
                                          <div className="detail-desc-section">
                                            <div className="desc-section-header">
                                              <span className="desc-icon">📝</span>
                                              <span className="desc-title">상세 메모</span>
                                            </div>
                                            <div className="detail-desc-content">
                                              {ev.description}
                                            </div>
                                          </div>
                                        )}

                                        <div className="accordion-body-actions">
                                          <button
                                            type="button"
                                            className="secondary-btn small-btn"
                                            onClick={() => openEditModal(ev)}
                                          >
                                            ✏️ 일정 수정
                                          </button>
                                          <button
                                            type="button"
                                            className="danger-btn small-btn"
                                            onClick={() => handleDeleteEvent(ev.id)}
                                          >
                                            🗑️ 삭제
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )
                          })}

                          {/* 마지막 일정 뒤에 현재 시간이 있는 경우 */}
                          {isTodayDate && !nowInserted && (
                            <div className="timeline-now-indicator last-now">
                              <div className="now-dot-pulse" />
                              <div className="now-label">
                                <span className="now-icon">🔴</span> 현재 {nowTimeStr}
                              </div>
                              <div className="now-line" />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>

            <div className="modal-footer">
              <button
                className="cancel-btn"
                onClick={() => setDayDetailDate(null)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          ✏️ 2. 일정 추가 / 수정 모달
          ======================================================== */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{modalMode === 'create' ? '✨ 새 일정 등록' : '✏️ 일정 상세 / 수정'}</h3>
              <button className="close-btn" onClick={() => setModalOpen(false)}>✕</button>
            </div>

            <form onSubmit={handleSaveEvent} className="modal-form">
              {/* 스튜디오 프리셋 빠른 버튼 */}
              <div className="form-group presets-group">
                <label className="form-label">스튜디오 추천 템플릿</label>
                <div className="preset-chips">
                  {PRESETS.map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="preset-chip"
                      onClick={() => applyPreset(p)}
                    >
                      <span className="chip-dot" style={{ background: p.color }} />
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 제목 */}
              <div className="form-group">
                <label className="form-label">일정 제목 *</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="예: 🎬 안세영 롤모델 쇼츠 업로드"
                  value={eventForm.title}
                  onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
                  required
                  autoFocus
                />
              </div>

              {/* 루틴 여부, 컴짱 여부, 종일 여부 */}
              <div className="form-row form-checkbox-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={eventForm.all_day}
                    onChange={(e) => setEventForm({ ...eventForm, all_day: e.target.checked })}
                  />
                  <span>하루 종일</span>
                </label>

                <label className="checkbox-label comjjang-checkbox">
                  <input
                    type="checkbox"
                    checked={eventForm.is_comjjang}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setEventForm({
                        ...eventForm,
                        is_comjjang: checked,
                        color_id: checked ? '7' : eventForm.color_id,
                        calendar_id: checked ? 'comjjang' : 'primary'
                      })
                    }}
                  />
                  <span>💻 컴짱 회의 일정</span>
                </label>

                <label className="checkbox-label routine-checkbox">
                  <input
                    type="checkbox"
                    checked={eventForm.is_routine}
                    onChange={(e) => setEventForm({ ...eventForm, is_routine: e.target.checked })}
                  />
                  <span>🚲 일상 루틴</span>
                </label>
              </div>

              {/* 일시 선택 */}
              <div className="form-row">
                <div className="form-group half">
                  <label className="form-label">시작 {eventForm.all_day ? '날짜' : '일시'}</label>
                  <input
                    type={eventForm.all_day ? 'date' : 'datetime-local'}
                    className="form-input"
                    value={eventForm.all_day ? eventForm.start_time.slice(0, 10) : eventForm.start_time}
                    onChange={(e) => setEventForm({ ...eventForm, start_time: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group half">
                  <label className="form-label">종료 {eventForm.all_day ? '날짜' : '일시'}</label>
                  <input
                    type={eventForm.all_day ? 'date' : 'datetime-local'}
                    className="form-input"
                    value={eventForm.all_day ? eventForm.end_time.slice(0, 10) : eventForm.end_time}
                    onChange={(e) => setEventForm({ ...eventForm, end_time: e.target.value })}
                    required
                  />
                </div>
              </div>

              {/* 카테고리 색상 */}
              <div className="form-group">
                <label className="form-label">캘린더 색상 라벨</label>
                <div className="color-palette">
                  {Object.entries(GOOGLE_COLORS).map(([cid, hex]) => (
                    <button
                      key={cid}
                      type="button"
                      className={`color-circle ${eventForm.color_id === cid ? 'selected' : ''}`}
                      style={{ background: hex }}
                      onClick={() => setEventForm({ ...eventForm, color_id: cid })}
                    />
                  ))}
                </div>
              </div>

              {/* 위치 */}
              <div className="form-group">
                <label className="form-label">장소 / 링크 (선택)</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="예: 스튜디오 작업실 / 한강 자전거 도로"
                  value={eventForm.location}
                  onChange={(e) => setEventForm({ ...eventForm, location: e.target.value })}
                />
              </div>

              {/* 메모 / 설명 */}
              <div className="form-group">
                <label className="form-label">상세 메모 / 체크리스트</label>
                <textarea
                  className="form-textarea"
                  rows={3}
                  placeholder="세부 작업 내용이나 메모할 내용을 적어주세요."
                  value={eventForm.description}
                  onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
                />
              </div>

              {/* 모달 하단 버튼 */}
              <div className="modal-actions">
                {modalMode === 'edit' && (
                  <button
                    type="button"
                    className="delete-btn"
                    onClick={() => handleDeleteEvent()}
                    disabled={loading}
                  >
                    🗑️ 삭제
                  </button>
                )}
                <div className="actions-right">
                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={() => setModalOpen(false)}
                  >
                    취소
                  </button>
                  <button
                    type="submit"
                    className="submit-btn"
                    disabled={loading}
                  >
                    {loading ? '저장 중...' : (modalMode === 'create' ? '일정 저장' : '수정 완료')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default Schedule

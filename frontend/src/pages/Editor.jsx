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
  const [subsLang, setSubsLang] = useState('auto')
  const [translateToKo, setTranslateToKo] = useState(false)
  const [translatingSubs, setTranslatingSubs] = useState(false)
  const [showSubtitles, setShowSubtitles] = useState(true)
  const [showScreenOverlay, setShowScreenOverlay] = useState(true)
  const [captionPos, setCaptionPos] = useState('bottom') // 'bottom' | 'middle' | 'top'
  const [subFlowMode, setSubFlowMode] = useState('smart') // 'smart': 다음 자막 직전까지 유지(긴 간격은 퇴장), 'exact': 타임코드 정시 퇴장
  const [maxDisplaySec, setMaxDisplaySec] = useState(4.0) // 자막 최대 표시 시간 (초, 0이면 무제한)
  const [subError, setSubError] = useState('')
  const [savingSubs, setSavingSubs] = useState(false)
  const [subsSavedNotice, setSubsSavedNotice] = useState(false)
  const [isSubsDirty, setIsSubsDirty] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [projectLoadedNotice, setProjectLoadedNotice] = useState('')
  const [activeTab, setActiveTab] = useState('subtitle') // 'subtitle' | 'tts' | 'cut'
  const [converting, setConverting] = useState(false)

  // AI 내레이션 (더빙) 상태
  const [voices, setVoices] = useState([])
  const [selectedVoice, setSelectedVoice] = useState('ko-KR-SunHiNeural')
  const [ttsRate, setTtsRate] = useState('+10%')
  const [origVolume, setOrigVolume] = useState(0.1)
  const [dubbing, setDubbing] = useState(false)
  const [dubResult, setDubResult] = useState(null)
  const [dubError, setDubError] = useState('')
  const [previewing, setPreviewing] = useState(false)

  // BGM (배경음악) 상태
  const [bgmTracks, setBgmTracks] = useState([])
  const [selectedBgm, setSelectedBgm] = useState('')
  const [bgmVolume, setBgmVolume] = useState(0.15)
  const [playingBgmId, setPlayingBgmId] = useState(null)
  const [uploadingBgm, setUploadingBgm] = useState(false)
  const bgmAudioRef = useRef(null)
  const bgmFileInputRef = useRef(null)

  const activeSegmentRef = useRef(null)
  const scriptListRef = useRef(null)

  useEffect(() => {
    loadFiles()
    loadVoices()
    loadBgmTracks()
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

  async function loadBgmTracks() {
    try {
      const res = await fetch('/api/tts/bgm/list')
      if (res.ok) {
        const data = await res.json()
        setBgmTracks(data.tracks || [])
      }
    } catch {
      // ignore
    }
  }

  function togglePlayBgm(track) {
    if (playingBgmId === track.id) {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause()
      }
      setPlayingBgmId(null)
    } else {
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause()
      }
      const audio = new Audio(track.url)
      audio.volume = Math.max(0.1, Math.min(1.0, bgmVolume * 2))
      audio.loop = true
      audio.play().catch(() => {})
      bgmAudioRef.current = audio
      setPlayingBgmId(track.id)
    }
  }

  async function handleBgmUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const formData = new FormData()
    formData.append('file', file)
    setUploadingBgm(true)
    try {
      const res = await fetch('/api/tts/bgm/upload', {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) throw new Error('BGM 업로드 실패')
      const data = await res.json()
      await loadBgmTracks()
      setSelectedBgm(data.filename)
    } catch (err) {
      alert(err.message)
    } finally {
      setUploadingBgm(false)
      if (bgmFileInputRef.current) bgmFileInputRef.current.value = ''
    }
  }


  useEffect(() => {
    if (currentFile) {
      loadMediaInfo(currentFile)
      loadExistingSubtitles(currentFile)
      loadEditorProject(currentFile)
      setDubResult(null)
      setDubError('')
    } else {
      setMediaInfo(null)
      setSubtitles([])
      setSubtitlesLoaded(false)
      setDubResult(null)
    }
  }, [currentFile])

  // 단축키 Cmd+S / Ctrl+S 로 언제든 전체 편집 상황 즉시 저장
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSaveProject()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentFile, subtitles, currentTime, activeTab, selectedVoice, selectedBgm, bgmVolume, origVolume, captionPos, maxDisplaySec])

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
          bgm_file: selectedBgm || null,
          bgm_volume: bgmVolume,
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

  // 이전에 저장된 편집 프로젝트 상황 불러오기
  async function loadEditorProject(filename) {
    try {
      const res = await fetch(`/api/editor/project/load?file=${encodeURIComponent(filename)}`)
      if (res.ok) {
        const data = await res.json()
        if (data.has_project && data.project) {
          const p = data.project
          if (p.captionPos) setCaptionPos(p.captionPos)
          if (p.maxDisplaySec !== undefined) setMaxDisplaySec(p.maxDisplaySec)
          if (p.showScreenOverlay !== undefined) setShowScreenOverlay(p.showScreenOverlay)
          if (p.showSubtitles !== undefined) setShowSubtitles(p.showSubtitles)
          if (p.selectedVoice) setSelectedVoice(p.selectedVoice)
          if (p.ttsRate) setTtsRate(p.ttsRate)
          if (p.origVolume !== undefined) setOrigVolume(p.origVolume)
          if (p.selectedBgm !== undefined) setSelectedBgm(p.selectedBgm)
          if (p.bgmVolume !== undefined) setBgmVolume(p.bgmVolume)
          if (p.startTime !== undefined) setStartTime(p.startTime)
          if (p.endTime) setEndTime(p.endTime)
          if (p.customOutName) setCustomOutName(p.customOutName)
          if (p.activeTab) setActiveTab(p.activeTab)
          if (p.currentTime > 0) {
            setCurrentTime(p.currentTime)
            setTimeout(() => {
              if (videoRef.current) {
                videoRef.current.currentTime = p.currentTime
              }
            }, 400)
          }
          setProjectLoadedNotice(`📂 이전에 저장된 편집 작업이 복원되었습니다! (저장 시점: ${p.saved_at}, 마지막 위치: ${formatSeconds(p.currentTime || 0)})`)
          setTimeout(() => setProjectLoadedNotice(''), 7000)
        }
      }
    } catch {
      // ignore
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
          language: subsLang,
          translate_to_ko: translateToKo,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '자막 추출에 실패했습니다.')
      }

      const data = await res.json()
      setSubtitles(data.segments || [])
      setSubtitlesLoaded(true)
      setIsSubsDirty(false)
    } catch (e) {
      setSubError(e.message)
    } finally {
      setExtractingSubs(false)
    }
  }

  // 기존 자막을 한국어로 즉시 일괄 번역
  async function handleTranslateToKo() {
    if (!currentFile || subtitles.length === 0) return
    setTranslatingSubs(true)
    setSubError('')
    try {
      const res = await fetch('/api/subtitle/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          target_lang: 'ko',
          segments: subtitles,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '자막 번역에 실패했습니다.')
      }

      const data = await res.json()
      setSubtitles(data.segments || [])
      setIsSubsDirty(false)
      setSubsSavedNotice(true)
      setTimeout(() => setSubsSavedNotice(false), 3000)
    } catch (e) {
      setSubError(e.message)
    } finally {
      setTranslatingSubs(false)
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
        setIsSubsDirty(false)
        setSubsSavedNotice(true)
        setTimeout(() => setSubsSavedNotice(false), 2500)
      } else {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '자막 저장에 실패했습니다.')
      }
    } catch (e) {
      alert('자막 저장 실패: ' + e.message)
    } finally {
      setSavingSubs(false)
    }
  }

  // 현재 동영상 편집의 전체 상태(자막, 성우, BGM, 볼륨, 마지막 재생 위치 등) 일괄 저장
  async function handleSaveProject() {
    if (!currentFile) return
    setSavingProject(true)
    try {
      const curTime = videoRef.current ? Number(videoRef.current.currentTime.toFixed(1)) : currentTime
      const res = await fetch('/api/editor/project/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: currentFile,
          currentTime: curTime,
          activeTab,
          subtitles,
          captionPos,
          showScreenOverlay,
          maxDisplaySec,
          showSubtitles,
          selectedVoice,
          ttsRate,
          origVolume,
          selectedBgm,
          bgmVolume,
          startTime,
          endTime,
          customOutName,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setIsSubsDirty(false)
        setSubsSavedNotice(true)
        setTimeout(() => setSubsSavedNotice(false), 3000)
        setProjectLoadedNotice(`✅ 전체 편집 상황 저장 완료! (${data.saved_at})`)
        setTimeout(() => setProjectLoadedNotice(''), 5000)
        alert(`💾 [동영상 편집 전체 상황 저장 완료]\n\n• 저장 시각: ${data.saved_at}\n• 마지막 위치: ${formatSeconds(curTime)}\n• 자막: ${subtitles.length}개 문장 동기화 저장\n• AI 설정: 성우(${selectedVoice}), BGM(${selectedBgm || '없음'})\n\n다음에 이 영상을 다시 열면 현재 편집 상태가 그대로 복원됩니다!`)
      } else {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || '편집 상황 저장에 실패했습니다.')
      }
    } catch (e) {
      alert('저장 실패: ' + e.message)
    } finally {
      setSavingProject(false)
    }
  }

  function handleSegmentTextChange(idx, newText) {
    const updated = [...subtitles]
    updated[idx] = { ...updated[idx], text: newText }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  function handleDeleteSegment(idx) {
    const seg = subtitles[idx]
    const preview = seg?.text?.slice(0, 15) || '이 자막'
    if (!window.confirm(`"${preview}..." 자막을 삭제하시겠습니까?`)) return
    const updated = subtitles.filter((_, i) => i !== idx)
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  function handleAddSegment(idx) {
    const prev = idx !== undefined && idx >= 0 ? subtitles[idx] : subtitles[subtitles.length - 1]
    const curTime = videoRef.current ? Number(videoRef.current.currentTime.toFixed(1)) : 0
    const nextStart = prev ? Number((prev.end + 0.1).toFixed(1)) : curTime
    const nextEnd = Number((nextStart + 3.0).toFixed(1))
    const newSeg = {
      id: Date.now(),
      start: nextStart,
      end: nextEnd,
      text: '새 자막을 입력하세요'
    }
    const updated = [...subtitles]
    if (idx !== undefined && idx >= 0) {
      updated.splice(idx + 1, 0, newSeg)
    } else {
      updated.push(newSeg)
    }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  function handleTimeStep(idx, field, delta) {
    const updated = [...subtitles]
    const val = Number(Math.max(0, updated[idx][field] + delta).toFixed(1))
    updated[idx] = { ...updated[idx], [field]: val }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  function handleShiftAllSubtitles(delta) {
    if (subtitles.length === 0) return
    const updated = subtitles.map((seg) => ({
      ...seg,
      start: Number(Math.max(0, seg.start + delta).toFixed(2)),
      end: Number(Math.max(0.1, seg.end + delta).toFixed(2)),
    }))
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  // 특정 세그먼트의 시작/종료 시간을 현재 재생 시간으로 즉시 맞추기
  function handleSetTimeToCurrent(idx, field) {
    const curTime = Number(currentTime.toFixed(1))
    const updated = [...subtitles]
    if (field === 'end') {
      if (curTime <= updated[idx].start) {
        alert('종료 시간은 시작 시간보다 커야 합니다.')
        return
      }
      updated[idx] = { ...updated[idx], end: curTime }
    } else {
      if (curTime >= updated[idx].end) {
        alert('시작 시간은 종료 시간보다 작아야 합니다.')
        return
      }
      updated[idx] = { ...updated[idx], start: curTime }
    }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  // 긴 자막을 2개로 분할(Split)하기
  function handleSplitSegment(idx) {
    const seg = subtitles[idx]
    if (!seg) return
    const cur = Number(currentTime.toFixed(1))
    let splitTime = (cur > seg.start + 0.3 && cur < seg.end - 0.3)
      ? cur
      : Number(((seg.start + seg.end) / 2).toFixed(1))

    const words = (seg.text || '').trim().split(' ')
    let text1 = seg.text
    let text2 = '...'
    if (words.length >= 2) {
      const mid = Math.ceil(words.length / 2)
      text1 = words.slice(0, mid).join(' ')
      text2 = words.slice(mid).join(' ')
    }

    const seg1 = {
      ...seg,
      end: splitTime,
      text: text1,
    }
    const seg2 = {
      id: Date.now(),
      start: Number((splitTime + 0.05).toFixed(1)),
      end: seg.end,
      text: text2,
    }

    const updated = [...subtitles]
    updated.splice(idx, 1, seg1, seg2)
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  function handleDirectTimeChange(idx, field, valueStr) {
    const val = parseFloat(valueStr)
    if (isNaN(val)) return
    const updated = [...subtitles]
    updated[idx] = { ...updated[idx], [field]: Number(Math.max(0, val).toFixed(1)) }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  // 자막의 종료 시간을 다음 자막 시작 직전(0.1초 전)으로 연결하되, 최대 표시 시간(maxDisplaySec)까지만 제한
  function handleSmartBridgeSubtitles() {
    if (subtitles.length === 0) return
    let count = 0
    const updated = subtitles.map((seg, idx) => {
      const next = subtitles[idx + 1]
      if (!next) return seg

      const bridgeEnd = Number((next.start - 0.1).toFixed(1))
      // 최대 허용 시간 계산 (0이면 제한 없음)
      const capEnd = maxDisplaySec > 0 ? Number((seg.start + maxDisplaySec).toFixed(1)) : 999999
      // 원래 음성 발화 시간과 최대 허용 시간 중 큰 값까지는 보장
      const maxAllowed = Math.max(seg.end, capEnd)
      const newEnd = Math.min(bridgeEnd, maxAllowed)

      if (newEnd > seg.start && newEnd !== seg.end) {
        count++
        return { ...seg, end: newEnd }
      }
      return seg
    })
    if (count > 0) {
      setSubtitles(updated)
      setIsSubsDirty(true)
      const limitText = maxDisplaySec > 0 ? ` (최대 ${maxDisplaySec}초)` : ''
      alert(`총 ${count}개의 자막을 다음 자막 직전까지${limitText} 자연스럽게 연결했습니다!`)
    } else {
      alert('이미 모든 자막이 설정된 최대 시간 및 다음 자막 직전까지 최적화되어 있습니다.')
    }
  }

  // 특정 1개 자막만 다음 자막 직전(0.1초 전)으로 연결
  function handleSetEndToNextStart(idx) {
    const next = subtitles[idx + 1]
    if (!next) {
      alert('다음 자막이 없습니다.')
      return
    }
    const newEnd = Number((next.start - 0.1).toFixed(1))
    if (newEnd <= subtitles[idx].start) {
      alert('다음 자막 시작 시간이 현재 자막 시작 시간보다 작거나 같습니다.')
      return
    }
    const updated = [...subtitles]
    updated[idx] = { ...updated[idx], end: newEnd }
    setSubtitles(updated)
    setIsSubsDirty(true)
  }

  // 한 줄이 너무 긴 자막을 읽기 좋게 적절한 띄어쓰기 위치에서 2줄로 자동 줄바꿈해 주는 함수
  function formatDisplaySubtitle(text, maxLineChars = 20) {
    if (!text) return ''
    if (text.includes('\n')) return text // 이미 줄바꿈이 있으면 그대로 존중

    const trimmed = text.trim()
    if (trimmed.length <= maxLineChars) return trimmed

    const words = trimmed.split(' ')
    if (words.length <= 1) return trimmed

    // 문장의 중앙 지점에 가장 가까운 단어 분할 지점 찾기
    const targetLen = Math.floor(trimmed.length / 2)
    let bestIdx = 1
    let minDiff = 999999
    let currentLen = 0

    for (let i = 0; i < words.length - 1; i++) {
      currentLen += words[i].length + (i > 0 ? 1 : 0)
      const diff = Math.abs(currentLen - targetLen)
      if (diff < minDiff) {
        minDiff = diff
        bestIdx = i + 1
      }
    }

    const line1 = words.slice(0, bestIdx).join(' ')
    const line2 = words.slice(bestIdx).join(' ')
    return `${line1}\n${line2}`
  }

  // 긴 자막(20자 이상)을 대본 텍스트 자체에서 2줄로 자동 줄바꿈
  function handleAutoWrapLongSubtitles(maxLineChars = 20) {
    if (subtitles.length === 0) return
    let count = 0
    const updated = subtitles.map((seg) => {
      const original = seg.text || ''
      if (original.includes('\n') || original.length <= maxLineChars) return seg
      const wrapped = formatDisplaySubtitle(original, maxLineChars)
      if (wrapped !== original) {
        count++
        return { ...seg, text: wrapped }
      }
      return seg
    })

    if (count > 0) {
      setSubtitles(updated)
      setIsSubsDirty(true)
      alert(`총 ${count}개의 긴 자막을 읽기 편하게 2줄로 자동 줄바꿈했습니다!`)
    } else {
      alert('20자 이상의 긴 자막이 없거나 이미 줄바꿈되어 있습니다.')
    }
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

  // 현재 시간에 일치하는 자막 세그먼트:
  // - 다음 자막이 나오기 직전까지 화면에 유지하되,
  // - 음성 간격이 너무 벌어져 있을 때는 설정된 최대 시간(maxDisplaySec)까지만 표시 후 깔끔하게 퇴장
  const activeSegment = subtitles.find((s, idx) => {
    if (currentTime < s.start) return false

    // 자막 최대 표시 한도 계산 (0이면 무제한 다음 자막 직전까지)
    // 원래 대사 발화 시간(s.end)과 (s.start + maxDisplaySec) 중 큰 값은 온전히 보장
    const capEnd = maxDisplaySec > 0 ? (s.start + maxDisplaySec) : 999999
    const maxAllowedEnd = Math.max(s.end, capEnd)

    const next = subtitles[idx + 1]
    if (next) {
      // 다음 자막 직전(next.start - 0.08)과 최대 허용 시간 중 더 빠른 시점에 퇴장
      const displayEnd = Math.min(next.start - 0.08, maxAllowedEnd)
      return currentTime < displayEnd
    } else {
      // 마지막 자막은 끝난 후 여유 있게 유지하되 최대 시간 제한 적용
      const displayEnd = Math.min(s.end + 3.0, maxAllowedEnd)
      return currentTime <= displayEnd
    }
  })

  return (
    <div className="editor-page">
      {/* 상단 네비게이션 */}
      <div className="editor-topbar">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/downloader')}>
          ← 다운로더로 돌아가기
        </button>
        {currentFile && (
          <div className="topbar-actions">
            <button
              className="btn btn-primary btn-sm save-project-top-btn"
              onClick={handleSaveProject}
              disabled={savingProject}
              title="자막, 마지막 재생 위치, 성우, 배경음악 등 현재 편집 전체 상황을 저장합니다 (단축키: Cmd+S)"
            >
              {savingProject ? '💾 전체 상황 저장 중...' : '💾 전체 편집 상황 저장'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setSearchParams({})}>
              📂 다른 영상 선택
            </button>
          </div>
        )}
      </div>

      {projectLoadedNotice && (
        <div className="project-notice-banner">
          <span>{projectLoadedNotice}</span>
          <button className="banner-close-btn" onClick={() => setProjectLoadedNotice('')}>✕</button>
        </div>
      )}

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

                {/* 플레이어 래퍼 (영상 화면 내부 자막 오버레이 포함) */}
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

                  {/* 📺 영상 화면 내부 오버레이 자막 (목소리가 나올 때 영상 안에서 정확히 일치) */}
                  {showScreenOverlay && showSubtitles && activeSegment && (
                    <div className={`video-screen-caption pos-${captionPos}`}>
                      <div className="caption-bubble">
                        {formatDisplaySubtitle(activeSegment.text)}
                      </div>
                    </div>
                  )}
                </div>

                {/* 💬 영상 밑 실시간 자막 디스플레이 바 및 위치/싱크 컨트롤 */}
                <div className="subtitle-display-container">
                  <div className="subtitle-display-header">
                    <span className="sub-title-tag">
                      💬 실시간 자막 {subtitlesLoaded ? `(${subtitles.length}문장)` : ''}
                    </span>

                    <div className="sub-display-actions">
                      {/* 화면 자막 위치 선택 */}
                      <div className="caption-pos-selector" title="영상 화면 내부 자막 위치 선택">
                        <span className="pos-label">📺 화면 위치:</span>
                        <button
                          className={`btn-pos ${captionPos === 'bottom' ? 'active' : ''}`}
                          onClick={() => setCaptionPos('bottom')}
                        >
                          하단
                        </button>
                        <button
                          className={`btn-pos ${captionPos === 'middle' ? 'active' : ''}`}
                          onClick={() => setCaptionPos('middle')}
                        >
                          중앙
                        </button>
                        <button
                          className={`btn-pos ${captionPos === 'top' ? 'active' : ''}`}
                          onClick={() => setCaptionPos('top')}
                        >
                          상단
                        </button>
                        <button
                          className={`btn-pos ${showScreenOverlay ? 'active' : ''}`}
                          onClick={() => setShowScreenOverlay(!showScreenOverlay)}
                          title="영상 화면 위 자막 켜기/끄기"
                        >
                          {showScreenOverlay ? '화면자막 ON' : '화면자막 OFF'}
                        </button>
                      </div>

                      {/* 자막 최대 유지/표시 시간 조절기 */}
                      <div className="caption-flow-selector" title="음성 간격이 길 때 자막이 화면에 머무르는 최대 시간">
                        <span className="pos-label">⏱ 최대 표시:</span>
                        <button
                          className={`btn-pos ${maxDisplaySec === 3.0 ? 'active' : ''}`}
                          onClick={() => setMaxDisplaySec(3.0)}
                          title="자막을 최대 3초까지만 띄우고 퇴장"
                        >
                          3초
                        </button>
                        <button
                          className={`btn-pos ${maxDisplaySec === 4.0 ? 'active' : ''}`}
                          onClick={() => setMaxDisplaySec(4.0)}
                          title="자막을 최대 4초까지만 띄우고 퇴장 (가장 편안한 추천)"
                        >
                          4초 (추천)
                        </button>
                        <button
                          className={`btn-pos ${maxDisplaySec === 6.0 ? 'active' : ''}`}
                          onClick={() => setMaxDisplaySec(6.0)}
                          title="자막을 최대 6초까지만 띄우고 퇴장"
                        >
                          6초
                        </button>
                        <button
                          className={`btn-pos ${maxDisplaySec === 0 ? 'active' : ''}`}
                          onClick={() => setMaxDisplaySec(0)}
                          title="다음 자막이 나올 때까지 시간 제한 없이 계속 띄움"
                        >
                          무제한
                        </button>
                      </div>

                      {/* 전체 자막 싱크(시간 위치) 일괄 조절 */}
                      {subtitles.length > 0 && (
                        <div className="sync-shift-group" title="목소리보다 자막이 빠르거나 느릴 때 전체 시간 일괄 이동">
                          <span className="sync-label">⏱ 싱크:</span>
                          <button
                            className="btn-sync-step"
                            onClick={() => handleShiftAllSubtitles(-0.5)}
                            title="전체 자막 0.5초 앞당기기"
                          >
                            -0.5s
                          </button>
                          <button
                            className="btn-sync-step"
                            onClick={() => handleShiftAllSubtitles(-0.2)}
                            title="전체 자막 0.2초 앞당기기"
                          >
                            -0.2s
                          </button>
                          <button
                            className="btn-sync-step"
                            onClick={() => handleShiftAllSubtitles(0.2)}
                            title="전체 자막 0.2초 늦추기"
                          >
                            +0.2s
                          </button>
                          <button
                            className="btn-sync-step"
                            onClick={() => handleShiftAllSubtitles(0.5)}
                            title="전체 자막 0.5초 늦추기"
                          >
                            +0.5s
                          </button>
                        </div>
                      )}

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
                        <span className="subtitle-active-text">{formatDisplaySubtitle(activeSegment.text)}</span>
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
                          <label>음성 언어:</label>
                          <select
                            className="input select-input"
                            value={subsLang}
                            onChange={(e) => setSubsLang(e.target.value)}
                            disabled={extractingSubs}
                          >
                            <option value="auto">🌐 자동 감지 (추천)</option>
                            <option value="en">🇺🇸 영어 (English)</option>
                            <option value="ko">🇰🇷 한국어</option>
                            <option value="ja">🇯🇵 일본어</option>
                          </select>

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

                          <label className="checkbox-label" title="영어 등 외국어 음성을 한국어 자막으로 자동 변환">
                            <input
                              type="checkbox"
                              checked={translateToKo}
                              onChange={(e) => setTranslateToKo(e.target.checked)}
                              disabled={extractingSubs}
                            />
                            <span>🇰🇷 한국어로 번역</span>
                          </label>

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
                            className="btn btn-primary btn-sm translate-btn"
                            onClick={handleTranslateToKo}
                            disabled={translatingSubs || savingSubs}
                            title="전체 자막 텍스트를 자연스러운 한국어로 즉시 번역합니다"
                          >
                            {translatingSubs ? '⏳ 한국어로 번역 중...' : '🌐 한국어로 일괄 번역'}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleAddSegment(subtitles.length - 1)}
                            title="목록 맨 끝에 새 자막 행 추가"
                          >
                            ➕ 자막 추가
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleSmartBridgeSubtitles()}
                            title="연속되는 대화 자막의 종료 시간을 다음 자막 시작 직전(0.1초 전)으로 연결합니다."
                          >
                            🔗 다음 자막 직전까지 연결
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleAutoWrapLongSubtitles(20)}
                            title="20자 이상 긴 자막을 읽기 편하게 2줄로 자동 줄바꿈합니다"
                          >
                            ↩️ 긴 자막 2줄 줄바꿈
                          </button>
                          <button
                            className={`btn btn-sm ${isSubsDirty ? 'btn-primary pulse-save-btn' : 'btn-secondary'}`}
                            onClick={handleSaveProject}
                            disabled={savingProject}
                            title="자막뿐만 아니라 현재 재생 위치, 성우, 배경음악 설정 등 전체 편집 상황을 함께 저장합니다"
                          >
                            {savingProject ? '💾 전체 상황 저장 중...' : isSubsDirty ? '💾 전체 상황 저장 (저장 필요)' : '💾 전체 상황 저장됨'}
                          </button>
                          <a
                            className="btn btn-secondary btn-sm"
                            href={`/api/subtitle/export/srt?file=${encodeURIComponent(currentFile)}`}
                            download
                          >
                            📥 .SRT 다운로드
                          </a>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={handleExtractSubtitles}
                            disabled={extractingSubs}
                            title="영상 음성을 다시 Whisper AI로 분석"
                          >
                            {extractingSubs ? '⏳ 재추출 중...' : '🔄 다시 추출'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {subsSavedNotice && (
                    <div className="notice-banner success">
                      ✅ 자막 수정 내용이 성공적으로 저장되었습니다!
                    </div>
                  )}

                  {isSubsDirty && !subsSavedNotice && (
                    <div className="notice-banner warning">
                      ✏️ 자막에 수정된 내용이 있습니다. 편집을 마친 후 <strong>[💾 자막 저장]</strong> 버튼을 눌러주세요.
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
                              <div className="script-time-controls">
                                <div className="time-btn-row">
                                  <button
                                    className="script-time-btn"
                                    onClick={() => handleSeekTo(seg.start)}
                                    title="클릭 시 이 시간대로 영상 재생 이동"
                                  >
                                    ▶ {formatSeconds(seg.start)}
                                  </button>
                                  <button
                                    className="time-now-btn"
                                    onClick={() => handleSetTimeToCurrent(idx, 'start')}
                                    title="현재 영상 재생 위치를 시작 시간으로 맞추기"
                                  >
                                    🎯현재
                                  </button>
                                </div>
                                <div className="time-micro-adjust">
                                  <button
                                    className="time-step-btn"
                                    onClick={() => handleTimeStep(idx, 'start', -0.2)}
                                    title="시작 0.2초 앞당기기"
                                  >
                                    -0.2
                                  </button>
                                  <button
                                    className="time-step-btn"
                                    onClick={() => handleTimeStep(idx, 'start', 0.2)}
                                    title="시작 0.2초 늦추기"
                                  >
                                    +0.2
                                  </button>
                                  <input
                                    type="number"
                                    step="0.1"
                                    className="time-direct-input"
                                    value={seg.start}
                                    onChange={(e) => handleDirectTimeChange(idx, 'start', e.target.value)}
                                    title="시작 시간(초) 직접 입력"
                                  />
                                </div>
                              </div>

                              <div className="script-input-wrapper">
                                <textarea
                                  className="script-text-input"
                                  rows={1}
                                  value={seg.text}
                                  onChange={(e) => handleSegmentTextChange(idx, e.target.value)}
                                  placeholder="자막 내용 입력..."
                                />
                              </div>

                              <div className="script-end-controls">
                                <div className="time-btn-row">
                                  <button
                                    className="script-dur-btn"
                                    onClick={() => handleSeekTo(seg.end)}
                                    title="클릭 시 종료 시간으로 영상 이동"
                                  >
                                    ~ {formatSeconds(seg.end)}
                                  </button>
                                  <button
                                    className="time-now-btn end-now"
                                    onClick={() => handleSetTimeToCurrent(idx, 'end')}
                                    title="목소리가 끝난 현재 영상 위치로 종료 시간 즉시 맞춤"
                                  >
                                    🎯현재로 끝
                                  </button>
                                  {idx < subtitles.length - 1 && (
                                    <button
                                      className="time-now-btn next-start-btn"
                                      onClick={() => handleSetEndToNextStart(idx)}
                                      title="이 자막의 종료 시간을 다음 자막 시작 0.1초 전으로 맞춤"
                                    >
                                      🔗다음 직전
                                    </button>
                                  )}
                                </div>
                                <div className="time-micro-adjust">
                                  <button
                                    className="time-step-btn"
                                    onClick={() => handleTimeStep(idx, 'end', -0.2)}
                                    title="종료 0.2초 앞당기기"
                                  >
                                    -0.2
                                  </button>
                                  <button
                                    className="time-step-btn"
                                    onClick={() => handleTimeStep(idx, 'end', 0.2)}
                                    title="종료 0.2초 늦추기"
                                  >
                                    +0.2
                                  </button>
                                  <button
                                    className="time-step-btn"
                                    onClick={() => handleTimeStep(idx, 'end', 0.5)}
                                    title="종료 0.5초 늦춰서 더 오래 보여주기"
                                  >
                                    +0.5
                                  </button>
                                  <input
                                    type="number"
                                    step="0.1"
                                    className="time-direct-input"
                                    value={seg.end}
                                    onChange={(e) => handleDirectTimeChange(idx, 'end', e.target.value)}
                                    title="종료 시간(초) 직접 입력"
                                  />
                                </div>
                              </div>

                              <div className="script-actions">
                                <button
                                  className="script-action-btn split-btn"
                                  onClick={() => handleSplitSegment(idx)}
                                  title="현재 영상 위치 또는 중간에서 이 자막을 2개로 분할(쪼개기)"
                                >
                                  ✂️
                                </button>
                                <button
                                  className="script-action-btn add-btn"
                                  onClick={() => handleAddSegment(idx)}
                                  title="이 자막 아래에 새 자막 추가"
                                >
                                  ➕
                                </button>
                                <button
                                  className="script-action-btn del-btn"
                                  onClick={() => handleDeleteSegment(idx)}
                                  title="이 자막 삭제"
                                >
                                  🗑️
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      <div className="script-list-footer">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleAddSegment(subtitles.length - 1)}
                        >
                          ➕ 목록 끝에 새 자막 행 추가
                        </button>
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

                      {/* 배경음악 (BGM) 선택 */}
                      <div className="tts-section">
                        <div className="section-header-row">
                          <label className="section-label">🎵 배경음악 (BGM) 선택</label>
                          <div className="bgm-upload-action">
                            <input
                              type="file"
                              accept="audio/mp3,audio/m4a,audio/wav,audio/*"
                              ref={bgmFileInputRef}
                              style={{ display: 'none' }}
                              onChange={handleBgmUpload}
                            />
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => bgmFileInputRef.current?.click()}
                              disabled={uploadingBgm}
                            >
                              {uploadingBgm ? '⏳ 업로드 중...' : '📁 내 MP3 추가하기'}
                            </button>
                          </div>
                        </div>

                        <div className="bgm-grid">
                          {/* 1. BGM 없음 옵션 */}
                          <div
                            className={`bgm-card ${selectedBgm === '' ? 'selected' : ''}`}
                            onClick={() => setSelectedBgm('')}
                          >
                            <span className="bgm-icon">🚫</span>
                            <div className="bgm-info">
                              <span className="bgm-name">배경음악 없음</span>
                              <span className="bgm-tag">원본 소리만 사용</span>
                            </div>
                          </div>

                          {/* 2. 등록된 BGM 트랙들 */}
                          {bgmTracks.map((track) => (
                            <div
                              key={track.id}
                              className={`bgm-card ${selectedBgm === track.filename ? 'selected' : ''}`}
                              onClick={() => setSelectedBgm(track.filename)}
                            >
                              <span className="bgm-icon">🎶</span>
                              <div className="bgm-info">
                                <span className="bgm-name" title={track.name}>{track.name}</span>
                                <span className="bgm-tag">
                                  {track.type === 'preset' ? '기본 프리셋' : '내 보관함'}
                                </span>
                              </div>
                              <button
                                className={`btn btn-sm bgm-play-btn ${playingBgmId === track.id ? 'playing' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  togglePlayBgm(track)
                                }}
                                title="미리듣기"
                              >
                                {playingBgmId === track.id ? '⏹ 정지' : '▶ 듣기'}
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 오디오 믹싱 & 속도 조절 */}
                      <div className="tts-settings-grid-3">
                        <div className="setting-box">
                          <label className="setting-label">
                            🔊 원본 소리: <strong>{Math.round(origVolume * 100)}%</strong>
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
                            <span>10% (추천)</span>
                            <span>50%</span>
                          </div>
                        </div>

                        {selectedBgm && (
                          <div className="setting-box">
                            <label className="setting-label">
                              🎵 BGM 볼륨: <strong>{Math.round(bgmVolume * 100)}%</strong>
                            </label>
                            <input
                              type="range"
                              min="0.05"
                              max="0.5"
                              step="0.05"
                              className="range-input"
                              value={bgmVolume}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value)
                                setBgmVolume(v)
                                if (bgmAudioRef.current) bgmAudioRef.current.volume = v * 2
                              }}
                            />
                            <div className="range-hints">
                              <span>5%</span>
                              <span>15% (추천 은은함)</span>
                              <span>50%</span>
                            </div>
                          </div>
                        )}

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
                          <p className="setting-hint">쇼츠는 +10% ~ +20% 속도를 추천합니다.</p>
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

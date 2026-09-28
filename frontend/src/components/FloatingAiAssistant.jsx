/**
 * Phase 7.95 - 전역 플로팅 AI 어시스턴트 위젯 (Floating AI Assistant)
 * 어느 페이지에서든(영상 편집, 회의록, 일정, 뉴스 등) 작업 맥락을 유지한 채
 * 우측 하단 플로팅 버튼 또는 단축키(Cmd+J)로 즉시 소환하는 AI 비서
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './FloatingAiAssistant.css'

const API_BASE = 'http://localhost:8000/api/ai'

// 간이 마크다운 렌더러
function MiniMarkdown({ content }) {
  if (!content) return null

  const lines = content.split('\n')
  const elements = []
  let inCodeBlock = false
  let codeBlockLines = []
  let codeBlockLang = ''

  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const codeText = codeBlockLines.join('\n')
        elements.push(
          <div key={`code-${idx}`} className="floating-code-block">
            <div className="floating-code-header">
              <span>{codeBlockLang || 'code'}</span>
              <button
                className="floating-copy-btn"
                onClick={() => navigator.clipboard.writeText(codeText)}
                title="복사"
              >
                📋 복사
              </button>
            </div>
            <pre><code>{codeText}</code></pre>
          </div>
        )
        inCodeBlock = false
        codeBlockLines = []
        codeBlockLang = ''
      } else {
        inCodeBlock = true
        codeBlockLang = line.replace('```', '').trim()
      }
      return
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      return
    }

    if (line.startsWith('### ')) {
      elements.push(<h4 key={idx}>{parseInline(line.replace('### ', ''))}</h4>)
    } else if (line.startsWith('## ') || line.startsWith('# ')) {
      elements.push(<h3 key={idx}>{parseInline(line.replace(/^#+\s*/, ''))}</h3>)
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      elements.push(
        <div key={idx} className="floating-bullet-item">
          <span className="floating-bullet-dot">•</span>
          <span>{parseInline(line.replace(/^[-*•]\s+/, ''))}</span>
        </div>
      )
    } else if (/^\d+\.\s+/.test(line)) {
      const numMatch = line.match(/^(\d+)\.\s+(.*)/)
      elements.push(
        <div key={idx} className="floating-number-item">
          <span className="floating-number-badge">{numMatch[1]}.</span>
          <span>{parseInline(numMatch[2])}</span>
        </div>
      )
    } else if (line.trim() === '') {
      elements.push(<div key={idx} className="floating-empty-line" />)
    } else {
      elements.push(<p key={idx}>{parseInline(line)}</p>)
    }
  })

  if (inCodeBlock && codeBlockLines.length > 0) {
    const codeText = codeBlockLines.join('\n')
    elements.push(
      <div key="code-unclosed" className="floating-code-block">
        <pre><code>{codeText}</code></pre>
      </div>
    )
  }

  return <div className="floating-markdown">{elements}</div>
}

function parseInline(text) {
  if (!text) return ''
  const parts = []
  const regex = /(\*\*.*?\*\*|`.*?`)/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<code key={match.index} className="floating-inline-code">{token.slice(1, -1)}</code>)
    }
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex))
  }

  return parts.length > 0 ? parts : text
}

// 페이지별 맞춤 퀵 칩 정의
const PAGE_CONTEXT_MAP = {
  '/editor': {
    badge: '🎬 동영상 편집기 연동',
    preset: 'script_writer',
    chips: [
      '✍️ 초반 3초 후킹 대본 작성',
      '🗣️ 이 영상에 어울리는 AI 성우 추천',
      '🎵 어울리는 배경음악(BGM) 제안',
      '✂️ 자막 대본 문장 자연스럽게 다듬기'
    ]
  },
  '/meetings': {
    badge: '💻 컴짱 회의록 연동',
    preset: 'general',
    chips: [
      '📌 이번 회의 핵심 3줄 요약',
      '🚀 주요 결정 사항 및 액션 아이템 추출',
      '📅 회의 후속 일정 계획안 작성',
      '📧 팀 공유용 회의 요약 메일 초안'
    ]
  },
  '/schedule': {
    badge: '📅 스튜디오 일정 연동',
    preset: 'general',
    chips: [
      '📅 이번 주 작업 일정 우선순위 추천',
      '🎬 영상 제작 및 업로드 타임라인 제안',
      '🚲 루틴 일정 관리 팁'
    ]
  },
  '/research': {
    badge: '📡 콘텐츠 기획실 연동',
    preset: 'youtube_plan',
    chips: [
      '🔥 100만뷰 떡상 쇼츠 기획안 3선',
      '🎯 클릭률 높은 킬러 제목 5선',
      '💡 시청 지속시간 높이는 영상 구성'
    ]
  },
  '/news': {
    badge: '📈 뉴스 리서치 연동',
    preset: 'news_analyst',
    chips: [
      '🧠 반도체 & AI 최신 시장 동향 분석',
      '🏢 삼성전자/SK하이닉스/NVIDIA 이슈 정리',
      '📊 오늘 기술 뉴스 핵심 인사이트'
    ]
  },
  '/downloader': {
    badge: '⬇️ 영상 다운로더 연동',
    preset: 'youtube_plan',
    chips: [
      '💡 다운로드한 영상 활용 기획안',
      '✍️ 원본 영상 2차 창작 쇼츠 대본'
    ]
  }
}

export default function FloatingAiAssistant() {
  const location = useLocation()
  const navigate = useNavigate()

  // 1. 상태
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState([
    {
      id: 'welcome',
      role: 'assistant',
      content: '반갑습니다, Bill님! 무엇을 도와드릴까요?\n현재 페이지 작업과 관련된 질문도 언제든 환영합니다. ✨'
    }
  ])
  const [inputText, setInputText] = useState('')
  const [models, setModels] = useState([
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro' },
    { id: 'ollama:gemma3:12b', name: 'Gemma 3 (로컬)' }
  ])
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash-medium')
  const [sessionId, setSessionId] = useState(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')

  const abortControllerRef = useRef(null)
  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  // 현재 페이지 컨텍스트
  const currentPath = location.pathname
  const isDedicatedAiChatPage = currentPath === '/ai-chat'
  const pageContext = PAGE_CONTEXT_MAP[currentPath] || {
    badge: '✨ 올인원 스튜디오 비서',
    preset: 'general',
    chips: [
      '✍️ 쇼츠 후킹 대본 작성',
      '💡 유튜브 콘텐츠 기획',
      '🌐 번역 및 문장 교정',
      '📌 내용 핵심 3줄 요약'
    ]
  }

  // 모델 목록 로드
  useEffect(() => {
    fetch(`${API_BASE}/models`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          setModels(data)
        }
      })
      .catch(() => {})
  }, [])

  // 단축키 (Cmd + J / Ctrl + J) 리스너
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        setIsOpen(prev => !prev)
      } else if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  // 자동 스크롤
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingText, isOpen])

  // 창 열릴 때 포커스
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 150)
    }
  }, [isOpen])

  // 세션 생성 / 보장
  const ensureSession = async () => {
    if (sessionId) return sessionId
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `플로팅 채팅 (${new Date().toLocaleTimeString().slice(0, 5)})`,
          model: selectedModel,
          preset: pageContext.preset || 'general'
        })
      })
      const data = await res.json()
      setSessionId(data.id)
      return data.id
    } catch (e) {
      console.error('세션 생성 에러:', e)
      return 'floating_temp_session'
    }
  }

  // 메시지 전송
  const handleSend = async (customText = null) => {
    const textToSend = (customText !== null ? customText : inputText).trim()
    if (!textToSend || isStreaming) return

    const userMsg = { id: `u_${Date.now()}`, role: 'user', content: textToSend }
    setMessages(prev => [...prev, userMsg])
    setInputText('')
    setIsStreaming(true)
    setStreamingText('')

    try {
      const currentSid = await ensureSession()
      abortControllerRef.current = new AbortController()

      const response = await fetch(`${API_BASE}/sessions/${currentSid}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend,
          model: selectedModel,
          preset: pageContext.preset || 'general'
        }),
        signal: abortControllerRef.current.signal
      })

      if (!response.ok) {
        throw new Error(`서버 응답 오류: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim()
            if (dataStr === '[DONE]') {
              break
            }
            try {
              const parsed = JSON.parse(dataStr)
              if (parsed.error) {
                accumulated += `\n\n⚠️ 오류: ${parsed.error}`
                setStreamingText(accumulated)
              } else if (parsed.content) {
                accumulated += parsed.content
                setStreamingText(accumulated)
              }
            } catch {
              // JSON 파싱 실패 무시
            }
          }
        }
      }

      // 완료 후 어시스턴트 메시지 확정
      setMessages(prev => [
        ...prev,
        { id: `a_${Date.now()}`, role: 'assistant', content: accumulated || '답변을 생성하지 못했습니다.' }
      ])
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [
          ...prev,
          { id: `err_${Date.now()}`, role: 'assistant', content: `⚠️ 오류가 발생했습니다: ${err.message}` }
        ])
      }
    } finally {
      setIsStreaming(false)
      setStreamingText('')
      abortControllerRef.current = null
    }
  }

  // 전송 중지
  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    if (streamingText) {
      setMessages(prev => [
        ...prev,
        { id: `a_${Date.now()}`, role: 'assistant', content: streamingText + ' (중지됨)' }
      ])
    }
    setIsStreaming(false)
    setStreamingText('')
  }

  // 대화 초기화
  const handleClear = () => {
    if (isStreaming) handleStop()
    setSessionId(null)
    setMessages([
      {
        id: 'welcome_new',
        role: 'assistant',
        content: '새로운 대화가 시작되었습니다! 무엇을 도와드릴까요? ✨'
      }
    ])
  }

  // 전체 화면으로 이동
  const handleExpandToFullScreen = () => {
    setIsOpen(false)
    navigate('/ai-chat')
  }

  // Enter 키 전송 (Shift+Enter 줄바꿈)
  const handleKeyDownInput = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 전용 AI 채팅 페이지에서는 플로팅 버튼 숨김
  if (isDedicatedAiChatPage) return null

  return (
    <>
      {/* ─── 1. 플로팅 액션 버튼 (FAB) ────────────────────────── */}
      <button
        className={`floating-ai-fab ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(prev => !prev)}
        title="AI 비서 열기/닫기 (단축키: Cmd+J / Ctrl+J)"
        aria-label="AI 어시스턴트 토글"
      >
        <span className="fab-sparkle">✨</span>
        <span className="fab-label">AI 비서</span>
        <span className="fab-kbd">⌘J</span>
      </button>

      {/* ─── 2. 플로팅 챗봇 팝업 윈도우 ────────────────────── */}
      {isOpen && (
        <div className="floating-ai-window">
          {/* 헤더 */}
          <div className="floating-header">
            <div className="floating-header-left">
              <span className="floating-header-icon">✨</span>
              <div className="floating-title-box">
                <h4 className="floating-title">Bill AI Studio Assistant</h4>
                <span className="floating-context-badge">{pageContext.badge}</span>
              </div>
            </div>

            <div className="floating-header-actions">
              {/* 모델 선택기 */}
              <select
                className="floating-model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isStreaming}
                title="AI 모델 선택"
              >
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              {/* 새 대화 */}
              <button
                className="floating-tool-btn"
                onClick={handleClear}
                title="대화 초기화"
              >
                🧹
              </button>

              {/* 전체 화면 페이지로 확장 */}
              <button
                className="floating-tool-btn"
                onClick={handleExpandToFullScreen}
                title="전체 화면으로 열기 (/ai-chat)"
              >
                ⤢
              </button>

              {/* 닫기 */}
              <button
                className="floating-close-btn"
                onClick={() => setIsOpen(false)}
                title="닫기 (Esc)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* 퀵 프롬프트 칩 */}
          <div className="floating-chips-bar">
            {pageContext.chips.map((chip, idx) => (
              <button
                key={idx}
                className="floating-chip"
                onClick={() => handleSend(chip)}
                disabled={isStreaming}
              >
                {chip}
              </button>
            ))}
          </div>

          {/* 메시지 리스트 */}
          <div className="floating-messages-area">
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`floating-message-row ${msg.role === 'user' ? 'user-row' : 'assistant-row'}`}
              >
                {msg.role === 'assistant' && (
                  <div className="floating-avatar assistant-avatar">✨</div>
                )}
                <div className={`floating-bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
                  {msg.role === 'user' ? (
                    <div className="user-plain-text">{msg.content}</div>
                  ) : (
                    <MiniMarkdown content={msg.content} />
                  )}
                </div>
              </div>
            ))}

            {/* 스트리밍 중인 메시지 */}
            {isStreaming && (
              <div className="floating-message-row assistant-row">
                <div className="floating-avatar assistant-avatar">✨</div>
                <div className="floating-bubble assistant-bubble streaming">
                  <MiniMarkdown content={streamingText} />
                  <span className="streaming-cursor">▋</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* 입력창 바 */}
          <div className="floating-input-container">
            <textarea
              ref={textareaRef}
              className="floating-textarea"
              placeholder="무엇이든 물어보세요... (Shift+Enter 줄바꿈)"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDownInput}
              rows={2}
              disabled={isStreaming}
            />

            <div className="floating-input-actions">
              {isStreaming ? (
                <button
                  type="button"
                  className="floating-stop-btn"
                  onClick={handleStop}
                  title="생성 중지"
                >
                  ⏹ 중지
                </button>
              ) : (
                <button
                  type="button"
                  className="floating-send-btn"
                  onClick={() => handleSend()}
                  disabled={!inputText.trim()}
                  title="전송 (Enter)"
                >
                  🚀
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

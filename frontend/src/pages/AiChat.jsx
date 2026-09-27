/**
 * Phase 7 - AI 어시스턴트 채팅 페이지
 * agy CLI (Gemini 3.8 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6) + Ollama
 * 실시간 SSE 스트리밍 + 세션 히스토리 + 스튜디오 특화 프리셋
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import './AiChat.css'

const API = 'http://localhost:8000/api/ai'

// 마크다운 렌더링 컴포넌트
function ChatMarkdown({ content }) {
  if (!content) return null

  const lines = content.split('\n')
  const elements = []
  let inCodeBlock = false
  let codeBlockLines = []
  let codeBlockLang = ''

  lines.forEach((line, idx) => {
    // 코드 블록 토글
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // 코드 블록 종료
        const codeText = codeBlockLines.join('\n')
        elements.push(
          <div key={`code-${idx}`} className="chat-code-block">
            <div className="chat-code-header">
              <span>{codeBlockLang || 'code'}</span>
              <button
                className="chat-copy-btn"
                onClick={() => navigator.clipboard.writeText(codeText)}
                title="코드 복사"
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

    // 마크다운 헤더
    if (line.startsWith('### ')) {
      elements.push(<h3 key={idx}>{parseInline(line.replace('### ', ''))}</h3>)
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={idx}>{parseInline(line.replace('## ', ''))}</h2>)
    } else if (line.startsWith('# ')) {
      elements.push(<h1 key={idx}>{parseInline(line.replace('# ', ''))}</h1>)
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      elements.push(
        <div key={idx} className="chat-bullet-item">
          <span className="chat-bullet-dot">•</span>
          <span>{parseInline(line.replace(/^[-*•]\s+/, ''))}</span>
        </div>
      )
    } else if (/^\d+\.\s+/.test(line)) {
      const numMatch = line.match(/^(\d+)\.\s+(.*)/)
      elements.push(
        <div key={idx} className="chat-number-item">
          <span className="chat-number-badge">{numMatch[1]}.</span>
          <span>{parseInline(numMatch[2])}</span>
        </div>
      )
    } else if (line.trim() === '') {
      elements.push(<div key={idx} className="chat-empty-line" />)
    } else {
      elements.push(<p key={idx}>{parseInline(line)}</p>)
    }
  })

  // 코드 블록이 닫히지 않은 경우
  if (inCodeBlock && codeBlockLines.length > 0) {
    const codeText = codeBlockLines.join('\n')
    elements.push(
      <div key="code-unclosed" className="chat-code-block">
        <pre><code>{codeText}</code></pre>
      </div>
    )
  }

  return <div className="chat-markdown">{elements}</div>
}

// 볼드체, 인라인 코드, 링크 인라인 파싱
function parseInline(text) {
  if (!text) return ''
  // 간단 파싱: **볼드** 및 `인라인코드`
  const parts = []
  let remaining = text

  // 정규식 분할
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
      parts.push(<code key={match.index} className="chat-inline-code">{token.slice(1, -1)}</code>)
    }
    lastIndex = regex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex))
  }

  return parts.length > 0 ? parts : text
}


export default function AiChat() {
  // ─── 상태 ──────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState([])
  const [currentSessionId, setCurrentSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [models, setModels] = useState([])
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash-medium')
  const [presets, setPresets] = useState([])
  const [selectedPreset, setSelectedPreset] = useState('general')

  // 스트리밍 상태
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const abortControllerRef = useRef(null)

  const messagesEndRef = useRef(null)
  const textareaRef = useRef(null)

  // ─── 초기 데이터 로딩 ──────────────────────────────────────────────
  useEffect(() => {
    loadModels()
    loadPresets()
    loadSessions()
  }, [])

  const loadModels = async () => {
    try {
      const res = await fetch(`${API}/models`)
      const data = await res.json()
      setModels(data)
    } catch (e) {
      console.error(e)
    }
  }

  const loadPresets = async () => {
    try {
      const res = await fetch(`${API}/presets`)
      const data = await res.json()
      setPresets(data)
    } catch (e) {
      console.error(e)
    }
  }

  const loadSessions = async (autoSelectFirst = true) => {
    try {
      const res = await fetch(`${API}/sessions`)
      const data = await res.json()
      setSessions(data)
      if (autoSelectFirst && data.length > 0 && !currentSessionId) {
        selectSession(data[0].id)
      }
    } catch (e) {
      console.error(e)
    }
  }

  // 세션 선택
  const selectSession = async (sessionId) => {
    if (isStreaming) {
      if (abortControllerRef.current) abortControllerRef.current.abort()
      setIsStreaming(false)
    }
    setCurrentSessionId(sessionId)
    setStreamingText('')

    try {
      const res = await fetch(`${API}/sessions/${sessionId}/messages`)
      const msgs = await res.json()
      setMessages(msgs)

      // 세션 정보에서 모델/프리셋 동기화
      const sess = sessions.find(s => s.id === sessionId)
      if (sess) {
        if (sess.model) setSelectedModel(sess.model)
        if (sess.preset) setSelectedPreset(sess.preset)
      }
    } catch (e) {
      console.error(e)
    }
  }

  // 스크롤 맨 아래로
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingText])

  // ─── 새 대화 시작 ──────────────────────────────────────────────────
  const handleNewSession = async (presetOverride = null) => {
    if (isStreaming) {
      if (abortControllerRef.current) abortControllerRef.current.abort()
      setIsStreaming(false)
    }

    const presetToUse = presetOverride || selectedPreset
    try {
      const res = await fetch(`${API}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '새로운 대화',
          model: selectedModel,
          preset: presetToUse,
        }),
      })
      const newSess = await res.json()
      await loadSessions(false)
      setCurrentSessionId(newSess.id)
      setMessages([])
      setStreamingText('')
      if (textareaRef.current) textareaRef.current.focus()
    } catch (e) {
      console.error(e)
    }
  }

  // 세션 삭제
  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation()
    if (!confirm('이 대화 내역을 삭제하시겠습니까?')) return
    try {
      await fetch(`${API}/sessions/${sessionId}`, { method: 'DELETE' })
      const remaining = sessions.filter(s => s.id !== sessionId)
      setSessions(remaining)
      if (currentSessionId === sessionId) {
        if (remaining.length > 0) {
          selectSession(remaining[0].id)
        } else {
          setCurrentSessionId(null)
          setMessages([])
        }
      }
    } catch (e) {
      console.error(e)
    }
  }

  // ─── 메시지 전송 및 실시간 SSE 스트리밍 ────────────────────────────
  const handleSendMessage = async (textToSend = null) => {
    const text = (textToSend || inputText).trim()
    if (!text || isStreaming) return

    setInputText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    // 만약 현재 세션이 없으면 자동 생성
    let activeSessionId = currentSessionId
    if (!activeSessionId) {
      try {
        const res = await fetch(`${API}/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: text.slice(0, 25),
            model: selectedModel,
            preset: selectedPreset,
          }),
        })
        const newSess = await res.json()
        activeSessionId = newSess.id
        setCurrentSessionId(newSess.id)
        setSessions(prev => [newSess, ...prev])
      } catch (e) {
        console.error(e)
        return
      }
    }

    // 사용자 메시지 낙관적 렌더링
    const userMessage = {
      id: 'temp-user-' + Date.now(),
      session_id: activeSessionId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMessage])

    // 스트리밍 시작
    setIsStreaming(true)
    setStreamingText('')

    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const res = await fetch(`${API}/sessions/${activeSessionId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          model: selectedModel,
          preset: selectedPreset,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`서버 오류 (${res.status})`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let fullAssistantText = ''

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
            break
          }

          try {
            const data = JSON.parse(payload)
            if (data.type === 'token') {
              fullAssistantText += data.text
              setStreamingText(prev => prev + data.text)
            } else if (data.type === 'done') {
              // 스트리밍 완료 처리
              const assistantMessage = {
                id: 'msg-' + Date.now(),
                session_id: activeSessionId,
                role: 'assistant',
                content: data.full_text || fullAssistantText,
                created_at: new Date().toISOString(),
              }
              setMessages(prev => [...prev, assistantMessage])
              setStreamingText('')
              loadSessions(false) // 세션 목록의 마지막 메시지 & 제목 갱신
            }
          } catch {
            /* 파싱 실패 무시 */
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        const errorMsg = {
          id: 'err-' + Date.now(),
          session_id: activeSessionId,
          role: 'assistant',
          content: `⚠️ 오류가 발생했습니다: ${e.message}`,
          created_at: new Date().toISOString(),
        }
        setMessages(prev => [...prev, errorMsg])
        setStreamingText('')
      }
    } finally {
      setIsStreaming(false)
      abortControllerRef.current = null
    }
  }

  // 스트리밍 중단
  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    if (streamingText) {
      setMessages(prev => [
        ...prev,
        {
          id: 'stopped-' + Date.now(),
          session_id: currentSessionId,
          role: 'assistant',
          content: streamingText + ' *(답변 중단됨)*',
          created_at: new Date().toISOString(),
        },
      ])
      setStreamingText('')
    }
    setIsStreaming(false)
  }

  // 키보드 이벤트 (Enter = 전송, Shift+Enter = 줄바꿈)
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // 입력창 자동 높이 조절
  const handleInputChange = (e) => {
    setInputText(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`
    }
  }

  // 현재 세션 정보
  const currentSession = sessions.find(s => s.id === currentSessionId)

  // 추천 스타터 카드
  const starterCards = [
    {
      icon: '🎬',
      title: '유튜브 콘텐츠 기획',
      desc: '시청 지속시간과 클릭률(CTR)을 높이는 주제 기획',
      preset: 'youtube_plan',
      prompt: '요즘 2030 세대 사이에서 조회수가 폭발하는 유튜브 쇼츠 주제 5가지와 킬러 제목을 제안해줘.',
    },
    {
      icon: '✍️',
      title: '쇼츠 60초 킬러 대본',
      desc: '초반 3초 후킹과 타임코드가 들어간 영상 대본',
      preset: 'script_writer',
      prompt: '삼성전자와 SK하이닉스 HBM 반도체 호황에 관한 흥미진진한 60초 쇼츠 대본을 타임코드와 함께 작성해줘.',
    },
    {
      icon: '📈',
      title: '오늘의 관심종목 브리핑',
      desc: 'NVIDIA, 테슬라, 반도체 핵심 시사점 분석',
      preset: 'news_analyst',
      prompt: '최근 NVIDIA와 테슬라의 AI 및 자율주행 관련 핵심 이슈와 비즈니스 시사점을 명쾌하게 분석해줘.',
    },
    {
      icon: '💡',
      title: '스튜디오 자유 브레인스토밍',
      desc: '새로운 채널 브랜딩, 일정 조율 및 아이디어 회의',
      preset: 'general',
      prompt: '내 개인 스튜디오 채널을 효과적으로 성장시키기 위한 주간 작업 루틴과 로드맵을 설계해줘.',
    },
  ]

  return (
    <div className="aichat-page">

      {/* ═══ 좌측: 세션 목록 사이드바 ═══ */}
      <aside className="aichat-sidebar">
        <div className="aichat-sidebar-top">
          <button className="new-chat-btn" onClick={() => handleNewSession()}>
            <span className="btn-icon">＋</span> 새 대화 시작
          </button>
        </div>

        {/* 모델 및 프리셋 선택 바 */}
        <div className="aichat-settings-card">
          <div className="setting-row">
            <span className="setting-label">AI 모델</span>
            <select
              className="model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isStreaming}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.badge} {m.name}
                </option>
              ))}
            </select>
          </div>

          <div className="setting-row">
            <span className="setting-label">역할 모드</span>
            <select
              className="preset-select"
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              disabled={isStreaming}
            >
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 세션 히스토리 목록 */}
        <div className="session-list-header">
          <span>대화 기록</span>
          <span className="session-count">{sessions.length}</span>
        </div>

        <div className="session-list">
          {sessions.length === 0 ? (
            <div className="session-empty">대화 기록이 없습니다.</div>
          ) : (
            sessions.map(s => (
              <div
                key={s.id}
                className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => selectSession(s.id)}
              >
                <div className="session-info">
                  <div className="session-title">{s.title || '대화'}</div>
                  <div className="session-preview">{s.last_message || '새로운 세션'}</div>
                </div>
                <button
                  className="session-delete-btn"
                  onClick={(e) => handleDeleteSession(s.id, e)}
                  title="대화 삭제"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        {/* 하단 엔진 상태 뱃지 */}
        <div className="aichat-sidebar-footer">
          <div className="engine-status">
            <span className="status-dot online" />
            <span className="engine-name">agy CLI Engine 연동됨</span>
          </div>
        </div>
      </aside>

      {/* ═══ 우측: 메인 채팅 대화창 ═══ */}
      <main className="aichat-main">
        {/* 상단 탑바 */}
        <header className="aichat-header">
          <div className="header-left">
            <h2 className="current-title">{currentSession?.title || 'AI 어시스턴트'}</h2>
            <div className="current-badges">
              <span className="model-badge">
                {models.find(m => m.id === selectedModel)?.badge || '⚡'} {models.find(m => m.id === selectedModel)?.name || selectedModel}
              </span>
              <span className="preset-badge">
                {presets.find(p => p.id === selectedPreset)?.name || '💡 스튜디오 비서'}
              </span>
            </div>
          </div>
          <div className="header-right">
            <button
              className="header-clear-btn"
              onClick={() => handleNewSession()}
              title="새 창으로 시작"
            >
              🔄 새 대화
            </button>
          </div>
        </header>

        {/* 메시지 리스트 또는 웰컴 화면 */}
        <div className="aichat-messages-container">
          {messages.length === 0 && !streamingText ? (
            <div className="aichat-welcome">
              <div className="welcome-icon">🎬</div>
              <h1>무엇을 도와드릴까요, Bill님?</h1>
              <p className="welcome-subtitle">
                유튜브 콘텐츠 기획, 킬러 대본 작성, 관심종목 뉴스 분석까지<br />
                <strong>Gemini 3.8 Flash & Claude Sonnet</strong> 엔진이 스마트하게 도와드립니다.
              </p>

              {/* 4가지 추천 카드 */}
              <div className="starter-grid">
                {starterCards.map((card, i) => (
                  <div
                    key={i}
                    className="starter-card"
                    onClick={() => {
                      setSelectedPreset(card.preset)
                      handleSendMessage(card.prompt)
                    }}
                  >
                    <div className="starter-icon">{card.icon}</div>
                    <div className="starter-title">{card.title}</div>
                    <div className="starter-desc">{card.desc}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages-flow">
              {messages.map((msg, i) => (
                <div
                  key={msg.id || i}
                  className={`message-row ${msg.role === 'user' ? 'user-row' : 'assistant-row'}`}
                >
                  {msg.role === 'assistant' && (
                    <div className="bot-avatar">🤖</div>
                  )}
                  <div className={`message-bubble ${msg.role}`}>
                    {msg.role === 'user' ? (
                      <div className="user-text">{msg.content}</div>
                    ) : (
                      <>
                        <ChatMarkdown content={msg.content} />
                        <div className="bubble-actions">
                          <button
                            className="msg-action-btn"
                            onClick={() => navigator.clipboard.writeText(msg.content)}
                            title="전체 답변 복사"
                          >
                            📋 복사
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ))}

              {/* 실시간 스트리밍 답변 버블 */}
              {isStreaming && (
                <div className="message-row assistant-row">
                  <div className="bot-avatar pulsing">🤖</div>
                  <div className="message-bubble assistant streaming">
                    {streamingText ? (
                      <ChatMarkdown content={streamingText} />
                    ) : (
                      <div className="thinking-dots">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                    <span className="streaming-cursor" />
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* 하단 입력 영역 */}
        <div className="aichat-input-area">
          <div className="input-box-wrapper">
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              placeholder="AI 어시스턴트에게 무엇이든 물어보세요... (Shift+Enter 줄바꿈, Enter 전송)"
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              rows={1}
            />

            <div className="input-actions">
              {isStreaming ? (
                <button
                  className="stop-btn"
                  onClick={handleStopStreaming}
                  title="답변 생성 중단"
                >
                  ■ 중지
                </button>
              ) : (
                <button
                  className={`send-btn ${inputText.trim() ? 'active' : ''}`}
                  onClick={() => handleSendMessage()}
                  disabled={!inputText.trim()}
                  title="메시지 전송 (Enter)"
                >
                  <span className="send-arrow">↑</span>
                </button>
              )}
            </div>
          </div>
          <div className="input-footnote">
            Bill Studio AI는 사실과 다른 정보를 생성할 수 있으니 주요 정보는 한 번 더 확인하세요.
          </div>
        </div>
      </main>

    </div>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import './Editor.css'

function formatSize(bytes) {
  if (!bytes) return '알 수 없음'
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  return (bytes / 1024).toFixed(0) + ' KB'
}

export default function Subtitle() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fileParam = searchParams.get('file')

  const [fileList, setFileList] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (fileParam) {
      navigate(`/editor?file=${encodeURIComponent(fileParam)}`, { replace: true })
      return
    }
    loadFiles()
  }, [fileParam])

  async function loadFiles() {
    setLoading(true)
    try {
      const res = await fetch('/api/editor/files')
      if (res.ok) {
        const data = await res.json()
        setFileList(data.files || [])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="editor-page">
      <div className="card file-picker-card">
        <div className="picker-header">
          <h2>🎙️ AI 자막 생성 및 편집</h2>
          <p>자막을 추출하고 실시간으로 싱크를 맞출 동영상 또는 오디오를 선택하세요.</p>
        </div>

        {loading ? (
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
                onClick={() => navigate(`/editor?file=${encodeURIComponent(f.name)}`)}
              >
                <div className="picker-item-icon">🎬</div>
                <div className="picker-item-info">
                  <h4 className="picker-name" title={f.name}>{f.name}</h4>
                  <span className="picker-meta">{formatSize(f.size)} • {f.ext.toUpperCase()}</span>
                </div>
                <button className="btn btn-primary btn-sm">자막 생성 및 편집 열기</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

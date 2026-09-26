import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Header from './components/Header'
import Dashboard from './pages/Dashboard'
import Downloader from './pages/Downloader'
import Editor from './pages/Editor'
import Subtitle from './pages/Subtitle'
import Schedule from './pages/Schedule'
import News from './pages/News'
import AiChat from './pages/AiChat'
import './App.css'

function App() {
  return (
    <BrowserRouter>
      <div className="app-layout">
        <Sidebar />
        <div className="main-area">
          <Header />
          <main className="content">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/downloader" element={<Downloader />} />
              <Route path="/editor" element={<Editor />} />
              <Route path="/subtitle" element={<Subtitle />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/news" element={<News />} />
              <Route path="/ai-chat" element={<AiChat />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}

export default App

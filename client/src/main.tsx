import ReactDOM from 'react-dom/client'
import App from './App'
import { ChatWindowApp } from './app/ChatWindowApp'
import { WindowCloseGuard } from './app/WindowCloseGuard'
import './index.css'
import './i18n' // Initialize i18n
import { startPerfDiagnostics } from './lib/perfDiagnostics'

startPerfDiagnostics()

// `?window=chat`: a consultation's own window (「別ウィンドウで開く」), only the chat.
const isChatWindow = new URLSearchParams(window.location.search).get('window') === 'chat'

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled: double-rendering in dev mode causes input lag in ChatPanel
  // Re-enable periodically to check for bugs: <React.StrictMode><App /></React.StrictMode>
  isChatWindow ? <ChatWindowApp /> : <><App /><WindowCloseGuard /></>,
)

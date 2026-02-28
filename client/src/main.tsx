import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n' // Initialize i18n
import { startPerfDiagnostics } from './lib/perfDiagnostics'

startPerfDiagnostics()

ReactDOM.createRoot(document.getElementById('root')!).render(
  // StrictMode disabled: double-rendering in dev mode causes input lag in ChatPanel
  // Re-enable periodically to check for bugs: <React.StrictMode><App /></React.StrictMode>
  <App />,
)

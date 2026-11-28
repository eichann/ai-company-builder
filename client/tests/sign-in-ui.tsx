/* eslint-disable react-refresh/only-export-components -- standalone preview page entry, never hot-reloaded as a module */
// Preview page for the screens before a company opens: the login screen and the server setup
// screen (features/auth), with the preload API faked. Query:
//   ?screen=login (default) | server | offer   offer = an invitation link brought a server address
//   ?screen=chat-settings  the chat's own settings (AuthSettings); &mode=claude-code (default) | api-key | codex,
//                          &claude=ready (default) | missing | signin  what Claude Code answers (missing / signin: the amber box)
//   ?theme=dark   dark mode (the `dark` class on <html>, as the app sets it)
//   &accept=ok      the offered address is accepted (default: refused with a message)
//   &signin=ok      sign-in succeeds (default: fails with a message, the error box)
// A server address containing "bad" is refused, any other is accepted. Calls the page made are
// in window.__acbSignIn.calls; window.__acbSignIn.offer(server) changes the link's address (as a
// newer link would) and accepting checks the address the screen passes against it, as main does.
import { createRoot } from 'react-dom/client'
import '../src/i18n'
import '../src/index.css'
import { LoginScreen } from '../src/features/auth/components/LoginScreen'
import { ServerSetupScreen } from '../src/features/auth/components/ServerSetupScreen'
import { AuthSettings } from '../src/features/chat/components/ChatAuthSettings'
import type { ClaudeCodeStatus } from '../shared/ipc-contract'
import { installElectronAPI } from './ui/fixtures/electron-api'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const screen = params.get('screen') ?? 'login'
const calls: unknown[][] = []
let offered: string | null = screen === 'offer' ? 'https://acb.example.com' : null
;(window as unknown as { __acbSignIn: unknown }).__acbSignIn = { calls, offer: (server: string | null) => { offered = server } }

installElectronAPI({
  getServerUrl: async () => 'https://acb.example.com',
  signIn: async email => {
    calls.push(['signIn', email])
    return params.get('signin') === 'ok' ? { success: true } : { success: false, error: 'メールアドレスかパスワードが違います' }
  },
  getSession: async () => ({ success: true, user: { id: 'u1', email: 'yamada@example.com', name: '山田 太郎', image: null, emailVerified: true } }),
  validateServerUrl: async url => {
    calls.push(['validateServerUrl', url])
    return url.includes('bad') ? { valid: false, error: 'このアドレスの会社のサーバーが見つかりません' } : { valid: true }
  },
  setServerUrl: async url => { calls.push(['setServerUrl', url]); return true },
  getAppLinkServerOffer: async () => (offered ? { server: offered } : null),
  acceptAppLinkServer: async shown => {
    calls.push(['acceptAppLinkServer', shown])
    if (shown !== offered) return { success: false, error: '招待のリンクが新しくなりました。' }
    if (params.get('accept') !== 'ok') return { success: false, error: 'つなげませんでした。' }
    offered = null
    return { success: true }
  },
  dismissAppLinkServer: async () => { calls.push(['dismissAppLinkServer']); offered = null },
  getApiKeyStatus: async () => ({ set: true, last4: 'ab12', encryptionAvailable: false, unreadable: true }),
  getPermissionMode: async () => 'auto',
  getCodexStatus: async () => ({ available: true, authenticated: false, models: [], error: 'Codex にログインしていません' }),
})

const claude = params.get('claude') ?? 'ready'
const claudeStatus: ClaudeCodeStatus = {
  available: claude !== 'missing', authenticated: claude === 'ready', cliPath: null, version: '2.1.0', error: null, checkedAt: 0,
  signIn: { state: claude === 'signin' ? 'signed-out' : 'signed-in' }, signInSupported: true,
}

function Preview() {
  return (
    <main className="h-screen">
      {screen === 'login' ? <LoginScreen serverUrl="https://acb.example.com" />
        : screen === 'chat-settings' ? (
          <div className="mx-auto h-full max-w-[420px]">
            <AuthSettings authMode={(params.get('mode') ?? 'claude-code') as 'claude-code'} claudeCodeAvailable={claude !== 'missing'}
              claudeStatus={claudeStatus} claudeRoot="/tmp/acb-preview" onRecheck={() => calls.push(['recheck'])} onClose={() => calls.push(['close'])} />
          </div>
        )
        : <ServerSetupScreen onComplete={() => calls.push(['complete'])} />}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

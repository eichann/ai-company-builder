'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { invitationsApi, authApi } from '@/lib/api'

interface InvitationInfo {
  companyName: string
  role: string
  expiresAt: string
}

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const router = useRouter()
  const { user, loading: authLoading, refresh } = useAuth()
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [success, setSuccess] = useState(false)

  // Registration form state
  const [showRegister, setShowRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [registering, setRegistering] = useState(false)

  useEffect(() => {
    validateInvitation()
  }, [token])

  const validateInvitation = async () => {
    try {
      const res = await invitationsApi.validate(token)
      setInvitation(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid invitation')
    } finally {
      setLoading(false)
    }
  }

  const handleAccept = async () => {
    setAccepting(true)
    setError(null)
    try {
      await invitationsApi.accept(token)
      setSuccess(true)
      // Redirect to dashboard after 2 seconds
      setTimeout(() => {
        router.push('/dashboard')
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invitation')
    } finally {
      setAccepting(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setRegistering(true)
    setError(null)
    try {
      // Register the user (pass invitation token to bypass signup restriction)
      await authApi.signUp(email, password, name, token)
      // Refresh session to get user info
      await refresh()
      // Close registration form and show accept button
      setShowRegister(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register')
    } finally {
      setRegistering(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-400">読み込み中...</div>
      </div>
    )
  }

  if (error && !invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="max-w-md w-full mx-4">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">無効な招待リンク</h1>
            <p className="text-zinc-400 mb-6">{error}</p>
            <Link
              href="/login"
              className="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
            >
              ログインページへ
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="max-w-md w-full mx-4">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">招待を受け入れました</h1>
            <p className="text-zinc-400 mb-4">
              <span className="text-white font-semibold">{invitation?.companyName}</span> に参加しました。
            </p>
            <p className="text-sm text-zinc-500">ダッシュボードにリダイレクトしています...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="max-w-md w-full mx-4">
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8">
          <div className="text-center mb-6">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">招待を受け取りました</h1>
            <p className="text-zinc-400">
              <span className="text-white font-semibold">{invitation?.companyName}</span> への参加を招待されています。
            </p>
          </div>

          <div className="bg-zinc-800/50 rounded-lg p-4 mb-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-zinc-500">会社名</span>
                <div className="text-white font-medium">{invitation?.companyName}</div>
              </div>
              <div>
                <span className="text-zinc-500">役割</span>
                <div className="text-white font-medium">
                  {invitation?.role === 'admin' ? '管理者' : 'メンバー'}
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg mb-4">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {user ? (
            <>
              <p className="text-sm text-zinc-400 text-center mb-4">
                <span className="text-white">{user.email}</span> としてログインしています
              </p>
              <button
                onClick={handleAccept}
                disabled={accepting}
                className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-medium rounded-lg transition-colors"
              >
                {accepting ? '処理中...' : '招待を受け入れる'}
              </button>
            </>
          ) : showRegister ? (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">名前</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="山田太郎"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="user@example.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">パスワード</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="8文字以上"
                  minLength={8}
                  required
                />
              </div>
              <button
                type="submit"
                disabled={registering}
                className="w-full px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-medium rounded-lg transition-colors"
              >
                {registering ? '登録中...' : '登録して参加'}
              </button>
              <button
                type="button"
                onClick={() => setShowRegister(false)}
                className="w-full px-6 py-2 text-zinc-400 hover:text-white text-sm transition-colors"
              >
                戻る
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <Link
                href={`/login?redirect=/invite/${token}`}
                className="w-full block text-center px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors"
              >
                ログインして参加
              </Link>
              <button
                onClick={() => setShowRegister(true)}
                className="w-full px-6 py-3 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors"
              >
                新規登録して参加
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

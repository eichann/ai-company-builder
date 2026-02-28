'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { companiesApi, invitationsApi, departmentsApi, Company, Member, Invitation, Department } from '@/lib/api'

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [company, setCompany] = useState<Company | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Invite link state
  const [showCreateInvite, setShowCreateInvite] = useState(false)
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviteExpireDays, setInviteExpireDays] = useState(7)
  const [creating, setCreating] = useState(false)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [authLoading, user, router])

  useEffect(() => {
    if (user) {
      loadData()
    }
  }, [user, id])

  const loadData = async () => {
    try {
      const [companyRes, membersRes, invitationsRes, departmentsRes] = await Promise.all([
        companiesApi.get(id),
        companiesApi.getMembers(id),
        invitationsApi.list(id),
        departmentsApi.list(id, true), // flat=true
      ])
      setCompany(companyRes.data)
      setMembers(membersRes.data)
      setInvitations(invitationsRes.data)
      setDepartments(departmentsRes.data as Department[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load company')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateInvitation = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    try {
      await invitationsApi.create(id, inviteRole, inviteExpireDays)
      setShowCreateInvite(false)
      setInviteRole('member')
      setInviteExpireDays(7)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invitation')
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteInvitation = async (invitationId: string) => {
    if (!confirm('この招待リンクを削除しますか？')) return
    try {
      await invitationsApi.delete(id, invitationId)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete invitation')
    }
  }

  const copyInviteLink = async (token: string) => {
    const baseUrl = window.location.origin
    const link = `${baseUrl}/invite/${token}`

    try {
      // Try modern clipboard API first
      await navigator.clipboard.writeText(link)
      setCopiedToken(token)
      setTimeout(() => setCopiedToken(null), 2000)
    } catch {
      // Fallback for HTTP environments: use execCommand
      const textArea = document.createElement('textarea')
      textArea.value = link
      textArea.style.position = 'fixed'
      textArea.style.left = '-9999px'
      document.body.appendChild(textArea)
      textArea.select()
      try {
        document.execCommand('copy')
        setCopiedToken(token)
        setTimeout(() => setCopiedToken(null), 2000)
      } catch {
        // If all else fails, show the link in a prompt
        window.prompt('リンクをコピーしてください:', link)
      }
      document.body.removeChild(textArea)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    if (!confirm('このメンバーを削除しますか？')) return
    try {
      await companiesApi.removeMember(id, userId)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-400">読み込み中...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-16 gap-4">
            <Link href="/dashboard" className="text-zinc-400 hover:text-white transition-colors">
              ← 戻る
            </Link>
            <h1 className="text-xl font-bold text-white">
              {company?.name || '読み込み中...'}
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="text-center py-12 text-zinc-400">読み込み中...</div>
        ) : error ? (
          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">
            {error}
          </div>
        ) : company ? (
          <div className="space-y-8">
            {/* Company Info */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">会社情報</h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <dt className="text-sm text-zinc-500">会社名</dt>
                  <dd className="text-white">{company.name}</dd>
                </div>
                <div>
                  <dt className="text-sm text-zinc-500">スラッグ</dt>
                  <dd className="text-white font-mono">{company.slug}</dd>
                </div>
                <div>
                  <dt className="text-sm text-zinc-500">リポジトリパス</dt>
                  <dd className="text-white font-mono text-sm">{company.repoPath || '-'}</dd>
                </div>
                <div>
                  <dt className="text-sm text-zinc-500">作成日</dt>
                  <dd className="text-white">
                    {new Date(company.createdAt).toLocaleDateString('ja-JP')}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Invitation Links */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-white">招待リンク</h2>
                <button
                  onClick={() => setShowCreateInvite(true)}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  招待リンクを作成
                </button>
              </div>

              {/* Create Invitation Form */}
              {showCreateInvite && (
                <form onSubmit={handleCreateInvitation} className="mb-6 p-4 bg-zinc-800/50 rounded-lg">
                  <div className="flex gap-4 items-end">
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1">役割</label>
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                        className="px-3 py-2 bg-zinc-700 border border-zinc-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="member">メンバー</option>
                        <option value="admin">管理者</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm text-zinc-400 mb-1">有効期限</label>
                      <select
                        value={inviteExpireDays}
                        onChange={(e) => setInviteExpireDays(Number(e.target.value))}
                        className="px-3 py-2 bg-zinc-700 border border-zinc-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value={1}>1日</option>
                        <option value={7}>7日</option>
                        <option value={30}>30日</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      disabled={creating}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      {creating ? '作成中...' : '作成'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateInvite(false)}
                      className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      キャンセル
                    </button>
                  </div>
                </form>
              )}

              {/* Invitations List */}
              <div className="space-y-2">
                {invitations.length === 0 ? (
                  <p className="text-zinc-500 text-sm py-4 text-center">招待リンクはありません</p>
                ) : (
                  invitations.map((invitation) => (
                    <div
                      key={invitation.id}
                      className={`flex items-center justify-between p-3 rounded-lg ${
                        invitation.isUsed || invitation.isExpired
                          ? 'bg-zinc-800/20 opacity-60'
                          : 'bg-zinc-800/30'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            invitation.role === 'admin'
                              ? 'bg-purple-500/10 text-purple-400'
                              : 'bg-zinc-700/50 text-zinc-400'
                          }`}>
                            {invitation.role === 'admin' ? '管理者' : 'メンバー'}
                          </span>
                          {invitation.isUsed && (
                            <span className="text-xs bg-green-500/10 text-green-400 px-2 py-0.5 rounded">使用済み</span>
                          )}
                          {invitation.isExpired && !invitation.isUsed && (
                            <span className="text-xs bg-red-500/10 text-red-400 px-2 py-0.5 rounded">期限切れ</span>
                          )}
                          {invitation.isUsed && (invitation.usedByName || invitation.usedByEmail) && (
                            <span className="text-xs text-zinc-300">
                              → {invitation.usedByName || invitation.usedByEmail}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                          作成: {invitation.createdByName || invitation.createdByEmail || '不明'} / {new Date(invitation.createdAt).toLocaleDateString('ja-JP')} /
                          期限: {new Date(invitation.expiresAt).toLocaleDateString('ja-JP')}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!invitation.isUsed && !invitation.isExpired && (
                          <button
                            onClick={() => copyInviteLink(invitation.token)}
                            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                              copiedToken === invitation.token
                                ? 'bg-green-600 text-white'
                                : 'bg-zinc-700 hover:bg-zinc-600 text-white'
                            }`}
                          >
                            {copiedToken === invitation.token ? 'コピー済み' : 'リンクをコピー'}
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteInvitation(invitation.id)}
                          className="text-red-400 hover:text-red-300 text-sm transition-colors"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Members */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">メンバー</h2>

              {/* Members List */}
              <div className="space-y-2">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-3 bg-zinc-800/30 rounded-lg"
                  >
                    <div>
                      <div className="text-white">{member.name || member.email}</div>
                      {member.name && (
                        <div className="text-sm text-zinc-500">{member.email}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        member.role === 'owner'
                          ? 'bg-amber-500/10 text-amber-400'
                          : member.role === 'admin'
                          ? 'bg-purple-500/10 text-purple-400'
                          : 'bg-zinc-700/50 text-zinc-400'
                      }`}>
                        {member.role === 'owner' ? 'オーナー' : member.role === 'admin' ? '管理者' : 'メンバー'}
                      </span>
                      {member.role !== 'owner' && member.userId !== user.id && (
                        <button
                          onClick={() => handleRemoveMember(member.userId)}
                          className="text-red-400 hover:text-red-300 text-sm transition-colors"
                        >
                          削除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Departments */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-white">部署</h2>
                <Link
                  href={`/companies/${id}/departments`}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  部署を管理
                </Link>
              </div>

              {/* Departments List */}
              <div className="space-y-2">
                {departments.length === 0 ? (
                  <p className="text-zinc-500 text-sm py-4 text-center">部署はありません</p>
                ) : (
                  departments
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((dept) => (
                    <div
                      key={dept.id}
                      className="flex items-center justify-between p-3 bg-zinc-800/30 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm"
                          style={{ backgroundColor: dept.color }}
                        >
                          {dept.name.charAt(0)}
                        </div>
                        <div>
                          <div className="text-white">{dept.name}</div>
                          {dept.nameEn && (
                            <div className="text-xs text-zinc-500">{dept.nameEn}</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-500 font-mono">{dept.folder}</span>
                        {!dept.isActive && (
                          <span className="text-xs bg-zinc-700/50 text-zinc-400 px-2 py-0.5 rounded">無効</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </div>
  )
}

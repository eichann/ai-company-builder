'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { companiesApi, Company } from '@/lib/api'

export default function DashboardPage() {
  const router = useRouter()
  const { user, loading: authLoading, signOut } = useAuth()
  const [companies, setCompanies] = useState<Company[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login')
    }
  }, [authLoading, user, router])

  useEffect(() => {
    if (user) {
      loadCompanies()
    }
  }, [user])

  const loadCompanies = async () => {
    try {
      const res = await companiesApi.list()
      setCompanies(res.data)
    } catch (error) {
      console.error('Failed to load companies:', error)
    } finally {
      setLoading(false)
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-400">読み込み中...</div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold text-white">AI Company Builder</h1>
              <span className="text-xs px-2 py-1 bg-blue-500/10 text-blue-400 rounded-full">
                Admin
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-400">{user.email}</span>
              <button
                onClick={signOut}
                className="text-sm text-zinc-400 hover:text-white transition-colors"
              >
                ログアウト
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-2">ダッシュボード</h2>
          <p className="text-zinc-400">
            ようこそ、{user.name || user.email}さん
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-3xl font-bold text-white mb-1">
              {companies.length}
            </div>
            <div className="text-zinc-400 text-sm">登録会社数</div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-3xl font-bold text-white mb-1">
              {companies.filter(c => c.role === 'owner').length}
            </div>
            <div className="text-zinc-400 text-sm">オーナー</div>
          </div>
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-3xl font-bold text-white mb-1">
              {companies.filter(c => c.role === 'member').length}
            </div>
            <div className="text-zinc-400 text-sm">メンバー</div>
          </div>
        </div>

        {/* Companies section */}
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">会社一覧</h3>
          <Link
            href="/companies/new"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            新規作成
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-12 text-zinc-400">読み込み中...</div>
        ) : companies.length === 0 ? (
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
            <div className="text-zinc-500 mb-4">まだ会社が登録されていません</div>
            <Link
              href="/companies/new"
              className="inline-flex items-center px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              最初の会社を作成
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {companies.map((company) => (
              <Link
                key={company.id}
                href={`/companies/${company.id}`}
                className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6 hover:border-zinc-700 transition-colors group"
              >
                <div className="flex items-start justify-between mb-3">
                  <h4 className="font-semibold text-white group-hover:text-blue-400 transition-colors">
                    {company.name}
                  </h4>
                  <span className={`text-xs px-2 py-1 rounded-full ${
                    company.role === 'owner'
                      ? 'bg-amber-500/10 text-amber-400'
                      : 'bg-zinc-700/50 text-zinc-400'
                  }`}>
                    {company.role === 'owner' ? 'オーナー' : 'メンバー'}
                  </span>
                </div>
                <div className="text-sm text-zinc-500">
                  <span className="font-mono">{company.slug}</span>
                </div>
                <div className="text-xs text-zinc-600 mt-2">
                  作成日: {new Date(company.createdAt).toLocaleDateString('ja-JP')}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

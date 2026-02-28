'use client'

import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth-context'
import { companiesApi, departmentsApi, Company, Department, CreateDepartmentInput, UpdateDepartmentInput } from '@/lib/api'
import {
  Buildings,
  Storefront,
  ChartPie,
  Users,
  Article,
  Code,
  Folder,
  Briefcase,
  Globe,
  Heart,
  Lightning,
  Star,
  Shield,
  Gear,
  IconProps,
} from '@phosphor-icons/react'

// Icon options for departments
const ICON_OPTIONS = [
  'Buildings', 'Storefront', 'ChartPie', 'Users', 'Article', 'Code', 'Folder',
  'Briefcase', 'Globe', 'Heart', 'Lightning', 'Star', 'Shield', 'Gear'
] as const

// Icon component map
const IconMap: Record<string, React.ComponentType<IconProps>> = {
  Buildings,
  Storefront,
  ChartPie,
  Users,
  Article,
  Code,
  Folder,
  Briefcase,
  Globe,
  Heart,
  Lightning,
  Star,
  Shield,
  Gear,
}

// Color options for departments
const COLOR_OPTIONS = [
  '#f59e0b', '#3b82f6', '#10b981', '#ec4899', '#8b5cf6', '#6366f1',
  '#ef4444', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#a855f7'
]

export default function DepartmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()
  const [company, setCompany] = useState<Company | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [editingDept, setEditingDept] = useState<Department | null>(null)
  const [formData, setFormData] = useState<CreateDepartmentInput>({
    name: '',
    nameEn: '',
    folder: '',
    icon: 'Folder',
    color: '#6366f1',
    description: '',
  })
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  // Delete confirmation modal state
  const [deleteTarget, setDeleteTarget] = useState<Department | null>(null)
  const [deleteStats, setDeleteStats] = useState<{ files: number; folders: number } | null>(null)
  const [deleting, setDeleting] = useState(false)

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
      const [companyRes, departmentsRes] = await Promise.all([
        companiesApi.get(id),
        departmentsApi.list(id, true),
      ])
      setCompany(companyRes.data)
      setDepartments(departmentsRes.data as Department[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const openCreateModal = () => {
    setEditingDept(null)
    setFormData({
      name: '',
      nameEn: '',
      folder: '',
      icon: 'Folder',
      color: '#6366f1',
      description: '',
    })
    setShowModal(true)
  }

  const openEditModal = (dept: Department) => {
    setEditingDept(dept)
    setFormData({
      name: dept.name,
      nameEn: dept.nameEn || '',
      folder: dept.folder,
      icon: dept.icon,
      color: dept.color,
      description: dept.description || '',
    })
    setShowModal(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)

    try {
      if (editingDept) {
        const updateData: UpdateDepartmentInput = {
          name: formData.name,
          nameEn: formData.nameEn || null,
          folder: formData.folder,
          icon: formData.icon,
          color: formData.color,
          description: formData.description || null,
        }
        await departmentsApi.update(id, editingDept.id, updateData)
      } else {
        await departmentsApi.create(id, formData)
      }
      setShowModal(false)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save department')
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteClick = async (dept: Department) => {
    // Skip stats for virtual departments (not yet in DB)
    if (dept.id.startsWith('virtual-')) {
      setDeleteTarget(dept)
      setDeleteStats({ files: 0, folders: 0 })
      return
    }

    try {
      const statsRes = await departmentsApi.stats(id, dept.id)
      setDeleteTarget(dept)
      setDeleteStats(statsRes.data)
    } catch (err) {
      // If stats fail, still allow delete with warning
      setDeleteTarget(dept)
      setDeleteStats({ files: 0, folders: 0 })
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await departmentsApi.delete(id, deleteTarget.id)
      setDeleteTarget(null)
      setDeleteStats(null)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete department')
    } finally {
      setDeleting(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const result = await departmentsApi.sync(id)
      loadData()
      if (result.added > 0 || result.removed > 0) {
        alert(`同期完了: ${result.added}件追加、${result.removed}件削除`)
      } else {
        alert('変更はありませんでした')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync departments')
    } finally {
      setSyncing(false)
    }
  }

  const handleMoveUp = async (index: number) => {
    if (index === 0) return
    const items = departments
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((d, i) => ({ id: d.id, sortOrder: i }))

    // Swap
    const temp = items[index].sortOrder
    items[index].sortOrder = items[index - 1].sortOrder
    items[index - 1].sortOrder = temp

    try {
      await departmentsApi.reorder(id, items)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  const handleMoveDown = async (index: number) => {
    const sorted = departments.sort((a, b) => a.sortOrder - b.sortOrder)
    if (index === sorted.length - 1) return

    const items = sorted.map((d, i) => ({ id: d.id, sortOrder: i }))

    // Swap
    const temp = items[index].sortOrder
    items[index].sortOrder = items[index + 1].sortOrder
    items[index + 1].sortOrder = temp

    try {
      await departmentsApi.reorder(id, items)
      loadData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  // Validate folder name (ASCII only)
  const isValidFolder = (folder: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(folder)

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <div className="text-zinc-400">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center h-16 gap-4">
            <Link href={`/companies/${id}`} className="text-zinc-400 hover:text-white transition-colors">
              ← 会社詳細に戻る
            </Link>
            <h1 className="text-xl font-bold text-white">
              {company?.name} - 部署管理
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">閉じる</button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-zinc-400">Loading...</div>
        ) : (
          <div className="space-y-6">
            {/* Actions */}
            <div className="flex justify-between items-center">
              <p className="text-zinc-400 text-sm">
                {departments.length} 部署
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-700/50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {syncing ? '同期中...' : 'フォルダと同期'}
                </button>
                <button
                  onClick={openCreateModal}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  部署を追加
                </button>
              </div>
            </div>

            {/* Departments List */}
            <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
              {departments.length === 0 ? (
                <div className="p-8 text-center text-zinc-500">
                  部署がありません。「デフォルト部署で初期化」または「部署を追加」してください。
                </div>
              ) : (
                <div className="divide-y divide-zinc-800">
                  {departments
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((dept, index) => (
                    <div
                      key={dept.id}
                      className="flex items-center gap-4 p-4 hover:bg-zinc-800/30 transition-colors"
                    >
                      {/* Reorder buttons */}
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => handleMoveUp(index)}
                          disabled={index === 0}
                          className="text-zinc-500 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-500"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => handleMoveDown(index)}
                          disabled={index === departments.length - 1}
                          className="text-zinc-500 hover:text-white disabled:opacity-30 disabled:hover:text-zinc-500"
                        >
                          ▼
                        </button>
                      </div>

                      {/* Icon */}
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-medium"
                        style={{ backgroundColor: dept.color }}
                      >
                        {(() => {
                          const IconComponent = IconMap[dept.icon]
                          return IconComponent ? <IconComponent size={20} /> : dept.name.charAt(0)
                        })()}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{dept.name}</span>
                          {!dept.isActive && (
                            <span className="text-xs bg-zinc-700 text-zinc-400 px-2 py-0.5 rounded">無効</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm text-zinc-500">
                          {dept.nameEn && <span>{dept.nameEn}</span>}
                          <span className="font-mono">{dept.folder}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => openEditModal(dept)}
                          className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg transition-colors"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => handleDeleteClick(dept)}
                          className="px-3 py-1.5 text-red-400 hover:text-red-300 text-sm transition-colors"
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal */}
        {showModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md mx-4">
              <h3 className="text-lg font-semibold text-white mb-4">
                {editingDept ? '部署を編集' : '部署を追加'}
              </h3>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm text-zinc-400 mb-1">部署名 *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="営業部"
                  />
                </div>

                <div>
                  <label className="block text-sm text-zinc-400 mb-1">英語名</label>
                  <input
                    type="text"
                    value={formData.nameEn}
                    onChange={(e) => setFormData({ ...formData, nameEn: e.target.value })}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Sales"
                  />
                </div>

                <div>
                  <label className="block text-sm text-zinc-400 mb-1">フォルダ名 * (ASCII英数字のみ)</label>
                  <input
                    type="text"
                    value={formData.folder}
                    onChange={(e) => setFormData({ ...formData, folder: e.target.value })}
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                    className={`w-full px-3 py-2 bg-zinc-800 border rounded-lg text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                      formData.folder && !isValidFolder(formData.folder) ? 'border-red-500' : 'border-zinc-700'
                    }`}
                    placeholder="sales"
                  />
                  {formData.folder && !isValidFolder(formData.folder) && (
                    <p className="text-red-400 text-xs mt-1">英数字で始まり、英数字・ドット・アンダースコア・ハイフンのみ使用可能</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm text-zinc-400 mb-1">アイコン</label>
                  <div className="flex flex-wrap gap-2">
                    {ICON_OPTIONS.map((iconName) => {
                      const IconComponent = IconMap[iconName]
                      return (
                        <button
                          key={iconName}
                          type="button"
                          onClick={() => setFormData({ ...formData, icon: iconName })}
                          className={`w-10 h-10 rounded-lg bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-zinc-300 transition-all ${
                            formData.icon === iconName ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-zinc-900 bg-zinc-700' : ''
                          }`}
                          title={iconName}
                        >
                          {IconComponent && <IconComponent size={20} />}
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-zinc-400 mb-1">カラー</label>
                  <div className="flex flex-wrap gap-2">
                    {COLOR_OPTIONS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setFormData({ ...formData, color })}
                        className={`w-8 h-8 rounded-lg transition-transform ${
                          formData.color === color ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : ''
                        }`}
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm text-zinc-400 mb-1">説明</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder="部署の説明..."
                  />
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={saving || !!(formData.folder && !isValidFolder(formData.folder))}
                    className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 text-white font-medium rounded-lg transition-colors"
                  >
                    {saving ? '保存中...' : editingDept ? '更新' : '作成'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deleteTarget && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md mx-4">
              <h3 className="text-lg font-semibold text-white mb-4">
                部署を削除
              </h3>

              <div className="mb-6">
                <p className="text-zinc-300 mb-4">
                  「<span className="font-medium text-white">{deleteTarget.name}</span>」を削除しますか？
                </p>

                {deleteStats && (deleteStats.files > 0 || deleteStats.folders > 0) ? (
                  <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-red-400 font-medium mb-2">
                      ⚠️ 警告: この操作は取り消せません
                    </p>
                    <p className="text-red-300 text-sm">
                      以下が完全に削除されます:
                    </p>
                    <ul className="text-red-300 text-sm mt-2 list-disc list-inside">
                      {deleteStats.files > 0 && (
                        <li>{deleteStats.files} 個のファイル</li>
                      )}
                      {deleteStats.folders > 0 && (
                        <li>{deleteStats.folders} 個のサブフォルダ</li>
                      )}
                    </ul>
                  </div>
                ) : (
                  <p className="text-zinc-500 text-sm">
                    フォルダは空です。安全に削除できます。
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                  className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-red-600/50 text-white font-medium rounded-lg transition-colors"
                >
                  {deleting ? '削除中...' : '削除する'}
                </button>
                <button
                  onClick={() => {
                    setDeleteTarget(null)
                    setDeleteStats(null)
                  }}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

import { useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { Buildings, SignOut, CaretDown } from '@phosphor-icons/react'

export function TitleBar() {
  const { currentCompany, setCurrentCompany } = useAppStore()
  const { user, signOut } = useAuthStore()
  const [showMenu, setShowMenu] = useState(false)

  async function handleLogout() {
    await signOut()
  }

  function handleSwitchCompany() {
    setCurrentCompany(null)
    setShowMenu(false)
  }

  return (
    <div className="h-9 bg-activitybar-bg flex items-center justify-between px-4 border-b border-border drag-region">
      <div className="flex items-center gap-2 no-drag">
        <div className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 cursor-pointer" />
        <div className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 cursor-pointer" />
        <div className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 cursor-pointer" />
      </div>

      <div className="flex items-center gap-2 text-text-secondary text-sm">
        <Buildings size={16} className="text-accent" />
        {currentCompany?.name || 'AI Company Builder'}
      </div>

      <div className="relative no-drag">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-white/5"
        >
          {user?.name || user?.email?.split('@')[0]}
          <CaretDown size={12} />
        </button>

        {showMenu && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setShowMenu(false)}
            />
            <div className="absolute right-0 top-full mt-1 w-48 bg-sidebar-bg border border-border rounded-lg shadow-lg z-20 overflow-hidden">
              <button
                onClick={handleSwitchCompany}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 text-left"
              >
                <Buildings size={16} />
                会社を切り替え
              </button>
              <div className="h-px bg-border" />
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-white/5 text-left"
              >
                <SignOut size={16} />
                ログアウト
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

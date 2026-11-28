// The settings' left list: the groups of sections.ts, with 詳しい設定 folded until opened (or until one of
// its sections is the one shown). Only today's panel draws it; a frame with tabs (段5) lists the same data.
import { useState, type ReactNode } from 'react'
import {
  ArrowsClockwise, CalendarCheck, CaretDown, CaretRight, CloudArrowDown, FileX, GoogleLogo, Globe, Key,
  LockKey, Microphone, PlugsConnected, Robot, ShieldCheck, SlackLogo, UserSwitch, Wrench,
} from '@phosphor-icons/react'
import { groupOf, type SettingsGroup, type SettingsSectionId } from '../sections'

const ICONS: Record<SettingsSectionId, ReactNode> = {
  mine: <Robot size={16} />,
  jobs: <CalendarCheck size={16} />,
  input: <Microphone size={16} />,
  tools: <PlugsConnected size={16} />,
  google: <GoogleLogo size={16} />,
  slack: <SlackLogo size={16} />,
  browser: <Globe size={16} />,
  ownkeys: <LockKey size={16} />,
  absences: <UserSwitch size={16} />,
  sync: <CloudArrowDown size={16} />,
  autosync: <ArrowsClockwise size={16} />,
  gitignore: <FileX size={16} />,
  envkeys: <Key size={16} />,
  aienv: <ShieldCheck size={16} />,
}

/** Sections shown one step in under サービスの一覧 (each service's own page). */
const UNDER_LIST: ReadonlySet<SettingsSectionId> = new Set(['google', 'slack', 'browser', 'ownkeys'])

interface Props {
  groups: SettingsGroup[]
  active: SettingsSectionId
  /** Sections with a draft not saved yet (marked 未保存). */
  unsavedIds: ReadonlySet<SettingsSectionId>
  onChoose: (id: SettingsSectionId) => void
}

export function SettingsNav({ groups, active, unsavedIds, onChoose }: Props) {
  const activeGroup = groupOf(active)
  // Opened by the member, or because the settings opened on one of its sections: stays open after.
  const [openedFolded, setOpenedFolded] = useState(() => groups.some(group => group.folded && group.id === activeGroup))
  return (
    <div className="min-h-0 space-y-5 overflow-y-auto">
      {groups.map(group => {
        const open = !group.folded || openedFolded || activeGroup === group.id || group.items.some(item => unsavedIds.has(item.id))
        return (
          <div key={group.id}>
            {group.folded ? (
              <button type="button" aria-expanded={open} onClick={() => setOpenedFolded(!open)}
                className="flex w-full items-center gap-1 rounded-control px-2.5 pb-1.5 text-left text-caption text-text-subtle hover:text-text focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring">
                {open ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}
                {group.label}
                <Wrench size={13} className="ml-auto" aria-hidden />
              </button>
            ) : (
              <p className="px-2.5 pb-1.5 text-caption text-text-subtle">{group.label}</p>
            )}
            {open && (
              <ul className="space-y-0.5">
                {group.items.map(item => {
                  const chosen = active === item.id
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={chosen ? 'page' : undefined}
                        onClick={() => { if (!chosen) onChoose(item.id) }}
                        className={`flex h-control w-full items-center gap-2.5 rounded-control px-2.5 text-left text-body transition-colors duration-fast focus-visible:outline-none focus-visible:ring-focus focus-visible:ring-focus-ring ${UNDER_LIST.has(item.id) ? 'pl-6' : ''} ${chosen
                          ? 'bg-surface-raised font-medium text-text shadow-card ring-1 ring-[color:var(--color-border)]'
                          : 'text-text-muted hover:bg-surface-sunken hover:text-text'}`}
                      >
                        <span className={chosen ? 'text-selected-icon' : 'text-text-subtle'}>{ICONS[item.id]}</span>
                        {item.label}
                        {unsavedIds.has(item.id) && <span className="ml-auto text-caption font-normal text-warning-text">未保存</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

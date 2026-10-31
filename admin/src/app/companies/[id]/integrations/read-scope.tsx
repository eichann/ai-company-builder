'use client'

// 「中継で読める人」 of one connection (owner decision 2026-10-31, `.claude/rules/plugins.md`
// "The relay and a managed connection"): departments (people who can read the department's
// folder) and members who — with their AI — may read the outside system through the key
// broker's relay. Nobody chosen = nobody reads; the server refuses turning on without it.
import { useState } from 'react'
import { UsersThree } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import type { Department, Member, PluginReadScopeView } from '@/lib/api'

export function ReadScopeSection({ system, scope, departments, members, enabled, busy, onSave }: {
  system: string
  scope: PluginReadScopeView
  departments: Department[]
  members: Member[]
  enabled: boolean
  busy: boolean
  onSave: (scope: PluginReadScopeView) => void
}) {
  const [departmentIds, setDepartmentIds] = useState<string[]>(scope.departmentIds)
  const [userIds, setUserIds] = useState<string[]>(scope.userIds)
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id))
  const empty = departmentIds.length + userIds.length === 0
  const changed = JSON.stringify([...departmentIds].sort()) !== JSON.stringify([...scope.departmentIds].sort())
    || JSON.stringify([...userIds].sort()) !== JSON.stringify([...scope.userIds].sort())

  return (
    <section className="space-y-3" aria-label={`${system} を読める人`}>
      <h3 className="flex items-center gap-2 text-sm font-medium"><UsersThree size={14} />{system} を読める人</h3>
      <p className="text-xs text-muted-foreground">
        ここで選んだ部署（その部署のフォルダを読める人）とメンバー、その人たちの AI だけが、スキルなどから {system} の中身
        （取引・会社・連絡先など）を読めます。選ばれていない人とその AI は読めません。ここから {system} を書き換えることはできません。
        誰も選ばないと誰も読めず、オンにもできません。
      </p>
      {scope.departmentIds.length + scope.userIds.length === 0 && (
        <p role="status" className="text-sm text-warning">まだ誰も選ばれていません（いまは誰も読めません）。</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">部署</legend>
          {departments.length === 0 && <p className="text-xs text-muted-foreground">部署がありません</p>}
          {departments.map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={departmentIds.includes(d.id)} onChange={(e) => toggle(departmentIds, setDepartmentIds, d.id, e.target.checked)} />
              {d.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">メンバー</legend>
          {members.map((m) => (
            <label key={m.userId} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={userIds.includes(m.userId)} onChange={(e) => toggle(userIds, setUserIds, m.userId, e.target.checked)} />
              {m.name || m.email || '（メンバー）'}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy || !changed || (enabled && empty)} onClick={() => onSave({ departmentIds, userIds })}>読める人を保存</Button>
        {enabled && empty && <span className="text-xs text-muted-foreground">オンの間は空にできません（先にオフにしてください）</span>}
      </div>
    </section>
  )
}

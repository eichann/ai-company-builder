'use client'

// 「役割」 of one business (plan C3, `.claude/rules/plugin-roles.md`): the roles the business
// declares (e.g. 営業の責任者) and who holds each in this company — the default the FDE sets up.
// A まとまり (a 案件) may have its own holders, set from the app; they are listed here read only.
// Nobody chosen = nobody holds it: an approval for the role then goes to an owner / admin.
// The server decides every rule (members of this company only, owner / admin only).
import { useState } from 'react'
import { toast } from 'sonner'
import { IdentificationBadge } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { pluginsApi, type Member, type PluginRolesView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useQuery } from '@/lib/use-query'

export function RolesSection({ pluginId, members, nameOf }: {
  pluginId: string
  members: Member[]
  nameOf: (id: string) => string
}) {
  const { companyId } = useCompany()
  const roles = useQuery(`plugin-roles:${companyId}:${pluginId}`, () => pluginsApi.roles(companyId, pluginId))
  const view = roles.data
  if (!view || view.roles.length === 0) return null
  return (
    <section className="space-y-3" aria-label="役割">
      <h3 className="flex items-center gap-2 text-sm font-medium"><IdentificationBadge size={14} />役割</h3>
      <p className="text-xs text-muted-foreground">
        この業務で決まった仕事をする人（承認する人など）を、役割ごとに選びます。案件ごとに別の人にしたいときは、アプリの案件から変えられます。
        誰も選ばないと、その役割の承認は管理者にお願いが届きます。本人・部署の責任者・管理者は最初から決まっています。
      </p>
      {view.roles.map((r) => (
        <RoleHolders key={`${r.name}:${r.userIds.join(',')}`} pluginId={pluginId} role={r} members={members}
          onSaved={(next) => roles.setData(() => next)} />
      ))}
      {view.overrides.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs text-muted-foreground">案件ごとに変えているもの</h4>
          <ul className="space-y-0.5 text-sm">
            {view.overrides.map((o) => (
              <li key={`${o.role}:${o.bundleId}`}>
                {o.title ?? '（見られない案件）'}：{labelOf(view, o.role)} = {o.userIds.map(nameOf).join('、') || '（なし）'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.history.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>変えた記録</summary>
          <ul className="mt-1 space-y-0.5">
            {view.history.map((h, i) => (
              <li key={i}>
                {formatDateTime(h.at)} {nameOf(h.by)}：{labelOf(view, h.role)}{h.bundleId ? '（案件ごと）' : ''}
                {h.action === 'clear-override' ? ' を会社の設定に戻しました' : ` = ${h.userIds.map(nameOf).join('、') || '（なし）'}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

const labelOf = (view: PluginRolesView, role: string) => view.roles.find((r) => r.name === role)?.label ?? role

function RoleHolders({ pluginId, role, members, onSaved }: {
  pluginId: string
  role: PluginRolesView['roles'][number]
  members: Member[]
  onSaved: (view: PluginRolesView) => void
}) {
  const { companyId } = useCompany()
  const [userIds, setUserIds] = useState<string[]>(role.userIds)
  const [busy, setBusy] = useState(false)
  const changed = JSON.stringify([...userIds].sort()) !== JSON.stringify([...role.userIds].sort())
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await pluginsApi.assignRole(companyId, pluginId, role.name, userIds))
      toast.success(`「${role.label}」を保存しました`)
    } catch (err) {
      toast.error('保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="space-y-1 rounded-md border p-3" aria-label={role.label}>
      <legend className="px-1 text-sm">{role.label}</legend>
      {role.description && <p className="text-xs text-muted-foreground">{role.description}</p>}
      {role.userIds.length === 0 && <p role="status" className="text-xs text-warning">まだ誰も選ばれていません。</p>}
      <div className="grid gap-1 sm:grid-cols-2">
        {members.map((m) => (
          <label key={m.userId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={userIds.includes(m.userId)}
              onChange={(e) => setUserIds(e.target.checked ? [...userIds, m.userId] : userIds.filter((x) => x !== m.userId))} />
            {m.name || m.email || '（メンバー）'}
          </label>
        ))}
      </div>
      <Button size="sm" disabled={busy || !changed} onClick={save}>保存</Button>
    </fieldset>
  )
}

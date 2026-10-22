'use client'

import { useId, useState } from 'react'
import { Check, LockSimple, Plus, X } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Member } from '@/lib/api'
import { isAdminRole } from '@/lib/format'
import { MANAGERS_MAY_CHANGE_VIEWERS } from '@/lib/private-folder-help'
import { audienceCounts, type Audience } from '@/lib/private-folders'
import { cn } from '@/lib/utils'

const nameOf = (m: Member | undefined, id: string) => m?.name || m?.email || (m ? '名前未設定' : id)

/**
 * 見られる人 / 編集できる人 of a private folder, plus the summary line
 * 「このフォルダとその中身は N 人にだけ届きます」. Owners and admins are
 * never listed: they always see and edit everything (said under the list).
 */
export function AudienceFields({
  members,
  managerIds,
  value,
  onChange,
  disabled,
  lockedViewerId,
  meId,
  inDepartment,
}: {
  members: Member[]
  managerIds: string[]
  value: Audience
  onChange: (next: Audience) => void
  disabled?: boolean
  /** A viewer who cannot be removed (the creator: the server always adds them). */
  lockedViewerId?: string | null
  meId?: string | null
  /** The folder is inside a department, whose managers may change the viewers (and add themselves). */
  inDepartment?: boolean
}) {
  const byId = new Map(members.map((m) => [m.userId, m]))
  const managers = new Set(managerIds)
  const counts = audienceCounts(value, members)
  const editorsGroup = useId()

  const toggleViewer = (id: string) => {
    const has = value.viewers.includes(id)
    const viewers = has ? value.viewers.filter((v) => v !== id) : [...value.viewers, id]
    onChange({ ...value, viewers, editors: value.editors.filter((e) => viewers.includes(e)) })
  }
  const toggleEditor = (id: string) =>
    onChange({ ...value, editors: value.editors.includes(id) ? value.editors.filter((e) => e !== id) : [...value.editors, id] })

  const label = (id: string) => {
    const m = byId.get(id)
    return id === meId ? `${nameOf(m, id)}（あなた）` : nameOf(m, id)
  }

  return (
    <div className="grid gap-5">
      <fieldset disabled={disabled} className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">見られる人</legend>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="見られる人">
          {value.viewers.map((id) => (
            <li key={id} className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background pr-1 pl-1 text-sm">
              <Avatar name={nameOf(byId.get(id), id)} seed={id} className="size-5 text-[9px]" />
              <span className="max-w-44 truncate">{label(id)}</span>
              {managers.has(id) && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">責任者</span>}
              {id === lockedViewerId ? (
                <span className="w-1" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggleViewer(id)}
                  aria-label={`${label(id)}を外す`}
                  className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <X size={12} weight="bold" />
                </button>
              )}
            </li>
          ))}
          <li>
            <MemberPicker members={members} chosen={value.viewers} managerIds={managerIds} onToggle={toggleViewer} disabled={disabled} />
          </li>
        </ul>
        <p className="text-xs text-muted-foreground">
          {counts.admins > 0 ? `オーナー・管理者（${counts.admins}人）は常に見られます。` : 'オーナーと管理者は常に見られます。'}
          {inDepartment && MANAGERS_MAY_CHANGE_VIEWERS}
          選ばれていない人には、フォルダの名前も表示されません。
        </p>
      </fieldset>

      <fieldset disabled={disabled} className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">編集できる人</legend>
        <Choice
          name={editorsGroup}
          checked={value.editorsMode === 'all'}
          onSelect={() => onChange({ ...value, editorsMode: 'all' })}
          title="見られる人全員"
          detail="見られる人は、だれでも中のファイルを変更できます"
        />
        <div className={cn('rounded-lg border transition-colors', value.editorsMode === 'specific' && 'border-brand/50 bg-brand/5')}>
          <Choice
            name={editorsGroup}
            checked={value.editorsMode === 'specific'}
            onSelect={() => onChange({ ...value, editorsMode: 'specific', editors: value.editors.length ? value.editors : value.viewers })}
            title="指定した人だけ"
            detail="ほかの見られる人は閲覧のみになります"
            bare
          />
          {value.editorsMode === 'specific' && (
            <div className="grid gap-1 px-3 pb-3 pl-10">
              {value.viewers.length === 0 ? (
                <p className="text-xs text-muted-foreground">先に見られる人を選んでください。</p>
              ) : (
                <ul className="grid gap-1 sm:grid-cols-2" aria-label="編集できる人">
                  {value.viewers.map((id) => (
                    <li key={id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent/60">
                        <input
                          type="checkbox"
                          checked={value.editors.includes(id)}
                          onChange={() => toggleEditor(id)}
                          className="size-4 shrink-0 accent-brand"
                        />
                        <span className="truncate">{label(id)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">オーナーと管理者は常に編集できます。</p>
            </div>
          )}
        </div>
      </fieldset>

      <AudienceSummary viewers={counts.viewers} editors={counts.editors} />
    </div>
  )
}

export function AudienceSummary({ viewers, editors }: { viewers: number; editors: number }) {
  return (
    <div className="flex gap-3 rounded-lg border border-brand/25 bg-brand/5 px-3.5 py-3" role="status" aria-live="polite">
      <LockSimple size={18} weight="fill" className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium">
          このフォルダとその中身は <span className="tabular-nums">{viewers}</span> 人にだけ届きます
        </p>
        <p className="text-xs text-muted-foreground">
          {editors === viewers ? '全員が中のファイルを編集できます。' : `編集できるのは ${editors} 人です。`}
          ほかの人の手元には、名前も中身も届きません。
        </p>
      </div>
    </div>
  )
}

function Choice({
  name,
  checked,
  onSelect,
  title,
  detail,
  bare = false,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  title: string
  detail: string
  bare?: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2.5 has-[:disabled]:cursor-default',
        !bare && 'rounded-lg border transition-colors',
        !bare && checked && 'border-brand/50 bg-brand/5'
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 size-4 shrink-0 accent-brand outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}

/** Searchable member list; picking toggles and keeps it open. Owners/admins are not offered. */
function MemberPicker({
  members,
  chosen,
  managerIds,
  onToggle,
  disabled,
}: {
  members: Member[]
  chosen: string[]
  managerIds: string[]
  onToggle: (userId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const managers = new Set(managerIds)
  const candidates = members
    .filter((m) => !isAdminRole(m.role))
    .sort((a, b) => Number(managers.has(b.userId)) - Number(managers.has(a.userId)) || (a.name ?? '').localeCompare(b.name ?? '', 'ja'))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className="h-7 rounded-full">
          <Plus />
          追加
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <Command loop>
          <CommandInput placeholder="名前・メールで検索" aria-label="見られる人を検索" />
          <CommandList className="max-h-72" aria-label="見られる人の候補">
            <CommandEmpty>{candidates.length === 0 ? '選べるメンバーがいません' : '該当する人がいません'}</CommandEmpty>
            <CommandGroup heading="メンバー">
              {candidates.map((m) => {
                const name = m.name || m.email || '名前未設定'
                const on = chosen.includes(m.userId)
                return (
                  <CommandItem
                    key={m.userId}
                    value={`${name} ${m.email ?? ''} ${m.userId}`}
                    onSelect={() => onToggle(m.userId)}
                    data-chosen={on || undefined}
                    className="gap-2.5"
                  >
                    <Avatar name={name} seed={m.userId} className="size-6 text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{name}</span>
                        {managers.has(m.userId) && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">責任者</span>
                        )}
                      </span>
                      {m.email && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                    </span>
                    <Check size={16} weight="bold" className={on ? 'ml-auto text-brand' : 'ml-auto opacity-0'} aria-hidden="true" />
                    <span className="sr-only">{on ? '（選択中）' : ''}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

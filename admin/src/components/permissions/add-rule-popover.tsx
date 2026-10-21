'use client'

import { useState } from 'react'
import { Plus, UserCircle, UsersThree } from '@phosphor-icons/react'

import { AccessToggle } from '@/components/permissions/access-toggle'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Member, PermissionRule, RuleSubject } from '@/lib/api'
import { isAdminRole } from '@/lib/format'

export function subjectKey(s: { subjectType: string; subjectId: string | null }): string {
  return `${s.subjectType}:${s.subjectId ?? ''}`
}

/**
 * Pick who a new rule is for (全員 / 役割「メンバー」 / one member, searchable)
 * and whether they may edit. Owners and admins are not offered: they can
 * always edit, so the server refuses rules for them.
 */
export function AddRulePopover({
  members,
  existing,
  disabled,
  onAdd,
}: {
  members: Member[]
  /** Rules the scope has (own or inherited), to mark subjects already set. */
  existing: PermissionRule[]
  disabled?: boolean
  onAdd: (subject: RuleSubject, canWrite: boolean, label: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [canWrite, setCanWrite] = useState(true)
  const [busy, setBusy] = useState(false)
  const set = new Set(existing.map(subjectKey))
  const candidates = members.filter((m) => !isAdminRole(m.role))
  const hiddenAdmins = members.length - candidates.length

  const pick = async (subject: RuleSubject, label: string) => {
    setBusy(true)
    try {
      await onAdd(subject, canWrite, label)
      setOpen(false)
    } catch {
      // The caller's toast explains; keep the picker open to try again.
    } finally {
      setBusy(false)
    }
  }

  const mark = (key: string) => (set.has(key) ? <span className="ml-auto text-xs text-muted-foreground">設定済み・上書き</span> : null)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setCanWrite(true)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Plus />
          ルールを追加
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5">
          <span className="text-xs font-medium text-muted-foreground">付ける権限</span>
          <AccessToggle canWrite={canWrite} onChange={setCanWrite} label="追加するルールの権限" size="sm" />
        </div>
        <Command loop>
          <CommandInput placeholder="対象を検索（名前・メール）" aria-label="ルールの対象を検索" />
          <CommandList className="max-h-72">
            <CommandEmpty>該当する対象がありません</CommandEmpty>
            <CommandGroup heading="まとめて">
              <CommandItem value="全員 everyone" disabled={busy} onSelect={() => pick({ subjectType: 'everyone', subjectId: null }, '全員')}>
                <UsersThree size={18} className="text-muted-foreground" />
                <span>全員</span>
                {mark('everyone:')}
              </CommandItem>
              <CommandItem
                value="役割 メンバー role member"
                disabled={busy}
                onSelect={() => pick({ subjectType: 'role', subjectId: 'member' }, '役割「メンバー」')}
              >
                <UserCircle size={18} className="text-muted-foreground" />
                <span>役割が「メンバー」の人</span>
                {mark('role:member')}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="メンバー">
              {candidates.map((m) => {
                const name = m.name || m.email || '名前未設定'
                return (
                  <CommandItem
                    key={m.userId}
                    value={`${name} ${m.email ?? ''} ${m.userId}`}
                    disabled={busy}
                    onSelect={() => pick({ subjectType: 'user', subjectId: m.userId }, name)}
                    className="gap-2.5"
                  >
                    <Avatar name={name} seed={m.userId} className="size-6 text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{name}</span>
                      {m.email && <span className="block truncate text-xs text-muted-foreground">{m.email}</span>}
                    </span>
                    {mark(`user:${m.userId}`)}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {hiddenAdmins > 0 && (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            オーナー・管理者（{hiddenAdmins}人）は常に編集できるため、ここには表示していません。
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

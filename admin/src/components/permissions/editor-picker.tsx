'use client'

import { useState } from 'react'
import { Check, Plus, UserCircle } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Member } from '@/lib/api'
import { editorKey, ROLE_MEMBER_EDITOR, type Editor } from '@/lib/edit-access'
import { isAdminRole } from '@/lib/format'

/**
 * Add (or remove) people who may edit under 指定した人だけ: the メンバー role
 * or individual members, searchable. Picking toggles and keeps the list open
 * so several can be chosen in a row. Owners and admins are not offered — they
 * can always edit. Managers of the department are marked 「責任者」 so they
 * are easy to find (being a manager grants no file access by itself).
 */
export function EditorPicker({
  members,
  chosen,
  managerIds,
  disabled,
  onToggle,
}: {
  members: Member[]
  chosen: Editor[]
  managerIds: string[]
  disabled?: boolean
  onToggle: (editor: Editor) => void
}) {
  const [open, setOpen] = useState(false)
  const keys = new Set(chosen.map(editorKey))
  const candidates = members.filter((m) => !isAdminRole(m.role))
  const hiddenAdmins = members.length - candidates.length
  const managers = new Set(managerIds)
  // Managers first, then by name.
  const sorted = [...candidates].sort(
    (a, b) => Number(managers.has(b.userId)) - Number(managers.has(a.userId)) || (a.name ?? '').localeCompare(b.name ?? '', 'ja')
  )

  const check = (on: boolean) => (
    <Check size={16} weight="bold" className={on ? 'ml-auto text-brand' : 'ml-auto opacity-0'} aria-hidden="true" />
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="h-7 rounded-full">
          <Plus />
          追加
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <Command loop>
          <CommandInput placeholder="名前・メールで検索" aria-label="編集できる人を検索" />
          <CommandList className="max-h-72" aria-label="編集できる人の候補">
            <CommandEmpty>該当する人がいません</CommandEmpty>
            <CommandGroup heading="役割">
              <CommandItem
                value="役割 メンバー role member"
                onSelect={() => onToggle(ROLE_MEMBER_EDITOR)}
                data-chosen={keys.has(editorKey(ROLE_MEMBER_EDITOR)) || undefined}
              >
                <UserCircle size={18} className="text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block">役割「メンバー」</span>
                  <span className="block text-xs text-muted-foreground">役割がメンバーの人全員（いまは{candidates.length}人）</span>
                </span>
                {check(keys.has(editorKey(ROLE_MEMBER_EDITOR)))}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="メンバー">
              {sorted.map((m) => {
                const name = m.name || m.email || '名前未設定'
                const editor: Editor = { subjectType: 'user', subjectId: m.userId }
                const on = keys.has(editorKey(editor))
                return (
                  <CommandItem
                    key={m.userId}
                    value={`${name} ${m.email ?? ''} ${m.userId}`}
                    onSelect={() => onToggle(editor)}
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
                    {check(on)}
                    <span className="sr-only">{on ? '（選択中）' : ''}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        {hiddenAdmins > 0 && (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            オーナー・管理者（{hiddenAdmins}人）は常に編集できるため、選ぶ必要はありません。
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

'use client'

import { Check } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import type { Member } from '@/lib/api'
import { roleLabel } from '@/lib/format'
import { cn } from '@/lib/utils'

/** The searchable multi-select of company members (部署の管理役, Skill を直せる人). */
export function MemberChecklist({
  members,
  selected,
  onToggle,
}: {
  members: Member[]
  selected: ReadonlySet<string>
  onToggle: (userId: string) => void
}) {
  return (
    <Command className="border-y" loop>
      <CommandInput placeholder="名前・メールで絞り込む" />
      <CommandList className="max-h-72">
        <CommandEmpty>該当するメンバーがいません</CommandEmpty>
        <CommandGroup>
          {members.map((m) => {
            const name = m.name || m.email || '名前未設定'
            const checked = selected.has(m.userId)
            return (
              <CommandItem
                key={m.userId}
                value={`${name} ${m.email ?? ''} ${m.userId}`}
                onSelect={() => onToggle(m.userId)}
                role="option"
                aria-selected={checked}
                className="gap-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                  )}
                >
                  {checked && <Check size={12} weight="bold" />}
                </span>
                <Avatar name={name} seed={m.userId} className="size-6 text-[10px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                </span>
                <span className="text-xs text-muted-foreground">{roleLabel(m.role)}</span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

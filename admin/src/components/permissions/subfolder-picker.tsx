'use client'

import { useState } from 'react'
import { FolderPlus, Folder } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { permissionsApi } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'

/**
 * Choose a sub-folder of `path` (as it exists on the server) to give its own
 * rules. Folders that already have rules are marked; picking any folder just
 * selects it in the tree — nothing is saved until a rule is changed there.
 */
export function SubfolderPicker({
  companyId,
  path,
  onPick,
}: {
  companyId: string
  path: string
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const folders = useQuery(open ? `perm-folders:${companyId}:${path}` : null, () => permissionsApi.folders(companyId, path))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <FolderPlus />
          中のフォルダを設定
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-2rem))] p-0">
        {folders.loading ? (
          <div className="space-y-2 p-3" aria-busy="true" aria-label="読み込み中">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : folders.error ? (
          <p className="p-3 text-sm text-muted-foreground">{describeError(folders.error)}</p>
        ) : (
          <Command loop>
            <CommandInput placeholder="フォルダを検索" aria-label="フォルダを検索" />
            <CommandList className="max-h-64">
              <CommandEmpty>{folders.data?.folders.length ? '該当するフォルダがありません' : '中にフォルダがありません'}</CommandEmpty>
              <CommandGroup heading="サーバーにあるフォルダ">
                {(folders.data?.folders ?? []).map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.name}
                    onSelect={() => {
                      onPick(f.path)
                      setOpen(false)
                    }}
                  >
                    <Folder size={16} className="text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    {f.hasRules && <span className="text-xs text-muted-foreground">個別ルールあり</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}

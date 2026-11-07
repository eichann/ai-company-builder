'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowLeft, Check, Eye, Plus } from '@phosphor-icons/react'

import { RadioCard } from '@/components/app/radio-card'
import { inheritedFor } from '@/components/permissions/scope-editor'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { groupsApi, permissionsApi, type Department, type Member, type MemberGroup, type PermissionRule, type PermissionScope } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { useCompany } from '@/lib/company-context'
import { isAdminRole } from '@/lib/format'
import {
  parsePlaceName,
  placeName,
  readerKey,
  readersOf,
  rulesForReaders,
  sameReaders,
  type Reader,
  type ReadersDraft,
} from '@/lib/place-readers'
import { isSameOrAncestorPath } from '@/lib/scope-paths'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

/** Said wherever readers are chosen (owners and admins are never chosen: they always read). */
export const OWNERS_ALWAYS_READ = 'オーナーと管理者は、選ばなくてもいつでもすべてを見られます。'

/** What the dialog says a place's 見られる人 are for (plain words: no 権限・スコープ). */
export const READERS_INTRO =
  'ここに置いたやること・決めたこと・会議の記録などを見られる人です。見られない人には、記録も場所の名前も見えません。'

/** Shown to a department manager: who reads is chosen by owners and admins. */
export const READERS_READ_ONLY_NOTE = '見られる人を決められるのはオーナーと管理者だけです。部署の管理役は確認だけできます。'

interface Lookups {
  members: Member[]
  departments: Department[]
  groups: MemberGroup[]
  /** The server's label of each subject in the rules read (a manager gets no group list). */
  labels: Map<string, string>
}

function readerLabel(r: Reader, l: Lookups): string {
  if (r.subjectType === 'department') {
    const name = l.departments.find((d) => d.id === r.subjectId)?.name
    return name ? `${name}に所属する人` : l.labels.get(readerKey(r)) ?? '（削除された部署）'
  }
  if (r.subjectType === 'group') {
    const name = l.groups.find((g) => g.id === r.subjectId)?.name
    return name ? `${name}の人` : l.labels.get(readerKey(r)) ?? '（削除されたまとまり）'
  }
  const m = l.members.find((x) => x.userId === r.subjectId)
  return m ? m.name || m.email || '名前未設定' : l.labels.get(readerKey(r)) ?? 'もういない人'
}

/** One line for a choice: 「全員」「部署と同じ」 or the chosen readers. */
export function readersSummary(draft: ReadersDraft, department: boolean, l: Lookups): string {
  if (draft.mode === 'everyone') return department ? '全員' : '部署と同じ'
  if (draft.readers.length === 0) return 'オーナーと管理者だけ'
  return draft.readers.map((r) => readerLabel(r, l)).join('、')
}

/**
 * What 「部署」 needs for 見られる人: shown in a company without the shared folder to owners/admins
 * (every department) and department managers (their own, read only). `line(d)` is the row's one
 * line, undefined where the caller is not shown it.
 */
export function useDepartmentReaders(companyId: string, members: Member[] | undefined, departments: Department[] | undefined) {
  const { isAdmin, managedDepartmentIds, hasCompanyFolder } = useCompany()
  const shown = !hasCompanyFolder && (isAdmin || managedDepartmentIds.length > 0)
  const permissions = useQuery(shown ? `permissions:${companyId}` : null, () => permissionsApi.get(companyId))
  const groups = useQuery(!hasCompanyFolder && isAdmin ? `groups:${companyId}` : null, () => groupsApi.list(companyId))
  const scopes = permissions.data?.scopes ?? []
  const lookups: Lookups = {
    members: members ?? [],
    departments: departments ?? [],
    groups: groups.data?.groups ?? [],
    labels: new Map(scopes.flatMap((s) => s.rules.map((r) => [readerKey(r), r.subjectLabel] as const))),
  }
  const line = (d: Department): { text: string; restricted: boolean } | undefined => {
    if (!shown || !permissions.data || !(isAdmin || managedDepartmentIds.includes(d.id))) return undefined
    const scope = scopes.find((s) => s.path === d.folder.normalize('NFC'))
    // A manager's answer leaves out a place they cannot read: say only who decides.
    if (!scope && !isAdmin) return { text: 'オーナーと管理者が決めています', restricted: true }
    const draft = readersOf(scope && !scope.inherited ? scope.rules : [])
    return { text: readersSummary(draft, true, lookups), restricted: draft.mode === 'chosen' }
  }
  return { shown, scopes, groups: groups.data?.groups ?? [], line, reload: permissions.reload }
}

/** A place's own rules and what it follows without them. */
function rulesAt(path: string, scopes: PermissionScope[]) {
  const scope = scopes.find((s) => s.path === path)
  const own = scope && !scope.inherited ? scope.rules : []
  return { own, inherited: inheritedFor(path, scope, scopes)?.rules ?? [] }
}

/**
 * 「見られる人」 of a department and the places inside it, for a company without the shared folder
 * (server.md "Groups and read-restricted places"). Owners and admins choose (PUT
 * /permissions/scopes/by-path); a department manager sees it read only.
 */
export function PlaceReadersDialog({
  open,
  onOpenChange,
  companyId,
  department,
  scopes,
  members,
  departments,
  groups,
  editable,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string
  department: Department | null
  scopes: PermissionScope[]
  members: Member[]
  departments: Department[]
  groups: MemberGroup[]
  editable: boolean
  onSaved: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        {open && department && (
          <PlaceReaders
            key={department.id}
            companyId={companyId}
            department={department}
            scopes={scopes}
            members={members}
            departments={departments}
            groups={groups}
            editable={editable}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PlaceReaders({
  companyId,
  department,
  scopes,
  members,
  departments,
  groups,
  editable,
  onSaved,
  onClose,
}: {
  companyId: string
  department: Department
  scopes: PermissionScope[]
  members: Member[]
  departments: Department[]
  groups: MemberGroup[]
  editable: boolean
  onSaved: () => void
  onClose: () => void
}) {
  const folder = department.folder.normalize('NFC')
  // null: the department and the list of places inside it; a path: that place being chosen for.
  const [editing, setEditing] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const lookups = useMemo((): Lookups => {
    const labels = new Map<string, string>()
    for (const s of scopes) for (const r of s.rules) labels.set(readerKey(r), r.subjectLabel)
    return { members, departments, groups, labels }
  }, [scopes, members, departments, groups])

  const places = scopes
    .filter((s) => s.path !== folder && isSameOrAncestorPath(folder, s.path) && !s.inherited)
    .map((s) => s.path)
  const departmentRules = rulesAt(folder, scopes)
  const departmentDraft = readersOf(departmentRules.own)

  if (editing !== null) {
    const isDepartment = editing === folder
    const { own, inherited } = rulesAt(editing, scopes)
    return (
      <ReadersEditor
        companyId={companyId}
        path={editing}
        isDepartment={isDepartment}
        departmentName={department.name}
        departmentRestricted={departmentDraft.mode === 'chosen'}
        own={own}
        inherited={inherited}
        lookups={lookups}
        onBack={() => setEditing(null)}
        onSaved={() => {
          onSaved()
          setEditing(null)
        }}
      />
    )
  }

  const newPlace = parsePlaceName(newName)
  const newPath = newPlace ? `${folder}/${newPlace}` : null
  const taken = newPath !== null && places.some((p) => p.normalize('NFC') === newPath)

  return (
    <>
      <DialogHeader className="border-b px-6 pt-6 pb-4">
        <DialogTitle>「{department.name}」を見られる人</DialogTitle>
        <DialogDescription>{READERS_INTRO}</DialogDescription>
      </DialogHeader>
      <div className="space-y-5 px-6 py-5">
        <section className="space-y-2" aria-label={`${department.name}を見られる人`}>
          <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
            <Eye size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              <div>
                <span className="font-medium">見られる人：</span>
                {readersSummary(departmentDraft, true, lookups)}
              </div>
              <p className="text-xs text-muted-foreground">{OWNERS_ALWAYS_READ}</p>
            </div>
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setEditing(folder)}>
                変える
              </Button>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">部署の中の場所</h3>
          <p className="text-xs text-muted-foreground">
            部署の中に、見られる人をさらに絞った場所を作れます（例：{department.name} › 採用）。部署を見られない人は、中の場所も見られません。
          </p>
          {places.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだありません。</p>
          ) : (
            <ul className="divide-y rounded-lg border" aria-label="部署の中の場所">
              {places.map((p) => (
                <li key={p} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{placeName(p)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      見られる人：{readersSummary(readersOf(rulesAt(p, scopes).own), false, lookups)}
                    </p>
                  </div>
                  {editable && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)} aria-label={`${placeName(p)} を見られる人を変える`}>
                      変える
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {editable && (
            <div className="space-y-1.5 pt-1">
              <Label htmlFor="new-place">場所を作る</Label>
              <div className="flex gap-2">
                <Input
                  id="new-place"
                  value={newName}
                  maxLength={40}
                  placeholder="例：採用"
                  onChange={(e) => setNewName(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!newPath || taken}
                  onClick={() => {
                    if (!newPath) return
                    setEditing(newPath)
                    setNewName('')
                  }}
                >
                  <Plus />
                  作って見られる人を選ぶ
                </Button>
              </div>
              {newName.trim() !== '' && !newPlace && (
                <p className="text-xs text-destructive">名前は1〜40文字で、「/」や「.」で始まる名前は使えません。</p>
              )}
              {taken && <p className="text-xs text-destructive">同じ名前の場所がもうあります。</p>}
            </div>
          )}
        </section>
        {!editable && <p className="text-xs text-muted-foreground">{READERS_READ_ONLY_NOTE}</p>}
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <Button variant="outline" onClick={onClose}>
          閉じる
        </Button>
      </DialogFooter>
    </>
  )
}

function ReadersEditor({
  companyId,
  path,
  isDepartment,
  departmentName,
  departmentRestricted,
  own,
  inherited,
  lookups,
  onBack,
  onSaved,
}: {
  companyId: string
  path: string
  isDepartment: boolean
  departmentName: string
  departmentRestricted: boolean
  own: readonly PermissionRule[]
  inherited: readonly PermissionRule[]
  lookups: Lookups
  onBack: () => void
  onSaved: () => void
}) {
  const saved = useMemo(() => readersOf(own), [own])
  const isNew = !isDepartment && own.length === 0
  // A place made just now has nothing to follow but the department: start from choosing people.
  const [draft, setDraft] = useState<ReadersDraft>(() => (isNew ? { mode: 'chosen', readers: [] } : saved))
  const [busy, setBusy] = useState(false)
  const dirty = isNew ? draft.mode === 'chosen' : !sameReaders(draft, saved)
  const chosen = new Set(draft.readers.map(readerKey))
  const toggle = (r: Reader) =>
    setDraft((d) => ({
      mode: 'chosen',
      readers: d.readers.some((x) => readerKey(x) === readerKey(r)) ? d.readers.filter((x) => readerKey(x) !== readerKey(r)) : [...d.readers, r],
    }))

  const save = async () => {
    setBusy(true)
    try {
      await permissionsApi.replaceScope(companyId, path, rulesForReaders(draft, own, inherited, isDepartment))
      toast.success(`${placeName(path)}：見られる人を「${readersSummary(draft, isDepartment, lookups)}」にしました`)
      onSaved()
    } catch (err) {
      toast.error('見られる人を保存できませんでした', { description: describeError(err) })
    } finally {
      setBusy(false)
    }
  }

  const people = lookups.members.filter((m) => !isAdminRole(m.role))
  const option = (r: Reader, label: string, detail?: string) => {
    const on = chosen.has(readerKey(r))
    return (
      <CommandItem
        key={readerKey(r)}
        value={`${label} ${detail ?? ''} ${readerKey(r)}`}
        onSelect={() => toggle(r)}
        role="option"
        aria-selected={on}
        className="gap-3 py-2"
      >
        <span
          aria-hidden="true"
          className={cn('flex size-4 items-center justify-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}
        >
          {on && <Check size={12} weight="bold" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
      </CommandItem>
    )
  }

  return (
    <>
      <DialogHeader className="border-b px-6 pt-6 pb-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="戻る" disabled={busy}>
            <ArrowLeft />
          </Button>
          <DialogTitle>「{placeName(path)}」を見られる人</DialogTitle>
        </div>
        <DialogDescription>
          {isNew ? `「${placeName(path)}」は、見られる人を選んで保存すると作られます。` : READERS_INTRO}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 px-6 py-5">
        <div role="radiogroup" aria-label="見られる人" className="grid gap-2 sm:grid-cols-2">
          <RadioCard
            checked={draft.mode === 'everyone'}
            onSelect={() => setDraft({ mode: 'everyone', readers: draft.readers })}
            label={isDepartment ? '全員' : '部署と同じ'}
            help={isDepartment ? 'この会社のみんなが見られます' : `「${departmentName}」を見られる人が見られます`}
          />
          <RadioCard
            checked={draft.mode === 'chosen'}
            onSelect={() => setDraft({ mode: 'chosen', readers: draft.readers })}
            label="選んだ人だけ"
            help="選んだ人・部署・まとまりの人だけが見られます"
          />
        </div>
        {!isDepartment && draft.mode === 'everyone' && !isNew && (
          <p className="text-xs text-muted-foreground">保存すると、この場所は一覧からなくなり、「{departmentName}」と同じになります（置いた記録はそのままです）。</p>
        )}
        {draft.mode === 'chosen' && (
          <div className="space-y-2">
            <Command className="rounded-lg border" loop>
              <CommandInput placeholder="名前・部署・まとまりで絞り込む" />
              <CommandList className="max-h-64">
                <CommandEmpty>見つかりません</CommandEmpty>
                {lookups.departments.length > 0 && (
                  <CommandGroup heading="部署に所属する人">
                    {lookups.departments.map((d) => option({ subjectType: 'department', subjectId: d.id }, `${d.name}に所属する人`))}
                  </CommandGroup>
                )}
                {lookups.groups.length > 0 && (
                  <CommandGroup heading="見える人のまとまり">
                    {lookups.groups.map((g) => option({ subjectType: 'group', subjectId: g.id }, `${g.name}の人`, `${g.memberIds.length}人`))}
                  </CommandGroup>
                )}
                <CommandGroup heading="人">
                  {people.map((m) => option({ subjectType: 'user', subjectId: m.userId }, m.name || m.email || '名前未設定', m.email ?? undefined))}
                </CommandGroup>
              </CommandList>
            </Command>
            <p className="text-xs text-muted-foreground">
              {draft.readers.length === 0 ? 'まだだれも選ばれていません。このままだと、オーナーと管理者だけが見られます。' : `選んでいる人：${readersSummary(draft, isDepartment, lookups)}`}
            </p>
            {!isDepartment && departmentRestricted && (
              <p className="text-xs text-muted-foreground">選んだ人のうち、「{departmentName}」を見られる人だけが見られます。</p>
            )}
            <p className="text-xs text-muted-foreground">
              メンバーの組み合わせは
              <Link href={`/companies/${companyId}/groups`} className="underline underline-offset-2">
                「見える人のまとまり」
              </Link>
              で作れます。
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{OWNERS_ALWAYS_READ}</p>
      </div>
      <DialogFooter className="border-t px-6 py-4">
        <Button variant="outline" onClick={onBack} disabled={busy}>
          キャンセル
        </Button>
        <Button onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? '保存しています…' : '保存'}
        </Button>
      </DialogFooter>
    </>
  )
}

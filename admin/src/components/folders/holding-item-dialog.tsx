'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { DownloadSimple, Trash, Tray } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/app/confirm-dialog'
import { RadioCard } from '@/components/app/radio-card'
import { ListSkeleton } from '@/components/app/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { holdingApi, type HoldingFileVersion, type HoldingReviewFile, type HoldingReviewItem } from '@/lib/api'
import { formatDate } from '@/lib/format'
import {
  CAUSE_LABELS,
  changedSince,
  defaultSelection,
  describeDownloadError,
  describeHoldingError,
  discardedByTake,
  expiryText,
  fileStateText,
  formatBytes,
  groupFiles,
  groupTitle,
  personLabel,
  takeRequest,
  wouldMeetLaterChange,
  type HoldingProblem,
} from '@/lib/holding'
import { useQuery } from '@/lib/use-query'

/** Save a downloaded file in the browser (always a download: the member's bytes are never shown in the page). */
function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * One held item (the caller mounts it per item, keyed by its id, so nothing of another item stays): its entries by group, which go into the folder (「フォルダに入れる」, the default never
 * overwrites a later change) or 「捨てる」 after a confirm. Everything shown is the item's detail as the
 * API answered it to this reviewer; a refusal is said in plain words and the detail is read again.
 */
export function HoldingItemDialog({
  companyId,
  item,
  folderLabel,
  onOpenChange,
  onChanged,
}: {
  companyId: string
  item: HoldingReviewItem | null
  /** The folder as the list showed it (from the API's `folderPath`). */
  folderLabel: string
  onOpenChange: (open: boolean) => void
  /** Something was decided (or the item is gone): the list reads again. */
  onChanged: () => void
}) {
  const itemId = item?.itemId ?? null
  const detail = useQuery(itemId ? `holding:${companyId}:${itemId}` : null, () => holdingApi.get(companyId, itemId as string))
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [overwrite, setOverwrite] = useState(false)
  const [problem, setProblem] = useState<HoldingProblem | null>(null)
  const [busy, setBusy] = useState(false)
  /** The destructive confirm on screen: 捨てる, or a take-in that throws unticked contents away. */
  const [confirming, setConfirming] = useState<'discard' | 'take' | null>(null)

  const data = detail.data
  const folderGone = data?.folderGone ?? item?.folderGone ?? false

  // The item whose choice the reviewer is making: a detail read again for it keeps their choice.
  const choiceFor = useRef<string | null>(null)

  // The first detail of an item starts from the default choice; one read again after a refusal keeps what
  // was ticked, minus what the server no longer lets in (and what it named as having no place).
  useEffect(() => {
    if (!data) return
    if (choiceFor.current !== data.itemId) {
      choiceFor.current = data.itemId
      setSelected(defaultSelection(data.files, data.folderGone))
      setOverwrite(false)
      return
    }
    const takeable = new Set(data.files.filter((f) => f.takeable && !data.folderGone).map((f) => f.idx))
    setSelected((prev) => new Set([...prev].filter((idx) => takeable.has(idx))))
  }, [data])

  // The detail could not be read because the item is no longer this reviewer's: say so, reload the list.
  const loadProblem = useMemo(() => (detail.error && !data ? describeHoldingError(detail.error) : null), [detail.error, data])
  useEffect(() => {
    if (loadProblem?.gone) onChanged()
  }, [loadProblem, onChanged])

  const person = data ? personLabel(data) : item ? personLabel(item) : ''
  const groups = useMemo(() => (data ? groupFiles(data.files) : []), [data])
  const flagged = useMemo(() => new Set(problem?.files ?? []), [problem])
  const meetsLaterChange = data ? data.files.some((f) => selected.has(f.idx) && wouldMeetLaterChange(f)) : false
  // 「上書きする」 counts only while its choice is on screen: once no ticked file meets a later change the
  // choice is hidden, and a hidden choice never overwrites (Codex P2).
  const chosen = data ? takeRequest(data.files, selected, overwrite && meetsLaterChange) : null

  const close = () => onOpenChange(false)

  const afterRefusal = (err: unknown) => {
    const p = describeHoldingError(err)
    if (p.gone) {
      toast.error(p.message)
      onChanged()
      close()
      return
    }
    setProblem(p)
    // Entries the server named cannot go in as they are: untick them.
    if (p.files.length > 0) setSelected((prev) => new Set([...prev].filter((idx) => !p.files.includes(idx))))
    // The folder or the item may have moved on: read it again.
    detail.reload()
    onChanged()
  }

  const leftBehind = data && chosen ? discardedByTake(data.files, chosen) : 0

  const take = async () => {
    if (!data || !chosen || chosen.files.length === 0) return
    setConfirming(null)
    setBusy(true)
    setProblem(null)
    try {
      const result = await holdingApi.take(companyId, data.itemId, chosen)
      const alongside = result.placed.filter((p) => p.how === 'alongside').length
      toast.success(`${chosen.files.length}件をフォルダに入れました`, {
        description:
          alongside > 0
            ? `${alongside}件は、その後ほかの人が変えていたため「${person}の版」として並べて置きました。`
            : '見られる人のアプリには、次の同期で届きます。',
      })
      onChanged()
      close()
    } catch (err) {
      afterRefusal(err)
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    if (!data) return
    setProblem(null)
    try {
      await holdingApi.discard(companyId, data.itemId)
      toast.success('預かったファイルを捨てました')
      onChanged()
      close()
    } catch (err) {
      // The confirm closes on our own terms: a refusal is shown in the item's dialog.
      setConfirming(null)
      afterRefusal(err)
    }
  }

  const download = async (file: HoldingReviewFile, version: HoldingFileVersion) => {
    if (!data) return
    try {
      const got = await holdingApi.download(companyId, data.itemId, file.idx, version, file.path.split('/').pop() || 'file')
      saveFile(got.blob, got.name)
    } catch (err) {
      toast.error('ダウンロードできませんでした', { description: describeDownloadError(err) })
    }
  }

  const toggle = (idx: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })

  return (
    <>
      <Dialog open={item !== null && confirming === null} onOpenChange={(o) => !busy && onOpenChange(o)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{person}から預かったもの</DialogTitle>
            {item && (
              <DialogDescription>
                {folderLabel}・{formatDate(item.receivedAt)}・{CAUSE_LABELS[item.cause] ?? '見る権限がなくなったとき'}・{expiryText(item.expiresAt)}
              </DialogDescription>
            )}
          </DialogHeader>

          {detail.loading ? (
            <ListSkeleton rows={3} />
          ) : loadProblem ? (
            <Callout variant="danger" title="開けませんでした">
              <p>{loadProblem.message}</p>
            </Callout>
          ) : data ? (
            // design-lint-allow arbitrary-value -- a long list scrolls inside the dialog; no layout token for a viewport height yet
            <div className="max-h-[65vh] space-y-4 overflow-y-auto">
              {folderGone && (
                <Callout variant="warning" title="このフォルダはもうありません">
                  <p>ダウンロードするか、捨てることだけができます。</p>
                </Callout>
              )}
              {data.state === 'taking' && (
                <Callout variant="info">
                  <p>いまフォルダに入れているところです。少したってから読み込み直してください。</p>
                </Callout>
              )}
              {problem && (
                <Callout variant="danger" title="できませんでした">
                  <p>{problem.message}</p>
                </Callout>
              )}
              {detail.error !== undefined && !detail.fetching && (
                <Callout variant="warning" title="最新の状態を読み込めませんでした">
                  <p>表示は前に読み込んだときのものです。閉じて、開き直してください。</p>
                </Callout>
              )}

              {groups.length === 0 && <p className="text-body text-text-muted">中身はありません。</p>}
              {groups.map(({ group, files }) => (
                <section key={group} aria-label={groupTitle(group, person)} className="space-y-1.5">
                  <h3 className="text-body font-strong">
                    {groupTitle(group, person)} <span className="font-normal text-text-muted">{files.length}件</span>
                  </h3>
                  <ul className="divide-y rounded-control border">
                    {files.map((f) => {
                      const canChoose = f.takeable && !folderGone && data.state === 'waiting'
                      const state = fileStateText(f)
                      return (
                        <li key={f.idx} className="flex items-start gap-3 px-row-x py-2" data-flagged={flagged.has(f.idx) || undefined}>
                          {canChoose ? (
                            <input
                              type="checkbox"
                              className="mt-1 size-4 shrink-0"
                              checked={selected.has(f.idx)}
                              onChange={() => toggle(f.idx)}
                              disabled={busy}
                              aria-label={`${f.path} をフォルダに入れる`}
                            />
                          ) : (
                            <span aria-hidden="true" className="size-4 shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-body" title={f.path}>
                              {f.path}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-text-muted">
                              {f.kind !== 'deleted' && <span>{formatBytes(f.size)}</span>}
                              {f.label && <span>{f.label}</span>}
                              {state && (
                                f.kind !== 'deleted' && f.kind !== 'backup' && f.held && changedSince(f) && f.inFolderNow ? (
                                  <Badge variant="warning">{state}</Badge>
                                ) : (
                                  <span>{state}</span>
                                )
                              )}
                              {flagged.has(f.idx) && <Badge variant="danger">このファイルは入れられません</Badge>}
                            </div>
                          </div>
                          {(f.held || f.inFolderNow) && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" aria-label={`${f.path} をダウンロード`}>
                                  <DownloadSimple />
                                  ダウンロード
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {f.held && <DropdownMenuItem onSelect={() => void download(f, 'held')}>{person}の版</DropdownMenuItem>}
                                {f.inFolderNow && <DropdownMenuItem onSelect={() => void download(f, 'current')}>いまのフォルダの版</DropdownMenuItem>}
                                {f.inFolderNow && f.standing === 'changed' && (
                                  <DropdownMenuItem onSelect={() => void download(f, 'base')}>{person}がもとにした版</DropdownMenuItem>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}

              {!folderGone && meetsLaterChange && (
                <div role="radiogroup" aria-label="その後ほかの人が変えたファイル" className="space-y-2">
                  <p className="text-body font-strong">その後ほかの人が変えたファイル</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <RadioCard
                      checked={!overwrite}
                      onSelect={() => setOverwrite(false)}
                      label={`「${person}の版」として並べて置く`}
                      help="上書きせず、名前を変えて横に置きます。いまのフォルダの中身はそのままです。"
                    />
                    <RadioCard
                      checked={overwrite}
                      onSelect={() => setOverwrite(true)}
                      label="上書きする"
                      help={`ほかの人の変更を消して、${person}の版に置きかえます。`}
                    />
                  </div>
                </div>
              )}
              {!folderGone && (
                <p className="text-small text-text-muted">
                  選ばなかったものは、フォルダに入れたあと捨てます{leftBehind > 0 ? `（いまは${leftBehind}件）` : ''}。本人のメモと名前だけのものは、フォルダに入れられません（必要ならダウンロードしてください）。
                </p>
              )}
            </div>
          ) : null}

          <DialogFooter>
            {data && (
              <Button variant="outline" className="sm:mr-auto" onClick={() => setConfirming('discard')} disabled={busy || data.state !== 'waiting'}>
                <Trash />
                捨てる…
              </Button>
            )}
            <Button variant="outline" onClick={close} disabled={busy}>
              閉じる
            </Button>
            {data && !folderGone && (
              <Button onClick={() => (leftBehind > 0 ? setConfirming('take') : void take())} disabled={busy || data.state !== 'waiting' || !chosen || chosen.files.length === 0}>
                <Tray />
                {busy ? '入れています…' : `フォルダに入れる（${chosen?.files.length ?? 0}件）`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={item !== null && confirming === 'discard'}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="預かったファイルを捨てますか？"
        description={
          <>
            <p>
              {person}から預かったファイル（{data?.files.length ?? 0}件）をすべて捨てます。元に戻せません。
            </p>
            <p>捨てたあとは、この画面からも取り出せません。必要なものは、先にダウンロードしてください。</p>
          </>
        }
        confirmLabel="捨てる"
        cancelLabel="やめる"
        onConfirm={discard}
      />
      <ConfirmDialog
        open={item !== null && confirming === 'take'}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="フォルダに入れて、残りを捨てますか？"
        description={
          <>
            <p>
              選んだ{chosen?.files.length ?? 0}件をフォルダに入れます。選ばなかった{leftBehind}件（バックアップや本人のメモを含みます）は捨てます。捨てたものは元に戻せません。
            </p>
            <p>残したいものは、先にダウンロードするか、選んでから入れてください。</p>
          </>
        }
        confirmLabel="入れて、残りを捨てる"
        cancelLabel="やめる"
        onConfirm={take}
      />
    </>
  )
}

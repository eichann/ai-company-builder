'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Warning } from '@phosphor-icons/react'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { outdatedClientsOf, type OutdatedClients } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { formatBuild, formatRelative, parseBuild } from '@/lib/format'

export const OUTDATED_CLIENTS_MESSAGE =
  '次のメンバーは古いアプリを使っているため、編集を制限すると同期できなくなります。先にアプリを更新してもらってください。'

/**
 * Shown when the server refused a rule change with 409 OUTDATED_CLIENTS: a
 * member who would lose edit access runs a desktop app that cannot recover
 * from the rejection (it would retry forever and never sync again). Owners
 * and admins get a secondary 「それでも保存する」 that resends with force;
 * managers only get the list and the way to the members screen.
 */
export function OutdatedClientsDialog({
  state,
  onClose,
  onForce,
}: {
  state: OutdatedClients | null
  onClose: () => void
  /** Resend with force. May throw: the dialog then stays open. */
  onForce: () => Promise<void>
}) {
  const { companyId, isAdmin } = useCompany()
  const [busy, setBusy] = useState(false)
  const canForce = !!state?.canForce && isAdmin

  const force = async () => {
    setBusy(true)
    try {
      await onForce()
      onClose()
    } catch {
      // The caller has shown a toast; keep the dialog open.
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Warning size={20} weight="fill" className="shrink-0 text-warning" aria-hidden="true" />
            アプリの更新が必要なメンバーがいます
          </DialogTitle>
          <DialogDescription>{OUTDATED_CLIENTS_MESSAGE}</DialogDescription>
        </DialogHeader>

        <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border" aria-label="古いアプリを使っているメンバー">
          {(state?.members ?? []).map((m) => {
            const name = m.name || m.email || '名前未設定'
            const build = parseBuild(m.clientVersion)
            return (
              <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
                <Avatar name={name} seed={m.userId} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{name}</div>
                  {m.email && <div className="truncate text-xs text-muted-foreground">{m.email}</div>}
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div className="tabular-nums">{m.clientVersion ? formatBuild(build, m.clientVersion) : '不明'}</div>
                  <div className="text-muted-foreground">{m.lastSeenAt ? `最終接続 ${formatRelative(m.lastSeenAt)}` : '未接続'}</div>
                </div>
              </li>
            )
          })}
        </ul>

        <Link
          href={`/companies/${companyId}/members`}
          className="inline-flex items-center gap-1 self-start rounded text-sm font-medium text-brand underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          メンバー画面で確認
          <ArrowRight size={14} />
        </Link>

        <DialogFooter>
          {canForce && (
            <Button type="button" variant="destructive" onClick={force} disabled={busy}>
              {busy ? '保存しています…' : 'それでも保存する'}
            </Button>
          )}
          <Button type="button" onClick={onClose} disabled={busy}>
            保存せずに戻る
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * State for OutdatedClientsDialog. `catchOutdated(err, retry)` returns true
 * (and opens the dialog) when `err` is OUTDATED_CLIENTS; `retry` is what
 * 「それでも保存する」 runs, with force.
 */
export function useOutdatedClients() {
  const [pending, setPending] = useState<{ state: OutdatedClients; retry: () => Promise<void> } | null>(null)
  const catchOutdated = useCallback((err: unknown, retry: () => Promise<void>): boolean => {
    const state = outdatedClientsOf(err)
    if (!state) return false
    setPending({ state, retry })
    return true
  }, [])
  const dialogProps = {
    state: pending?.state ?? null,
    onClose: () => setPending(null),
    onForce: async () => {
      await pending?.retry()
    },
  }
  return { catchOutdated, dialogProps }
}

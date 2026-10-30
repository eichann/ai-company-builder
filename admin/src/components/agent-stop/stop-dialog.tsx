'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { agentStopApi, companiesApi, type AgentStopToolKind, type AgentStopView } from '@/lib/api'
import { STOP_LIMITS, STOP_TOOL_HELP, STOP_TOOL_KINDS, STOP_TOOL_LABELS, stopEffect, stopScopeLabel } from '@/lib/agent-stop'
import { useCompany } from '@/lib/company-context'
import { describeError } from '@/lib/errors'
import { useQuery } from '@/lib/use-query'
import { cn } from '@/lib/utils'

const EVERYONE = '__everyone__'
const ALL = '__all__'

/**
 * 「AI を止める」: whom (everyone / one member), what (the whole AI / one kind of
 * tool) and why (optional), then one click. Reachable from every page.
 */
export function StopDialog({
  open,
  onOpenChange,
  onStopped,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStopped: (view: AgentStopView) => void
}) {
  const { companyId } = useCompany()
  const members = useQuery(open ? `members:${companyId}` : null, () => companiesApi.getMembers(companyId))
  const [who, setWho] = useState(EVERYONE)
  const [what, setWhat] = useState<string>(ALL)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const member = members.data?.find((m) => m.userId === who)
  const tool = what === ALL ? null : (what as AgentStopToolKind)
  const label = stopScopeLabel({ userId: who === EVERYONE ? null : who, userName: member?.name ?? null, userEmail: member?.email ?? null, tool })

  const close = (o: boolean) => {
    if (busy) return
    onOpenChange(o)
    if (!o) { setWho(EVERYONE); setWhat(ALL); setReason('') }
  }

  const stop = async () => {
    setBusy(true)
    try {
      const view = await agentStopApi.stop(companyId, { userId: who === EVERYONE ? null : who, tool, reason: reason.trim() })
      toast.success(`${label}を止めました`, { description: 'メンバーのアプリには数秒で届きます。解除は「AI の緊急停止」から。' })
      onStopped(view)
      setBusy(false)
      close(false)
    } catch (err) {
      toast.error('止められませんでした', { description: describeError(err) })
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI を止める</DialogTitle>
          <DialogDescription>メンバーのアプリの AI を、解除するまで止めます。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="stop-who">だれの AI を</Label>
            <select
              id="stop-who"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={who}
              onChange={(e) => setWho(e.target.value)}
            >
              <option value={EVERYONE}>全員（会社のメンバー全員）</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name || m.email || m.userId}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">何を止めるか</legend>
            <div role="radiogroup" aria-label="何を止めるか" className="grid gap-2">
              <Choice checked={what === ALL} onSelect={() => setWhat(ALL)} label="AI のすべて" help="会話そのものを止めます。いちばん確実です。" />
              {STOP_TOOL_KINDS.map((k) => (
                <Choice key={k} checked={what === k} onSelect={() => setWhat(k)} label={STOP_TOOL_LABELS[k]} help={STOP_TOOL_HELP[k]} />
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="stop-reason">理由（任意・管理者だけが見ます）</Label>
            <Textarea id="stop-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 不審な操作を調べるため" />
          </div>

          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <p className="font-medium">「{label}」を止めます。</p>
            <p className="text-muted-foreground">{stopEffect(tool)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{STOP_LIMITS}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="destructive" onClick={stop} disabled={busy}>
            {busy ? '止めています…' : '止める'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Choice({ checked, onSelect, label, help }: { checked: boolean; onSelect: () => void; label: string; help: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        checked ? 'border-destructive bg-destructive/5' : 'hover:bg-muted/50',
      )}
    >
      <span className="font-medium">{label}</span>
      <span className="block text-xs text-muted-foreground">{help}</span>
    </button>
  )
}

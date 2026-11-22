// The admin's callouts and status badges (design-system.md "Callouts and status badges (P2b,
// done)"): each variant paints with its own token set (bg, border, text, icon) in light and dark,
// measured from the CSS Tailwind 4 generates; the three stopped states stay apart in colour, icon
// and word; the screens use them by meaning — a scheduled job paused by a person is grey and one
// the server paused because its responsible person left is red, approval and acceptance are amber,
// 「AI を止めています」 is grey (agent-stop.test.tsx); a plugin problem the admin has to act on (the
// connector off, the write-back fields not confirmed) is amber, by a person grey, on a failure red.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Callout, type CalloutVariant } from '@/components/ui/callout'
import { jobBadge } from '@/components/jobs/jobs-page'
import type { JobView, PluginProblem } from '@/lib/api'
import { connectionLineTone, PROBLEM_STOP, PROBLEM_TEXT, problemBadge } from '@/lib/integrations'
import { cn } from '@/lib/utils'
import { paint, token } from './token-paint'

const set = (name: string) => ({
  fill: token(`${name}-bg`), border: token(`${name}-border`), text: token(`${name}-text`), icon: token(`${name}-icon`),
})
async function expectSet(className: string, iconClassName: string | null, name: string) {
  const want = set(name)
  const got = await paint(className)
  const icon = iconClassName === null ? got : await paint(iconClassName)
  for (const theme of ['light', 'dark'] as const) {
    expect({ fill: got[theme].fill, border: got[theme].border, text: got[theme].text }, `${name} ${theme}`).toEqual(
      { fill: want.fill[theme], border: want.border[theme], text: want.text[theme] })
    expect(iconClassName === null ? icon[theme].icon : icon[theme].text, `${name} icon ${theme}`).toBe(want.icon[theme])
  }
}

const BADGES: BadgeVariant[] = ['info', 'success', 'warning', 'danger', 'paused', 'failed', 'awaiting', 'ai', 'selected', 'readonly']
const CALLOUTS: CalloutVariant[] = ['info', 'warning', 'danger', 'success', 'paused', 'failed', 'awaiting']

describe('status badges and callouts read their token sets', () => {
  it('every Badge variant: bg, border, text and its icon, light and dark', async () => {
    for (const v of BADGES) {
      const { unmount } = render(<Badge variant={v}>札</Badge>)
      await expectSet(screen.getByText('札').className, null, v)
      unmount()
    }
  }, 120_000)

  it('every Callout variant: bg, border, text and its icon, light and dark', async () => {
    for (const v of CALLOUTS) {
      const { container, unmount } = render(<Callout variant={v}>囲み</Callout>)
      const box = container.querySelector('[data-slot="callout"]')!
      await expectSet(box.className, box.querySelector('svg')!.getAttribute('class')!, v)
      unmount()
    }
  }, 120_000)

  it('the three stopped states differ in colour, icon and the danger/failed box is an alert', async () => {
    const fills = await Promise.all((['paused', 'failed', 'awaiting'] as const).map(async (v) => {
      const { container, unmount } = render(<Badge variant={v}>止</Badge>)
      const el = container.querySelector('[data-slot="badge"]')!
      const out = { fill: (await paint(el.className)).light.fill, icon: el.querySelector('svg')!.innerHTML }
      unmount()
      return out
    }))
    expect(new Set(fills.map((f) => f.fill)).size).toBe(3)
    expect(new Set(fills.map((f) => f.icon)).size).toBe(3)
    expect(fills[0].fill).not.toBe(token('danger-bg').light)
    render(<Callout variant="failed">止まりました</Callout>)
    expect(screen.getByRole('alert')).toHaveTextContent('止まりました')
  }, 60_000)
})

describe('cn() keeps the token scales', () => {
  it('a badge and a callout keep their type size next to their colour; a caller\'s own size or corner still wins', () => {
    // tailwind-merge read `text-small` as a colour and dropped it beside `text-success-text`.
    render(<Badge variant="success">札</Badge>)
    expect(screen.getByText('札').className).toMatch(/(^|\s)text-small(\s|$)/)
    const { container } = render(<Callout variant="info">囲み</Callout>)
    expect(container.querySelector('[data-slot="callout"]')!.className).toMatch(/(^|\s)text-body(\s|$)/)
    expect(cn('text-small text-success-text', 'text-sm')).toBe('text-success-text text-sm')
    expect(cn('rounded-control', 'rounded-xl')).toBe('rounded-xl')
    expect(cn('shadow-pop', 'shadow-sm')).toBe('shadow-sm')
    expect(cn('font-strong', 'font-medium')).toBe('font-medium')
  })
})

const job = (over: Partial<JobView>): JobView => ({ state: 'active', waiting: null, pausedReason: null, placement: 'e', ...over }) as JobView

describe('the screens use them by meaning', () => {
  it('a scheduled job: paused by a person → grey 「止めています」, by the server (person left) → red 「止まりました」, approval / acceptance → amber', () => {
    expect(jobBadge(job({ state: 'paused', pausedReason: 'ADMIN' }))).toEqual({ label: '止めています', variant: 'paused' })
    expect(jobBadge(job({ state: 'paused', pausedReason: 'BY_RESPONSIBLE' }))).toEqual({ label: '止めています', variant: 'paused' })
    expect(jobBadge(job({ state: 'paused', pausedReason: 'OWNER_LEFT' }))).toEqual({ label: '止まりました', variant: 'failed' })
    expect(jobBadge(job({ state: 'paused', pausedReason: 'OWNER_RIGHTS_CHANGED' }))).toEqual({ label: '止まりました', variant: 'failed' })
    expect(jobBadge(job({ waiting: 'COMPANY_STOPPED' }))).toEqual({ label: 'すべて止めています', variant: 'paused' })
    expect(jobBadge(job({ waiting: 'NOT_APPROVED' }))).toEqual({ label: '承認を待っています', variant: 'awaiting' })
    expect(jobBadge(job({ waiting: 'NOT_ACCEPTED' })).variant).toBe('awaiting')
    expect(jobBadge(job({})).variant).toBe('success')
  })


  it('a plugin problem: the admin has to act → amber 「止まっています」; a person stopped it → grey; a failure → red', async () => {
    const needsAction: PluginProblem[] = ['connector-stopped', 'auto-not-acknowledged', 'no-connector', 'not-a-business']
    for (const p of needsAction) expect(problemBadge(p), p).toEqual({ label: '止まっています', variant: 'warning' })
    for (const p of ['stopped', 'key-stopped'] as const) expect(problemBadge(p), p).toEqual({ label: '止めています', variant: 'paused' })
    for (const p of ['not-on-shelf', 'package-changed', 'no-key', 'key-destination', 'mapping-invalid', 'connector-missing', 'connector-mismatch'] as const) {
      expect(problemBadge(p), p).toEqual({ label: '止まりました', variant: 'failed' })
    }
    // Every problem has its colour chosen (the Record), none falls back to an uncoloured outline but オフ.
    expect(Object.keys(PROBLEM_STOP).sort()).toEqual(Object.keys(PROBLEM_TEXT).sort())
    // What the badge paints: the warning set, light and dark (with the WarningCircle the page passes).
    const { unmount } = render(<Badge variant={problemBadge('connector-stopped').variant}>止</Badge>)
    await expectSet(screen.getByText('止').className, null, 'warning')
    unmount()
    // A business's 「〇〇 との行き来は止まっています」 line: amber text when the connector is off, plain otherwise.
    const line = await paint(connectionLineTone('connector-stopped'))
    for (const theme of ['light', 'dark'] as const) expect(line[theme].text, theme).toBe(token('warning-text')[theme])
    expect(connectionLineTone('connector-missing')).toBe('text-muted-foreground')
  }, 60_000)
})

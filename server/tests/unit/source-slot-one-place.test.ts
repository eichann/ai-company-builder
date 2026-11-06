/**
 * The source's slot is decided in ONE place (出どころの枠 §10: 「決まりは本体の1つの部品にだけ書く」):
 * `services/source-slot-candidates.ts` `decideSlot`. Every AI path that makes a meeting-linked task or
 * decision goes through it, and no module keeps a slot rule of its own. In the style of
 * `layering.test.ts`: it reads the imports and calls of `server/src`.
 *
 * - the engine's create (`record-engine/create.ts`: `POST /records-ai/item`, every AI create and a
 *   plugin step's create go through it) and the decision service call `decideSlot`;
 * - the older per-meeting helpers (`findMeetingOutput`, `meetingOutputId`) are used only where listed
 *   below, each with its reason — a new AI path reaching them instead of the slot fails here.
 * The behaviour itself (one candidate per quote, nothing lost): `source-slot-candidates.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

const SRC = resolve(__dirname, '../../src')

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return tsFiles(p)
    return p.endsWith('.ts') ? [p] : []
  })
}

/** The source without comments (a comment naming a helper is not a use). */
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** Modules that must decide through the slot. */
const THROUGH_SLOT = ['services/record-engine/create.ts', 'services/decisions.ts']

/** Modules that may still use the older per-meeting helpers, with the reason. The list only shrinks. */
const OLDER_HELPERS: Record<string, string> = {
  'services/meeting-outputs.ts': 'defines them (and the admin duplicates list)',
  'services/source-slot-candidates.ts': 'the slot itself',
  'services/minutes-review.ts': 'the server\'s own 「議事録を確認する」, one per meeting: not an AI\'s output',
  'services/outbound-mail.ts': 'the member\'s own mail draft of a meeting made once (its author\'s); sending is one per source through services/source-slots.ts',
}

describe('the source slot is decided in one place', () => {
  const files = tsFiles(SRC).map(f => ({ path: relative(SRC, f), text: code(f) }))

  it('the engine\'s create and the decision service call decideSlot from the slot module', () => {
    for (const p of THROUGH_SLOT) {
      const f = files.find(x => x.path === p)
      expect(f, p).toBeDefined()
      expect(f?.text, p).toMatch(/from '(?:\.\.\/)+source-slot-candidates'|from '\.\/source-slot-candidates'/)
      expect(f?.text, p).toMatch(/\bdecideSlot\(/)
    }
  })

  it('no other module derives or finds a meeting\'s output by the older helpers', () => {
    const users = files.filter(f => /\b(?:findMeetingOutput|meetingOutputId)\b/.test(f.text)).map(f => f.path).sort()
    expect(users.filter(p => !Object.prototype.hasOwnProperty.call(OLDER_HELPERS, p))).toEqual([])
  })
})

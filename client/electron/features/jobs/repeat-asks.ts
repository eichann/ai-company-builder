// 「毎週同じ時間にやりましょうか？」 (jobs.md "Member proposals" "Asking after repeats (PR D)"): this PC's count of the
// company Skills the member's AI loaded, per member and company, and the one-time question the chat server adds to a turn.
//   jobRepeatAsks:get   whether 「AI から定期の仕事を提案してもらう」 is on for the signed-in member in this company
//   jobRepeatAsks:set   turn it on / off (off: nothing is counted or asked)
//
// Kept only here, in <userData>/job-repeat-asks.json (owner-only, atomic): Skill folder names and local dates — never a
// conversation id, text or path — and never sent to the server or logged. The rules are client/shared/job-repeat-asks.ts.

import fs from 'fs'
import { atomicWrite } from '../../chat-history-store'
import { locateCompanySkill } from '../../services/skill-use-reporter'
import { emptyRepeatFile, localDay, markRepeatAsked, noteRepeatUse, readRepeatFile, repeatAskable, repeatAskInstructions, repeatMemberKey, type JobRepeatAskSetting, type RepeatFile, type RepeatMember } from '../../../shared/job-repeat-asks'
import type { IpcRegistrar } from '../../ipc/registrar'

export interface JobRepeatAsksDeps {
  /** The store file (resolved on first use). */
  file: () => string
  /** The signed-in member (services/session.ts); null = nobody: nothing counted or asked. */
  userId: () => string | null
  /** The member's home: a personal Skill of the same name makes a company Skill ambiguous (not counted). */
  home?: string
  now?: () => Date
  log?: Pick<Console, 'warn'>
  /** Tests: whether `name` is a company Skill reachable from the consultation (default: `locateCompanySkill`). */
  isCompanySkill?: (companyRoot: string, workingDirectory: string | undefined, name: string) => boolean
}

/** One consultation turn where the job proposal tools are offered (the chat server asks only then). */
export interface JobRepeatAskTurn {
  companyId: string
  companyRoot: string
  workingDirectory?: string
}

const ID = /^[A-Za-z0-9_-]{1,100}$/

export function createJobRepeatAsks(deps: JobRepeatAsksDeps) {
  const now = deps.now ?? (() => new Date())
  const isCompanySkill = deps.isCompanySkill
    ?? ((root: string, wd: string | undefined, name: string) => 'rel' in locateCompanySkill(root, wd, name, deps.home))
  let cache: RepeatFile | null = null
  // A file that exists but cannot be read: nothing is asked or written (an asked mark may be in it) until it changes —
  // its identity when it failed is kept, and a later look reads it again once that differs (fixed, replaced or removed).
  let unreadable: string | null = null
  const identity = (): string => {
    try {
      const st = fs.statSync(deps.file())
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unknown'
    }
  }
  let warned = false
  const warn = (why: string) => {
    if (warned) return
    warned = true
    deps.log?.warn(`[job-repeat-asks] ${why}`)
  }

  function load(): RepeatFile | null {
    if (cache) return cache
    if (unreadable !== null) {
      if (identity() === unreadable) return null
      unreadable = null
    }
    let text: string
    try {
      text = fs.readFileSync(deps.file(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return (cache = emptyRepeatFile())
      unreadable = identity()
      warn('the store could not be read; nothing is asked')
      return null
    }
    let parsed: RepeatFile | null = null
    try { parsed = readRepeatFile(JSON.parse(text)) } catch { parsed = null }
    if (!parsed) {
      unreadable = identity()
      warn('the store is not usable; nothing is asked')
      return null
    }
    return (cache = parsed)
  }

  function memberKey(companyId: string): string | null {
    const user = deps.userId()
    return user && ID.test(companyId) ? repeatMemberKey(user, companyId) : null
  }

  function update(key: string, change: (m: RepeatMember) => RepeatMember): boolean {
    const file = load()
    if (!file) return false
    const before = file.members[key] ?? { skills: {} }
    const after = change(before)
    if (after === before) return true
    const next: RepeatFile = { version: 1, members: { ...file.members, [key]: after } }
    try {
      atomicWrite(deps.file(), JSON.stringify(next))
    } catch {
      warn('the store could not be written')
      return false
    }
    cache = next
    return true
  }

  return {
    /**
     * A turn of a consultation the member is in, with the job proposal tools offered. Returns the question to add to
     * the turn's prompt (empty when none is due) and the sink for each Skill the AI loads in this turn; undefined when
     * nobody is signed in, the switch is off or the store cannot be read.
     */
    turn(t: JobRepeatAskTurn): { instructions: string; skillUsed: (skill: string) => void } | undefined {
      const key = memberKey(t.companyId)
      const file = key ? load() : null
      if (!key || !file || file.members[key]?.off) return undefined
      const day = localDay(now())
      // Only Skills that are still the company's (a Skill removed, a private folder's or a personal one is never named),
      // filtered before the per-turn cap so such Skills never take the places.
      const named = new Set(repeatAskable(file.members[key], day, s => isCompanySkill(t.companyRoot, t.workingDirectory, s)))
      return {
        instructions: repeatAskInstructions([...named]),
        skillUsed: (skill: string) => {
          try {
            if (!isCompanySkill(t.companyRoot, t.workingDirectory, skill)) return
            const today = localDay(now())
            // The question went with this turn and the AI loaded the Skill: asked for good, whatever it did or was told —
            // also when the turn is stopped or fails afterwards and nothing was asked (fails quiet: never asked twice).
            update(key, m => (named.has(skill) ? markRepeatAsked(m, skill, today) : noteRepeatUse(m, skill, today)))
          } catch { /* informational: never in the AI's path */ }
        },
      }
    },
    setting(companyId: unknown): JobRepeatAskSetting {
      const key = typeof companyId === 'string' ? memberKey(companyId) : null
      const file = key ? load() : null
      if (!key || !file) return { success: false }
      return { success: true, on: !file.members[key]?.off }
    },
    setOn(companyId: unknown, on: unknown): JobRepeatAskSetting {
      const key = typeof companyId === 'string' ? memberKey(companyId) : null
      if (!key || typeof on !== 'boolean') return { success: false }
      // Off forgets the counts too (nothing is kept while the member does not want it); the asked marks stay.
      const ok = update(key, m => {
        if (on) return m.off ? { skills: m.skills } : m
        return { off: true, skills: Object.fromEntries(Object.entries(m.skills).filter(([, s]) => 'asked' in s)) }
      })
      return ok ? { success: true, on } : { success: false }
    },
  }
}

export type JobRepeatAsks = ReturnType<typeof createJobRepeatAsks>

export function registerJobRepeatAsksIpc(ipc: IpcRegistrar, asks: Pick<JobRepeatAsks, 'setting' | 'setOn'>) {
  ipc.handle('jobRepeatAsks:get', (_event, companyId) => asks.setting(companyId))
  ipc.handle('jobRepeatAsks:set', (_event, companyId, on) => asks.setOn(companyId, on))
}

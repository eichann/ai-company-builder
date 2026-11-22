// The AI's browser operation's switch as main hands it to each 6b entry (agent-browser.md "The
// operator and the preview", "This PC's opt-in"): asked on the first line of the preview, the
// operator's start and the runner, and — folded into the context by wire.ts — at every step of a run up
// to the last check before the request leaves; off = return at once. The composition passes
// `createThisPcSwitch` (the build constant, off, or this PC's opt-in); tests pass their own.
import fs from 'node:fs'
import { BROWSER_AI_BUILD_SWITCH, BROWSER_AI_OPT_IN_MAX_BYTES, browserAiOptInOn } from '../../../shared/browser-ai'

export type BrowserAiSwitch = () => boolean

export const buildAiSwitch: BrowserAiSwitch = () => BROWSER_AI_BUILD_SWITCH

/**
 * The build constant, or this PC's opt-in (`<userData>/browser-ai-this-pc.json`, created by the person
 * by hand): read **on every ask**, so removing the file, its `until` passing, another server or another
 * member signed in turns it off at once — also in the middle of a run (the run's context asks it again
 * right before the request leaves). A regular file only (a link is never followed), small; anything
 * unreadable = off. Synchronous on purpose: the runner's last check (`beforeSend`) may not await.
 */
export function createThisPcSwitch(deps: {
  file: () => string
  server: () => string
  userId: () => string | null
  now?: () => number
  build?: boolean
}): BrowserAiSwitch {
  const now = deps.now ?? Date.now
  const build = deps.build ?? BROWSER_AI_BUILD_SWITCH
  return () => {
    if (build) return true
    try {
      const file = deps.file()
      // A link is never followed (O_NOFOLLOW), a pipe never waited on (O_NONBLOCK: this runs on main's
      // thread); what was opened must be a small regular file.
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      let text: string
      try {
        const st = fs.fstatSync(fd)
        if (!st.isFile() || st.size > BROWSER_AI_OPT_IN_MAX_BYTES) return false
        text = fs.readFileSync(fd, 'utf8')
      } finally { fs.closeSync(fd) }
      return browserAiOptInOn(text, { server: deps.server(), userId: deps.userId(), at: now() })
    } catch {
      return false
    }
  }
}

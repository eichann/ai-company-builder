// The AI's browser operation's switch as main hands it to each 6b entry (agent-browser.md "The
// operator and the preview"): asked on the first line of the preview, the operator's start and the
// runner; off = return at once. The composition passes `buildAiSwitch` (the build constant, off in
// 6b); tests pass their own.
import { BROWSER_AI_BUILD_SWITCH } from '../../../shared/browser-ai'

export type BrowserAiSwitch = () => boolean

export const buildAiSwitch: BrowserAiSwitch = () => BROWSER_AI_BUILD_SWITCH

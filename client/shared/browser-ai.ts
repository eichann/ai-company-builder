/**
 * The build switch of the AI's browser operation (agent-browser.md "The operator and the preview",
 * design memo §33.3). PR 6b connects every path in the app but ships it switched off; 6c turns it on
 * for the owner's PC. Every 6b entry asks it on its first line (`features/browser/ai-switch.ts`) and,
 * while it is off, returns at once: no page read, no CLI check or start, no server call, no send.
 * The clean-up paths (cancel, report, confirm, the waiting list, the card) never ask it.
 *
 * `client/tests/browser-ai-switch.test.ts` fails while this is anything but `false`.
 */
export const BROWSER_AI_BUILD_SWITCH = false as boolean

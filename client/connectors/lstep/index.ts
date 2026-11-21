/**
 * Lステップ as the app bundles it: its checkers and its declaration, handed to the core by the
 * composition root (agent-browser.md "The checker"). The core never imports this folder.
 */
import type { BrowserChecker } from '../../shared/browser-runner'
import { LSTEP_DECLARATION } from './declaration'
import { createLstepReminderStepChecker, UNCONFIRMED_ACCOUNT, type AccountReader } from './reminder-step'

export function lstepConnector(readers: { account?: AccountReader } = {}): { declaration: string; checkers: BrowserChecker[] } {
  return { declaration: LSTEP_DECLARATION, checkers: [createLstepReminderStepChecker(readers.account ?? UNCONFIRMED_ACCOUNT)] }
}

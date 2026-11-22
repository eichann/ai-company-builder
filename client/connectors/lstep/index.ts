/**
 * Lステップ as the app bundles it: its checkers, its preview readers and its declaration, handed to
 * the core by the composition root (agent-browser.md "The checker"). The core never imports this
 * folder.
 */
import type { BrowserChecker, BrowserPreviewReader } from '../../shared/browser-runner'
import { LSTEP_DECLARATION } from './declaration'
import { accountFromMeta, createLstepReminderStepChecker, type AccountReader } from './reminder-step'
import { createLstepReminderStepsReader } from './reminder-steps-reader'
import { createLstepReminderScheduleReader } from './reminder-schedule'
import { createLstepListReaders } from './list-readers'

export function lstepConnector(readers: { account?: AccountReader } = {}): { declaration: string; checkers: BrowserChecker[]; readers: BrowserPreviewReader[] } {
  return {
    declaration: LSTEP_DECLARATION,
    checkers: [createLstepReminderStepChecker(readers.account ?? accountFromMeta)],
    readers: [...createLstepListReaders(), createLstepReminderStepsReader(), createLstepReminderScheduleReader()],
  }
}

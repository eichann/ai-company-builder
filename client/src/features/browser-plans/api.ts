// 「ブラウザ操作」 plan cards' access to the main process (agent-browser.md "The card, the IPC and the request
// tool"), as small ports by what they can do. Every function takes its port last (default window.electronAPI).
import type { ElectronPort } from '../../shared/ipc/electron-api'
import type { BrowserConfirmResult } from '../../../shared/browser-plans'

/** Reading the member's own plans from the company server (and whether ［任せる］ can be pressed here). */
export type BrowserPlanReads = ElectronPort<'getBrowserPlan' | 'listBrowserPlans'>
/** ［任せる］: the app operates the site and sends the planned change. */
export type BrowserPlanOutbound = ElectronPort<'runBrowserPlan'>
/** ［やめる］ and the confirm: change the plan's state on the server only. */
export type BrowserPlanWrites = ElectronPort<'cancelBrowserPlan' | 'confirmBrowserExecution'>
/** 「開いてログイン」: the site's window on this computer. */
export type BrowserSiteWindow = ElectronPort<'openBrowserSite'>

export function getBrowserPlan(companyId: string, planId: string, reads: BrowserPlanReads = window.electronAPI) {
  return reads.getBrowserPlan(companyId, planId)
}

/** The inbox's rows: the member's own open plans and unsettled runs (empty while the switch is off on this PC). */
export function listBrowserPlans(companyId: string, reads: BrowserPlanReads = window.electronAPI) {
  return reads.listBrowserPlans(companyId)
}

export function runBrowserPlan(companyId: string, planId: string, contentHash: string, outbound: BrowserPlanOutbound = window.electronAPI) {
  return outbound.runBrowserPlan(companyId, planId, contentHash)
}

export function cancelBrowserPlan(companyId: string, planId: string, writes: BrowserPlanWrites = window.electronAPI) {
  return writes.cancelBrowserPlan(companyId, planId)
}

export function confirmBrowserExecution(companyId: string, executionId: string, result: BrowserConfirmResult, writes: BrowserPlanWrites = window.electronAPI) {
  return writes.confirmBrowserExecution(companyId, executionId, result)
}

export function openBrowserSite(companyId: string, host: string, site: BrowserSiteWindow = window.electronAPI) {
  return site.openBrowserSite(companyId, host)
}

/** Reading an inspection's card main holds in memory for the signed-in member (`browserLines:card`). */
export type BrowserInspectionReads = ElectronPort<'getBrowserInspection'>

export function getBrowserInspection(companyId: string, planId: string, reads: BrowserInspectionReads = window.electronAPI) {
  return reads.getBrowserInspection(companyId, planId)
}

/** Reading a write card main holds in memory for the signed-in member (`browserLines:writeCard`). */
export type BrowserWriteReads = ElectronPort<'getBrowserWriteCard'>
/** ［確かめた］ (a person's value) and ［済んでいた］［されていなかった］: the member's own answers. */
export type BrowserWriteAnswers = ElectronPort<'confirmBrowserWriteValue' | 'confirmBrowserWrite' | 'allowBrowserWrite'>
/** ［そのまま進める］／［やめる］ on a stopped card: its fixed answer, kept in main (agent-browser.md "The stopped card's answer"). */
export type BrowserStopDecisions = ElectronPort<'decideBrowserStop'>
/** ［任せる］: the app writes the plan to the site; ［やめる］ (a write run's card): it does not. */
export type BrowserWriteOutbound = ElectronPort<'runBrowserWrite' | 'cancelBrowserWrite'>

export function getBrowserWriteCard(companyId: string, cardId: string, reads: BrowserWriteReads = window.electronAPI) {
  return reads.getBrowserWriteCard(companyId, cardId)
}

export function confirmBrowserWriteValue(companyId: string, cardId: string, name: string, answers: BrowserWriteAnswers = window.electronAPI) {
  return answers.confirmBrowserWriteValue(companyId, cardId, name)
}

export function confirmBrowserWrite(companyId: string, cardId: string, result: 'done' | 'not_done', answers: BrowserWriteAnswers = window.electronAPI) {
  return answers.confirmBrowserWrite(companyId, cardId, result)
}

/** ［書いてよい］／［書かない］ about a write outside the run's promise (agent-browser.md "The run's promise"). */
export function allowBrowserWrite(companyId: string, cardId: string, allow: boolean, answers: BrowserWriteAnswers = window.electronAPI) {
  return answers.allowBrowserWrite(companyId, cardId, allow)
}

export function decideBrowserStop(companyId: string, cardId: string, choice: 'proceed' | 'stop', decisions: BrowserStopDecisions = window.electronAPI) {
  return decisions.decideBrowserStop(companyId, cardId, choice)
}

export function runBrowserWrite(companyId: string, cardId: string, contentHash: string, outbound: BrowserWriteOutbound = window.electronAPI) {
  return outbound.runBrowserWrite(companyId, cardId, contentHash)
}

export function cancelBrowserWrite(companyId: string, cardId: string, outbound: BrowserWriteOutbound = window.electronAPI) {
  return outbound.cancelBrowserWrite(companyId, cardId)
}

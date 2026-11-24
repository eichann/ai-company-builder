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

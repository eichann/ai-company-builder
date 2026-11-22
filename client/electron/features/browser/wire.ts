// 「ブラウザ操作」's plans wired together (agent-browser.md "The card, the IPC and the request tool"): the
// server's HTTP client, the context, this build's combination, the runner (6b-2c) behind the card's
// ［任せる］, the card's IPC and the request tool's factory. No Electron: main.ts hands in the window
// controller, the policy store's reads, the session and the bundled connectors. Everything that reads
// a site, starts the operator or sends asks the build's switch first (off in 6b); the card's reads,
// ［やめる］ and the confirm do not (clean-up paths).
import path from 'node:path'
import type { IpcInvokeEvent, IpcMessageEvent, IpcRegistrar } from '../../ipc/registrar'
import type { BrowserSiteSetting } from '../../../../shared/core/browser-operation'
import { createBrowserCheckerRegistry, createBrowserConnectors, parseBrowserDeclaration } from '../../../shared/browser-checkers'
import { stoppedBeforeSending, type BrowserChecker, type BrowserPreviewReader, type BrowserPreviewSurface, type BrowserRunSurface } from '../../../shared/browser-runner'
import carried from '../../../../shared/browser-connectors/carried.json'
import { buildAiSwitch, type BrowserAiSwitch } from './ai-switch'
import { createCarriedCombinations } from './combination'
import { createBrowserContext } from './context'
import { parseBrowserHtml } from './html'
import { createBrowserPlansHttp } from './plans-api'
import { browserCardReadiness, registerBrowserPlansIpc } from './plans-ipc'
import { runBrowserPreview, type PreviewOperator } from './preview'
import { registerBrowserPlan, type BrowserRegistrationResult } from './register'
import { createBrowserRunRecords } from './run-records'
import { createBrowserRunner } from './runner'
import type { BrowserOperatorRequest } from '../../../shared/browser-operator'

export interface BrowserPlansWireDeps<E> {
  aiSwitch?: BrowserAiSwitch
  fromMainWindow: (event: E) => boolean
  baseUrl: () => string
  cookies: () => string[]
  userId: () => string | null
  userDataDir: () => string
  /** The window controller's reads (controller.ts). */
  windows: {
    siteNow(companyId: string, host: string): BrowserSiteSetting | null
    runWindow(companyId: string, host: string): BrowserRunSurface | null
    previewWindow(companyId: string, host: string): BrowserPreviewSurface | null
  }
  /** `browserAiStopped(policy.stop(companyId))`. */
  stopped(companyId: string): boolean
  /** The connectors this build bundles (client/connectors/, handed in by main.ts only). */
  connectors: { declarations: readonly string[]; checkers: readonly BrowserChecker[]; readers: readonly BrowserPreviewReader[] }
  /** The member's agent's operator (`browserOperatorOf`), its CLI and the app's environment. */
  operator(): PreviewOperator | null
  cliPath(): string
  parentEnv(): Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  log?: Pick<Console, 'warn'>
}

export function wireBrowserPlans<E extends IpcInvokeEvent>(ipc: IpcRegistrar<E, IpcMessageEvent>, deps: BrowserPlansWireDeps<E>) {
  const aiSwitch = deps.aiSwitch ?? buildAiSwitch
  const http = createBrowserPlansHttp({ baseUrl: deps.baseUrl, cookies: deps.cookies, fetch: deps.fetch })
  const context = createBrowserContext({ userId: deps.userId })
  const connector = createBrowserConnectors(deps.connectors.declarations)
  const combination = createCarriedCombinations(carried, deps.connectors.declarations)
  const checkers = createBrowserCheckerRegistry(deps.connectors.checkers)
  const readers = new Map(deps.connectors.readers.map(r => [r.id, r]))
  const records = createBrowserRunRecords(path.join(deps.userDataDir(), 'browser-runs', 'records.json'), deps.log)
  const now = () => Date.now()

  const runner = createBrowserRunner({
    aiSwitch, plans: http, connector, combination,
    checker: id => checkers.get(id), reader: id => readers.get(id),
    site: deps.windows.siteNow, stopped: deps.stopped,
    window: (companyId, host) => {
      const run = deps.windows.runWindow(companyId, host)
      const preview = deps.windows.previewWindow(companyId, host)
      return run && preview ? { run, preview } : null
    },
    parse: parseBrowserHtml,
    // The card's press has no conversation: the sign-in, the company's setting and quitting decide.
    context: () => context.capture({ companyId: '' }),
    records, now, log: deps.log,
  })

  registerBrowserPlansIpc(ipc, {
    fromMainWindow: deps.fromMainWindow,
    plans: http,
    runner,
    readiness: (companyId, plan) => browserCardReadiness(companyId, plan, {
      aiSwitch, connector, checker: id => checkers.get(id), site: deps.windows.siteNow, stopped: deps.stopped, window: deps.windows.previewWindow,
    }),
    stoppedHere: planId => stoppedBeforeSending(records.all(), planId),
    siteHost: (id, version) => connector(id, version)?.host ?? null,
  })

  /** The version of a connector this build bundles (one per id), or null. */
  const bundledVersion = (id: string): string | null => {
    const versions = deps.connectors.declarations.map(parseBrowserDeclaration).filter(d => d?.id === id).map(d => d!.version)
    return versions.length === 1 ? versions[0] : null
  }

  /** One request of the consultation AI → a plan (or why not). Off: nothing read, started or sent. */
  async function request(input: {
    companyId: string; conversationId: string | null; site: string; operation: string
    hints: BrowserOperatorRequest; signal: AbortSignal
  }): Promise<BrowserRegistrationResult> {
    if (!aiSwitch()) return { outcome: 'not-made', why: 'off' }
    const version = bundledVersion(input.site)
    if (!version) return { outcome: 'not-made', why: 'notAllowed' }
    return registerBrowserPlan({
      companyId: input.companyId, conversationId: input.conversationId, connector: { id: input.site, version },
      operation: input.operation, hints: input.hints, signal: input.signal,
    }, {
      aiSwitch,
      preview: (req, stillCurrent) => runBrowserPreview(req, {
        aiSwitch, connector, reader: id => readers.get(id), site: deps.windows.siteNow, stopped: deps.stopped,
        window: deps.windows.previewWindow, operator: deps.operator, cliPath: deps.cliPath, parentEnv: deps.parentEnv,
        parse: parseBrowserHtml, stillCurrent, now,
      }),
      connector, combination, checker: id => checkers.get(id), reader: id => readers.get(id),
      window: deps.windows.previewWindow, parse: parseBrowserHtml, plans: http, stopped: deps.stopped,
      context: scope => context.capture(scope), now, log: deps.log,
    })
  }

  return {
    context,
    /** Whether the request tool may exist at all (the build's switch). */
    requestAvailable: () => aiSwitch(),
    request,
  }
}

export type BrowserPlansWiring = ReturnType<typeof wireBrowserPlans>

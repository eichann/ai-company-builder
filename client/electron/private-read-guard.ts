/**
 * Private content → public places (permission plan §1.3 D5).
 *
 * A member who may read a private folder has an AI that may read it too —
 * that is correct, and the server cannot tell a legitimate summary from a
 * leak (it is the same as the member copying a file by hand). What the app
 * can do is notice, per conversation, that the AI has READ something inside
 * a private folder, and from then on ask the member before the AI writes
 * into a public place of the company, or sends anything out (web, MCP).
 *
 * Multi-layered, never complete: a write through Bash that this file cannot
 * parse, a read through a script, or a conversation resumed after the app
 * restarted (the tracking lives in memory, re-seeded from the visible tool
 * calls of the conversation) can slip past. The server keeps the private
 * folder's contents out of the company repository either way (RESERVED_PATH);
 * this guard is about copies the member did not intend.
 *
 * Pure (no Electron): the hooks in agents/claude.ts and chat-server.ts feed
 * it tool calls and results; tests drive it directly.
 */
import { foldAsciiCase, repoRelativePath } from '../shared/write-access'
import { excludedFolderOf } from '../shared/sparse-paths'
import { bashWriteTargets } from './write-guard'
import { WEB_RESEARCH_TOOL_ID } from '../shared/web-research'
import { secondOpinionTargetOf } from '../shared/agents/second-opinion'
import { agentShortLabel } from '../shared/agents/registry'

export interface PrivateReadContext {
  /** The company's checkout root (absolute). */
  root: string
  /**
   * Private folders the member may read (company-relative, NFC), read on
   * every call. undefined = unknown (offline, old server): local reads then
   * cannot be recognised, but company_read_file / company_search results
   * still mark the conversation (the server labels them).
   */
  getPrivateFolders: () => readonly string[] | undefined
}

/** What one conversation has read from private folders. */
export interface PrivateReadState {
  /** Private folders (company-relative) the AI read something from, in the order seen. */
  folders: Set<string>
  /** The conversation's earlier tool calls were replayed (seedFromMessages). */
  seeded?: boolean
  /**
   * The kinds of question the member already allowed in this conversation
   * (pressed 許可): that kind is not asked again. Lives as long as the state —
   * in memory, so a conversation reopened after the app restarted asks once more.
   */
  consented?: Set<PrivateAskKind>
}

/** What a question is about: a write to a public place, or something sent out. Consent is per kind. */
export type PrivateAskKind = 'write' | 'send'

/** Remember that the member allowed this kind of question for the rest of the conversation. */
export function recordPrivateConsent(state: PrivateReadState, kind: PrivateAskKind): void {
  if (!state.consented) state.consented = new Set()
  state.consented.add(kind)
}

export const createPrivateReadState = (): PrivateReadState => ({ folders: new Set() })

export function hasReadPrivate(state: PrivateReadState | undefined): boolean {
  return !!state && state.folders.size > 0
}

const conversations = new Map<string, PrivateReadState>()

/** The state of one conversation (by the app's session id), created on first use. */
export function privateReadStateFor(appSessionId: string): PrivateReadState {
  let state = conversations.get(appSessionId)
  if (!state) {
    state = createPrivateReadState()
    conversations.set(appSessionId, state)
  }
  return state
}

/** Forget a conversation (new chat / tab closed / history deleted). */
export function forgetPrivateReads(appSessionId: string): void {
  conversations.delete(appSessionId)
}

/** The private folder `target` is in, or null (outside the company, public, or unknown). */
export function privateFolderOfPath(ctx: PrivateReadContext, target: string, cwd?: string): string | null {
  const folders = ctx.getPrivateFolders()
  if (!folders || folders.length === 0 || !target) return null
  const rel = repoRelativePath(ctx.root, target, cwd)
  if (rel === null || rel === '') return null
  return excludedFolderOf(folders, rel)
}

const READ_TOOLS: Record<string, string> = { Read: 'file_path', View: 'file_path', NotebookRead: 'notebook_path' }

/**
 * Note a tool call BEFORE it runs: reading a file inside a private folder,
 * or a shell command that names one (or runs inside one). Conservative —
 * marking a conversation that then reads nothing only costs a confirmation.
 */
export function noteToolInput(ctx: PrivateReadContext | undefined, state: PrivateReadState, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): void {
  if (!ctx) return
  const key = READ_TOOLS[toolName]
  if (key) {
    const target = toolInput?.[key]
    const folder = typeof target === 'string' ? privateFolderOfPath(ctx, target, cwd) : null
    if (folder) state.folders.add(folder)
    return
  }
  if (toolName === 'Grep') {
    // Content of every file below the searched folder can come back.
    const target = typeof toolInput?.path === 'string' && toolInput.path ? toolInput.path : (cwd ?? ctx.root)
    const inside = privateFolderOfPath(ctx, target, cwd)
    if (inside) state.folders.add(inside)
    return
  }
  if (toolName === 'Bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command : ''
    const inCwd = cwd ? privateFolderOfPath(ctx, cwd) : null
    if (inCwd) state.folders.add(inCwd)
    for (const folder of foldersNamedIn(ctx, command)) state.folders.add(folder)
  }
}

/** Private folders whose path appears in `text` (relative or absolute spelling, NFC/NFD, A–Z folded). */
export function foldersNamedIn(ctx: PrivateReadContext, text: string): string[] {
  const folders = ctx.getPrivateFolders()
  if (!folders || folders.length === 0 || !text) return []
  const hay = text.normalize('NFC').toLowerCase()
  return folders.filter(f => {
    const needle = f.normalize('NFC').toLowerCase()
    // The folder itself, or something inside it — not merely a longer name.
    const at = (from: number): boolean => {
      const i = hay.indexOf(needle, from)
      if (i < 0) return false
      const after = hay[i + needle.length]
      const before = i === 0 ? '' : hay[i - 1]
      const boundaryBefore = before === '' || /[\s/'"`=(:]/.test(before)
      const boundaryAfter = after === undefined || /[\s/'"`;|&)>]/.test(after)
      return (boundaryBefore && boundaryAfter) || at(i + 1)
    }
    return at(0)
  })
}

/** Text of a tool result, whatever shape the SDK hands back. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try { return JSON.stringify(value) } catch { return '' }
}

/**
 * Note a tool RESULT: a Grep or shell command whose output lists a path
 * inside a private folder has put (part of) that file in the conversation.
 */
export function noteToolResult(ctx: PrivateReadContext | undefined, state: PrivateReadState, toolName: string, toolResponse: unknown): void {
  if (!ctx) return
  // Glob lists names only (no content): not marked.
  if (toolName !== 'Grep' && toolName !== 'Bash') return
  for (const folder of foldersNamedIn(ctx, resultText(toolResponse))) state.folders.add(folder)
}

/**
 * Note what the app's read-only company file tools returned
 * (company-files/tools.ts): `company_read_file` labels content from a private
 * folder with `privateFolder`; `company_search` lists the private folders it
 * searched, and a match inside one is private content.
 */
export function noteCompanyFileResult(state: PrivateReadState, toolName: string, output: string): void {
  let data: Record<string, unknown>
  try { data = JSON.parse(output) } catch { return }
  if (!data || typeof data !== 'object' || 'error' in data) return
  if (toolName === 'company_read_file' && typeof data.privateFolder === 'string' && data.privateFolder) {
    state.folders.add(data.privateFolder.normalize('NFC'))
    return
  }
  if (toolName === 'company_search' && data.privateFolders && typeof data.privateFolders === 'object' && Array.isArray(data.matches)) {
    const searched = Object.keys(data.privateFolders as Record<string, unknown>).map(p => p.normalize('NFC'))
    for (const m of data.matches as Array<{ path?: unknown }>) {
      if (typeof m?.path !== 'string') continue
      const folder = excludedFolderOf(searched, m.path)
      if (folder) state.folders.add(folder)
    }
  }
}

/**
 * Replay the tool calls of a conversation the app shows (UI messages), so a
 * conversation reopened after the app restarted is marked again. Only what
 * the UI kept: inputs of local reads, and company file tool outputs.
 */
export function seedFromMessages(ctx: PrivateReadContext | undefined, state: PrivateReadState, messages: unknown, cwd?: string): void {
  if (!Array.isArray(messages)) return
  for (const message of messages as Array<{ parts?: unknown }>) {
    if (!Array.isArray(message?.parts)) continue
    for (const part of message.parts as Array<Record<string, unknown>>) {
      const type = typeof part?.type === 'string' ? part.type : ''
      const toolName = type === 'dynamic-tool' ? String(part.toolName ?? '') : type.startsWith('tool-') ? type.slice(5) : ''
      if (!toolName) continue
      let input = part.input as Record<string, unknown> | undefined
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = undefined } }
      noteToolInput(ctx, state, toolName, input, cwd)
      const company = /^mcp__acb_company_files__(company_\w+)$/.exec(toolName)
      if (company && part.output !== undefined) {
        const out = part.output
        const text = typeof out === 'string' ? out
          : Array.isArray((out as { content?: unknown })?.content)
            ? ((out as { content: Array<{ text?: string }> }).content.map(c => c.text ?? '').join(''))
            : resultText(out)
        noteCompanyFileResult(state, company[1], text)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type PrivateWriteDecision =
  | { ask: false }
  | { ask: true; kind: PrivateAskKind; message: string }

const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/**
 * The app's own MCP servers: never send anything out (acb_review only shows a
 * request to the member; acb_app only lists, closes and reopens the main window's
 * tabs on this computer). Not the web research (`acb_web`): its question goes out
 * to the web.
 */
const APP_MCP_SERVERS = ['acb_company_files', 'acb_consultations', 'acb_review', 'acb_app']

/**
 * Never shared: the app's scratch area, and anything inside a `.personal/`
 * at any depth (sync excludes it, the push checker refuses it as
 * [PERSONAL_PATH]) — except the `.gitignore` directly inside one, which is
 * shared. `rel` is already resolved lexically (`..` applied) and NFC; the
 * folder name is A–Z-folded like the push checker's /\.personal\//i.
 */
function isUnsharedPath(rel: string): boolean {
  const segments = rel.normalize('NFC').split('/')
  if (segments[0] === '.workspace' || segments[0] === '.backups') return true
  const isPersonal = (s: string) => foldAsciiCase(s) === '.personal'
  const last = segments.length - 1
  if (last >= 1 && isPersonal(segments[last - 1]) && foldAsciiCase(segments[last]) === '.gitignore') return false
  return segments.slice(0, -1).some(isPersonal)
}

const PREFIX = 'この会話では非公開フォルダの内容を読んでいます。'

export function publicWriteMessage(place: string): string {
  return `${PREFIX}公開の場所（${place}）に書き込もうとしています。全員に共有されてもよい内容か確認してください。`
}

export function sendOutMessage(what: string): string {
  return `${PREFIX}外部に送信する可能性のある操作（${what}）をしようとしています。非公開の内容が含まれていないか確認してください。`
}

export function webResearchMessage(): string {
  return `${PREFIX}Webで調べるために、AIが書いた質問を外部（検索やWebサイト）に送ろうとしています。質問に非公開の内容が含まれていないか確認してください。`
}

/** 「もう一方の AI に聞く」: the material goes to another company's AI (second-opinion.ts). */
export function otherAiMessage(name: string): string {
  return `${PREFIX}${name}（別の会社の AI）に意見を聞くために、この相談の内容を送ろうとしています。非公開の内容が含まれていないか確認してください。`
}

export function shellWriteMessage(command: string): string {
  return `${PREFIX}このコマンド（${command}）は、会社フォルダの公開の場所に書き込む可能性があります。全員に共有されてもよい内容か確認してください。`
}

/** Added to the member's confirm (not to the AI's refusal): allowing once is enough for this kind. */
export const CONSENT_NOTE = '許可すると、この会話ではこれ以降は確認しません。'

/** The member's confirm for a decision that asks. */
export function privateConfirmMessage(decision: { message: string }): string {
  return `${decision.message}${CONSENT_NOTE}`
}

const short = (command: string) => (command.length > 80 ? `${command.slice(0, 80)}…` : command)

/** A target that is public: inside the company, outside every private folder, and shared. */
function publicPlace(ctx: PrivateReadContext, target: string, cwd?: string): string | null {
  const rel = repoRelativePath(ctx.root, target, cwd)
  if (rel === null) return null // outside the company: not shared by sync
  if (isUnsharedPath(rel)) return null
  const folders = ctx.getPrivateFolders() ?? []
  if (rel !== '' && excludedFolderOf(folders, rel)) return null
  return rel === '' ? '会社フォルダのトップ' : rel
}

/** Shell commands that may write files whose targets this file cannot see. */
const SHELL_WRITES = /(^|[\s;&|(])(cp|mv|rsync|ditto|install|ln|tar|zip|unzip|sed\s+-i|perl\s+-[a-z]*i|git\s+(add|commit|push|mv|apply|am|stash\s+pop)|python3?|node|ruby|osascript)(\s|$)/
/** Shell commands that can send data off the machine. */
const SHELL_SENDS = /(^|[\s;&|(])(curl|wget|nc|ncat|scp|sftp|ssh|ftp|telnet|open)(\s|$)/
/** Commands that run a heredoc's body as code (its body is then commands, not data). */
const RUNS_BODY = /(^|[\s;&|(])(bash|sh|zsh|dash|ksh|fish|python3?|node|deno|bun|ruby|perl|php|osascript|swift|source|\.|eval|xargs|ssh)(\s|$)/

/**
 * A command split around its heredoc: `scan` is what may contain commands
 * (the first line, plus what follows the terminator), `tail` is what follows
 * the first line that bashWriteTargets does not parse. The body of a single
 * heredoc fed to a data sink (`cat > .personal/x.md <<'EOF'`) is text, not
 * commands: words in it must not trigger a question. Anything this cannot
 * read (two heredocs, no terminator, an interpreter) keeps the body.
 */
function splitHeredoc(command: string): { scan: string; tail: string } {
  const newline = command.indexOf('\n')
  if (newline < 0) return { scan: command, tail: '' }
  const first = command.slice(0, newline)
  const rest = command.slice(newline + 1)
  const heredocs = first.match(/(?<!<)<<(?!<)/g) ?? []
  if (heredocs.length === 0) return { scan: command, tail: '' } // bashWriteTargets parses every line
  const m = /(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(first)
  if (!m || heredocs.length > 1 || RUNS_BODY.test(first)) return { scan: command, tail: rest }
  const lines = rest.split('\n')
  const end = lines.findIndex(l => (m[1] ? l.replace(/^\t+/, '') : l) === m[3])
  if (end < 0) return { scan: command, tail: rest }
  const after = lines.slice(end + 1).join('\n')
  return { scan: after ? `${first}\n${after}` : first, tail: after }
}

/** A redirect to a file, or tee, in shell text (fd duplications and /dev/null aside). */
const writesSomewhere = (text: string) => />/.test(text.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '')) || /(^|[\s;&|(])tee(\s|$)/.test(text)

/**
 * After the conversation read private content: ask before a write to a
 * public place of the company, and before anything that may send data out.
 * Before that (or with no context), never asks.
 */
export function decidePrivateWrite(ctx: PrivateReadContext | undefined, state: PrivateReadState | undefined, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): PrivateWriteDecision {
  if (!ctx || !state || !hasReadPrivate(state)) return { ask: false }
  const decision = askFor(ctx, toolName, toolInput, cwd)
  // The member already allowed this kind in this conversation.
  if (decision.ask && state.consented?.has(decision.kind)) return { ask: false }
  return decision
}

const askWrite = (message: string): PrivateWriteDecision => ({ ask: true, kind: 'write', message })
const askSend = (message: string): PrivateWriteDecision => ({ ask: true, kind: 'send', message })

function askFor(ctx: PrivateReadContext, toolName: string, toolInput: Record<string, unknown> | undefined, cwd?: string): PrivateWriteDecision {
  const key = FILE_TOOLS[toolName]
  if (key) {
    const target = toolInput?.[key]
    if (typeof target !== 'string' || !target) return { ask: false }
    const place = publicPlace(ctx, target, cwd)
    return place === null ? { ask: false } : askWrite(publicWriteMessage(place))
  }
  if (toolName === 'Bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command : ''
    const { scan, tail } = splitHeredoc(command)
    if (SHELL_SENDS.test(scan)) return askSend(sendOutMessage(short(command)))
    for (const target of bashWriteTargets(command)) {
      const place = publicPlace(ctx, target, cwd)
      if (place !== null) return askWrite(publicWriteMessage(place))
    }
    // Targets this file cannot see (cp, mv, scripts, a redirect after cd or
    // after a heredoc…): may land anywhere in the company. Literal targets
    // that are all inside .personal/ (or another unshared place) ask nothing.
    const changesDir = /(^|[\s;&|(])(cd|pushd)(\s|$)/.test(scan)
    if (SHELL_WRITES.test(scan) || (changesDir && writesSomewhere(scan)) || writesSomewhere(tail)) return askWrite(shellWriteMessage(short(command)))
    return { ask: false }
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const what = typeof toolInput?.url === 'string' ? `${toolName}: ${toolInput.url}` : typeof toolInput?.query === 'string' ? `${toolName}: ${toolInput.query}` : toolName
    return askSend(sendOutMessage(what))
  }
  if (toolName === WEB_RESEARCH_TOOL_ID) return askSend(webResearchMessage())
  const otherAi = secondOpinionTargetOf(toolName)
  if (otherAi) return askSend(otherAiMessage(agentShortLabel(otherAi)))
  const mcp = /^mcp__(.+?)__/.exec(toolName)
  if (mcp && !APP_MCP_SERVERS.includes(mcp[1])) return askSend(sendOutMessage(toolName))
  return { ask: false }
}

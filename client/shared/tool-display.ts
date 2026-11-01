/**
 * How a tool call reads in the chat, in plain Japanese (chat-ui-and-history.md
 * 「Tool rows」). Pure: used by the main process, which labels each call of a turn
 * as it streams (`electron/tool-display-stream.ts`), and by the renderer, which
 * draws the rows and labels calls that carry no label (built-in tools before
 * their input is complete, restored history).
 *
 * The app's own tools (ACB) declare their `ToolDisplay` next to their definition
 * (records/tools.ts, the tool providers, company-files, consultations, review,
 * web-research); `client/tests/tool-display.test.ts` fails when one lacks it.
 * Built-in agent tools (Claude Code, Codex, api-key mode) are labelled here.
 * Anything else is a member's own tool: 「道具を使いました（server・tool）」, muted.
 */

export interface ToolDisplay {
  /** Finished: 「決めたことを残しました」. */
  label: string
  /** Still running: 「決めたことを残しています」. */
  running: string
  /** Several in a row, `{n}` is the count: 「決めたことを {n} 件残しました」. */
  many?: string
  /**
   * A short detail from the call's input (「研修対象を営業部全体に…」, 「宛先 2 人」).
   * Never secrets, tokens, command text or file contents; keep it to a title, a count
   * or a company-relative path. `toolLineOf` truncates and redacts what it returns.
   */
  describe?: (input: Record<string, unknown>, context: ToolDisplayContext) => string | undefined
}

export interface ToolDisplayContext {
  /** The company folder: absolute paths inside it are shown relative to it. */
  root?: string
}

/** What a row shows; plain data so it can ride on the stream (`callProviderMetadata.acb.display`). */
export interface ToolLine {
  label: string
  running: string
  many: string
  detail?: string
  /** A tool the app does not know (a member's own MCP server): drawn muted. */
  muted?: boolean
}

/** Where the main process puts a call's line on the tool part. */
export const TOOL_LINE_METADATA_KEY = 'acb'

export const DETAIL_MAX = 40

const SECRET_RE = /\b(?:sk|pk|rk|ghp|gho|xox[abpr]|AKIA|AIza|ya29)[-_.A-Za-z0-9]{8,}|[A-Za-z0-9+/_-]{32,}={0,2}|\b(?:bearer|token|password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi

/** One line, without anything that looks like a key or a token, at most `max` characters. */
export function shortText(value: unknown, max = DETAIL_MAX): string {
  if (typeof value !== 'string') return ''
  const line = value.replace(/\s+/g, ' ').trim().replace(SECRET_RE, '••••')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A path relative to the company folder; a path outside it shows only its file name. */
export function companyPath(value: unknown, root?: string): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const path = value.trim().replace(/\\/g, '/')
  const base = root?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) return path.replace(/^\.\//, '')
  return path.split('/').filter(Boolean).pop() ?? ''
}

/** How many items a list argument has (0 when it is not a list). */
export function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

const fileDetail = (input: Record<string, unknown>, ctx: ToolDisplayContext) =>
  companyPath(input.file_path ?? input.notebook_path ?? input.path, ctx.root)

/** Built-in tools of the agents (Claude Code, Codex, the api-key mode's local tools). */
const BUILTIN: Record<string, ToolDisplay> = {
  Read: { label: 'ファイルを読みました', running: 'ファイルを読んでいます', many: 'ファイルを {n} 件読みました', describe: fileDetail },
  NotebookRead: { label: 'ファイルを読みました', running: 'ファイルを読んでいます', many: 'ファイルを {n} 件読みました', describe: fileDetail },
  readFile: { label: 'ファイルを読みました', running: 'ファイルを読んでいます', many: 'ファイルを {n} 件読みました', describe: fileDetail },
  readSkillFile: { label: 'スキルのファイルを読みました', running: 'スキルのファイルを読んでいます', many: 'スキルのファイルを {n} 件読みました', describe: fileDetail },
  Write: {
    label: 'ファイルに書きました', running: 'ファイルに書いています', many: 'ファイルに {n} 回書きました',
    // Codex reports a file change as one item with its changed files.
    describe: (input, ctx) => fileDetail(input, ctx) || companyPath((Array.isArray(input.changes) ? input.changes[0] as { path?: unknown } | undefined : undefined)?.path, ctx.root),
  },
  writeFile: { label: 'ファイルに書きました', running: 'ファイルに書いています', many: 'ファイルに {n} 回書きました', describe: fileDetail },
  Edit: { label: 'ファイルを直しました', running: 'ファイルを直しています', many: 'ファイルを {n} 回直しました', describe: fileDetail },
  MultiEdit: { label: 'ファイルを直しました', running: 'ファイルを直しています', many: 'ファイルを {n} 回直しました', describe: fileDetail },
  NotebookEdit: { label: 'ファイルを直しました', running: 'ファイルを直しています', many: 'ファイルを {n} 回直しました', describe: fileDetail },
  Glob: { label: 'ファイルを探しました', running: 'ファイルを探しています', many: 'ファイルを {n} 回探しました', describe: input => shortText(input.pattern) },
  LS: { label: 'フォルダの中を見ました', running: 'フォルダの中を見ています', many: 'フォルダの中を {n} 回見ました', describe: fileDetail },
  listDirectory: { label: 'フォルダの中を見ました', running: 'フォルダの中を見ています', many: 'フォルダの中を {n} 回見ました', describe: fileDetail },
  Grep: { label: '検索しました', running: '検索しています', many: '{n} 回検索しました', describe: input => shortText(input.pattern) },
  // Command text can carry keys and paths of any kind: only Claude Code's own one-line description is shown.
  Bash: { label: 'コマンドを実行しました', running: 'コマンドを実行しています', many: 'コマンドを {n} 回実行しました', describe: input => shortText(input.description) },
  executeCommand: { label: 'コマンドを実行しました', running: 'コマンドを実行しています', many: 'コマンドを {n} 回実行しました' },
  BashOutput: { label: 'コマンドの結果を見ました', running: 'コマンドの結果を見ています', many: 'コマンドの結果を {n} 回見ました' },
  KillShell: { label: 'コマンドを止めました', running: 'コマンドを止めています', many: 'コマンドを {n} 件止めました' },
  KillBash: { label: 'コマンドを止めました', running: 'コマンドを止めています', many: 'コマンドを {n} 件止めました' },
  WebSearch: { label: 'Webで検索しました', running: 'Webで検索しています', many: 'Webで {n} 回検索しました', describe: input => shortText(input.query) },
  WebFetch: {
    label: 'Webのページを読みました', running: 'Webのページを読んでいます', many: 'Webのページを {n} 件読みました',
    describe: input => { try { return typeof input.url === 'string' ? new URL(input.url).hostname : undefined } catch { return undefined } },
  },
  Task: { label: '手分けして作業しました', running: '手分けして作業しています', many: '{n} 件の作業を手分けしました', describe: input => shortText(input.description) },
  Agent: { label: '手分けして作業しました', running: '手分けして作業しています', many: '{n} 件の作業を手分けしました', describe: input => shortText(input.description) },
  TodoWrite: { label: '作業の段取りを立てました', running: '作業の段取りを立てています', many: '作業の段取りを {n} 回立てました' },
  Skill: { label: 'スキルを使いました', running: 'スキルを使っています', many: 'スキルを {n} 回使いました', describe: input => shortText(input.skill ?? input.command) },
  SlashCommand: { label: 'スキルを使いました', running: 'スキルを使っています', many: 'スキルを {n} 回使いました', describe: input => shortText(input.command) },
  AskUserQuestion: { label: '質問しました', running: '質問しています', many: '{n} 回質問しました' },
  ExitPlanMode: { label: '進め方をまとめました', running: '進め方をまとめています', many: '進め方を {n} 回まとめました' },
  ToolSearch: { label: '使える道具を調べました', running: '使える道具を調べています', many: '使える道具を {n} 回調べました' },
}

export function builtinToolDisplay(toolName: string): ToolDisplay | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN, toolName) ? BUILTIN[toolName] : undefined
}

function parsedInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try { const value = JSON.parse(input); return value && typeof value === 'object' ? value : {} } catch { return {} }
  }
  return input && typeof input === 'object' ? input as Record<string, unknown> : {}
}

/** `mcp__<server>__<tool>` (or Codex's generic `MCP` call with `server` / `tool` in its input). */
function mcpParts(toolName: string, input: Record<string, unknown>): [string, string] | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (m) return [m[1], m[2]]
  if (toolName === 'MCP' && typeof input.server === 'string' && typeof input.tool === 'string') return [input.server, input.tool]
  return undefined
}

/**
 * A call's line: its declared display (ACB tools, passed in by whoever knows the
 * definition), else the built-in one, else the muted 「道具を使いました」.
 */
export function toolLineOf(toolName: string, rawInput: unknown, display?: ToolDisplay, context: ToolDisplayContext = {}): ToolLine {
  const input = parsedInput(rawInput)
  const known = display ?? builtinToolDisplay(toolName)
  if (known) {
    let detail: string | undefined
    try { detail = shortText(known.describe?.(input, context) ?? '') || undefined } catch { detail = undefined }
    return { label: known.label, running: known.running, many: known.many ?? `${known.label}（{n} 回）`, ...(detail ? { detail } : {}) }
  }
  const mcp = mcpParts(toolName, input)
  const who = mcp ? `${shortText(mcp[0], 30)}・${shortText(mcp[1], 30)}` : shortText(toolName, 40)
  return { label: `道具を使いました（${who}）`, running: `道具を使っています（${who}）`, many: `道具を {n} 回使いました（${who}）`, muted: true }
}

/** The collapsed line of `n` identical calls. */
export function manyLine(line: ToolLine, n: number): string {
  return line.many.replace('{n}', String(n))
}

/** A line from the stream, if the part carries a well-formed one. */
export function readToolLine(metadata: unknown): ToolLine | undefined {
  const value = (metadata as Record<string, { display?: unknown } | undefined> | undefined)?.[TOOL_LINE_METADATA_KEY]?.display as Partial<ToolLine> | undefined
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.label !== 'string' || typeof value.running !== 'string' || typeof value.many !== 'string') return undefined
  return {
    label: value.label, running: value.running, many: value.many,
    ...(typeof value.detail === 'string' && value.detail ? { detail: value.detail } : {}),
    ...(value.muted === true ? { muted: true } : {}),
  }
}

/**
 * A tool call of a restored conversation. History keeps a call only as its `\n[Tool: name]`
 * marker in `content` (the hand-off's fingerprints compare that text), plus `toolLines`: the
 * label of each tool the app cannot name by itself (ACB tools), never a detail. Restoring turns
 * each marker into this part, so the row reads like a live one.
 */
export const RESTORED_TOOL_PART_TYPE = 'data-tool-call'
export const TOOL_MARKER_RE = /\n\[Tool: ([^\]\n]{1,200})\]/g

export interface StoredToolLine { label: string; many: string }

/** What history keeps for a line: label and count template only (no detail), or nothing for a tool named here. */
export function storedToolLine(toolName: string, line: ToolLine): StoredToolLine | undefined {
  if (line.muted || builtinToolDisplay(toolName)) return undefined
  return { label: shortText(line.label, 80), many: shortText(line.many, 80) }
}

/** The line of a restored call: the built-in one, the stored one, else the muted 「道具を使いました」. */
export function restoredToolLine(toolName: string, stored: unknown): ToolLine {
  if (builtinToolDisplay(toolName)) return toolLineOf(toolName, {})
  const value = stored as Partial<StoredToolLine> | undefined
  if (value && typeof value.label === 'string' && value.label && typeof value.many === 'string' && value.many.includes('{n}')) {
    return { label: value.label, running: value.label, many: value.many }
  }
  return toolLineOf(toolName, {})
}

const JAPANESE_RE =/[぀-ヿ㐀-鿿]/

/**
 * Why a call did not work, as the member reads it: the app's own refusal sentence
 * (Japanese text in an error output, `{ error: '…' }`), never a raw message in
 * English or a stack. Undefined when the call worked.
 */
export function failureOf(state: string, errorText: string | undefined, output: unknown): { reason?: string } | undefined {
  if (state === 'output-error') return { reason: plainReason(errorText) }
  if (state === 'output-denied') return { reason: '許可されませんでした' }
  const refused = refusalIn(output)
  return refused ? { reason: refused } : undefined
}

function plainReason(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const first = text.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return JAPANESE_RE.test(first) ? shortText(first, 80) : undefined
}

/** The ACB tools answer a refusal as `{"error":"…"}` text (records/tools.ts), possibly inside MCP content. */
function refusalIn(output: unknown): string | undefined {
  const texts: string[] = []
  if (typeof output === 'string') texts.push(output)
  else if (Array.isArray(output)) for (const item of output) { if (typeof (item as { text?: unknown })?.text === 'string') texts.push((item as { text: string }).text) }
  else if (output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)) return refusalIn((output as { content: unknown[] }).content)
  for (const text of texts) {
    if (!text.trimStart().startsWith('{"error"')) continue
    try {
      const reason = plainReason((JSON.parse(text) as { error?: unknown }).error)
      if (reason) return reason
    } catch { /* not a refusal */ }
  }
  return undefined
}

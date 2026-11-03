/**
 * Consultations centre on the task (owner decision 2026-11-03, tasks-ui.md "Consultations centre on
 * the task"):
 *   - a task the AI makes in a consultation without a topic becomes its topic (`topicAfterTaskMade`),
 *     unless the member took a topic off (`topicDetached`: no more automatic topics);
 *   - in a consultation about a task, files the AI newly creates in the company folder are linked to
 *     it (`newFilesOfCall` decides which of a tool call's files are new and may be linked);
 *   - a task only the member sees: the AI is told to put new files in the member's 今日のフォルダ.
 * Pure: main, the renderer and tests use it.
 */
import type { ChatSession } from './chat-history'
import { describePath, type TargetContext } from './agent-events'
import { RECORD_ID_RE } from '../../shared/core/records'

/** The chat part that says a new file was linked: `{ path, title }` (stored with the reply). */
export const FILE_LINKED_PART_TYPE = 'data-file-linked'
export interface FileLinkedPart { path: string; title: string }

/** A stored part as it comes back (anything else is dropped). */
export function readFileLinkedPart(value: unknown): FileLinkedPart | null {
  const v = value as Partial<FileLinkedPart> | null
  return v && typeof v.path === 'string' && v.path && v.path.length <= 1000 && typeof v.title === 'string' && v.title.length <= 300 ? { path: v.path, title: v.title } : null
}

/** 「『見積メモ.md』をやること「…」につなぎました」 */
export function fileLinkedLine(part: FileLinkedPart): string {
  return `『${part.path.split('/').pop() || part.path}』をやること「${part.title}」につなぎました`
}

type TopicState = Pick<ChatSession, 'topicRecordId' | 'topicDetached'>

/** The consultation's topic when it is a task (its id), else null. */
export function taskTopicOf(session: TopicState | null | undefined): string | null {
  const id = session?.topicRecordId
  return typeof id === 'string' && id.startsWith('task-') && RECORD_ID_RE.test(id) ? id : null
}

/**
 * A record the AI just made in this consultation: the topic it now gets (its id), or null — only a
 * task, only while the consultation has no topic and the member never took one off.
 */
export function topicAfterTaskMade(session: TopicState | null | undefined, made: { id: unknown; type: unknown }): string | null {
  if (!session || session.topicRecordId || session.topicDetached) return null
  if (made.type !== 'task' || typeof made.id !== 'string' || !made.id.startsWith('task-') || !RECORD_ID_RE.test(made.id)) return null
  return made.id
}

/** Never linked: the app's scratch and backups, git's own files, the app's temporary save files. */
function linkable(companyPath: string): boolean {
  const segments = companyPath.split('/')
  if (segments[0] === '.workspace' || segments[0] === '.backups') return false
  if (segments.some(s => s.toLowerCase() === '.git')) return false
  return !/\.acb-tmp-/.test(segments[segments.length - 1] ?? '')
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** `cd <literal folder> && …` (how the AI often starts a command): the folder and the rest; else the command as is. */
function leadingCd(command: string): { dir?: string; rest: string } {
  const m = /^\s*cd\s+(?:"([^"$`\\]+)"|'([^']+)'|([^\s"'$`\\;&|<>()*?{}~]+))\s*&&\s*/.exec(command)
  return m ? { dir: m[1] ?? m[2] ?? m[3], rest: command.slice(m[0].length) } : { rest: command }
}

/**
 * The company files a write call is about to create (checked before it runs): Claude's / the API
 * key's `Write` / `writeFile` of a path where nothing is (`exists`), a shell command's literal
 * redirect / `tee` target where nothing is (`shellTargets`: the write guard's own reading, e.g.
 * `cat > メモ.md <<'EOF'` — the AI often writes files this way), Codex's file change of kind `add`.
 * An edit of a file that exists, Edit / MultiEdit, a path outside the company folder and the app's
 * scratch are never new; what a script or `cp` writes is not read.
 */
export function newFilesOfCall(call: { tool: string; input?: unknown; cwd?: string }, ctx: TargetContext, exists: (absPath: string) => boolean, shellTargets?: (command: string) => string[]): string[] {
  const input = record(call.input)
  const at = { ...ctx, cwd: call.cwd || ctx.cwd }
  const shell = (call.tool === 'Bash' || call.tool === 'executeCommand') && typeof input.command === 'string' ? leadingCd(input.command) : null
  if (shell?.dir) at.cwd = shell.dir.startsWith('/') ? shell.dir : `${at.cwd ?? ctx.companyRoot}/${shell.dir}`
  const companyPath = (target: unknown): string | null => {
    if (typeof target !== 'string' || !target) return null
    const d = describePath(target, at)
    return d.kind === 'file' && d.path && linkable(d.path) ? d.path : null
  }
  if (Array.isArray(input.changes)) {
    return input.changes.flatMap(change => {
      const c = record(change)
      const kind = typeof c.kind === 'string' ? c.kind : record(c.kind).type
      const p = kind === 'add' ? companyPath(c.path) : null
      return p ? [p] : []
    })
  }
  if (!ctx.companyRoot) return []
  const targets = call.tool === 'Write' || call.tool === 'writeFile' ? [input.file_path ?? input.path]
    : shell && shellTargets ? shellTargets(shell.rest)
      : []
  const fresh = targets.map(companyPath).filter((p): p is string => !!p && !exists(`${ctx.companyRoot}/${p}`))
  return [...new Set(fresh)]
}

/**
 * What the AI is told in a consultation about a task: new files are linked to it by the app, and for
 * a task only the member sees, new files go to the member's 今日のフォルダ unless the member says where.
 */
export function taskTopicInstructions(task: { id: string; title: string; personal: boolean }, todayFolder: string | null): string {
  const lines = [
    `\n\n【この相談のやること】この相談は、やること「${task.title}」（${task.id}）についての相談です。この相談であなたが会社のフォルダに新しく作ったファイルは、アプリが自動でこのやることにつなぎます（records_link_file を呼ぶ必要はありません）。既にあるファイルを直しても、つながりは増えません。新しいファイルは Write の道具で作ってください（シェルの変数・スクリプト・cp で作ったファイルはアプリが見分けられず、つながりません。そのときは records_link_file でつないでください）。`,
  ]
  if (task.personal && todayFolder) {
    lines.push(`このやることはメンバー本人だけのものです。新しいファイルは、置き場所を言われていなければ、メンバーの今日のフォルダ「${todayFolder}/」に作ってください（メンバーの Mac だけにあり、同期されません。フォルダが無ければ作ってかまいません）。部署のみんなと共有したいと言われたときは、その部署のフォルダに作ってください。`)
  }
  lines.push(`In this consultation about the task "${task.title}" (${task.id}), new files you create in the company folder are linked to it by the app; editing an existing file adds no link. Create new files with the Write tool (a file made through shell variables, scripts or cp is not recognised: link it with records_link_file).` +
    (task.personal && todayFolder ? ` The task is the member's own: unless told where, put new files in the member's today folder "${todayFolder}/" (this Mac only, never synced).` : ''))
  return lines.join('')
}

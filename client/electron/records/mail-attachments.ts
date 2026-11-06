/**
 * A PDF the member's AI attaches to a mail draft (outbound-mail.md "Attachments"): the file a
 * company Skill wrote on this PC, usually under `<department>/.personal/提案書/…` (never synced, so
 * the server cannot read it). Main reads it here, never the AI process: the path must resolve —
 * symbolic links followed — inside the consultation's company folder, name a `.pdf`, hold at most
 * 10 MB and start like a PDF. The bytes then go to the server with the turn's record token; the
 * draft is still not sent (the person opens each file on the card and sends).
 */
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { ATTACHMENT_LIMITS, looksLikePdf, sanitizeAttachmentName } from '../../../shared/core/mail'

export interface MailAttachmentFile {
  /** The file name the mail carries (the path's last segment). */
  name: string
  bytes: Uint8Array
  /** Lower-case hex sha256 of the bytes. */
  sha256: string
}

export type MailAttachmentRead = MailAttachmentFile | { error: string }

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** The file at `input` (relative to the company folder), read once and checked, or why it cannot be attached. */
export function readMailAttachment(input: unknown, companyRoot: string): MailAttachmentRead {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0') || input.trim().startsWith('~')) return { error: 'ファイルの場所が正しくありません。' }
  const root = path.resolve(companyRoot)
  const abs = path.resolve(root, input.trim())
  if (!inside(root, abs)) return { error: '会社フォルダの中のファイルだけを付けられます。' }
  if (path.relative(root, abs).split(path.sep).some(s => s === '.git')) return { error: 'このファイルは付けられません。' }
  let real: string
  let realRoot: string
  try {
    realRoot = fs.realpathSync(root)
    real = fs.realpathSync(abs)
  } catch {
    return { error: 'ファイルが見つかりません。' }
  }
  // A link pointing out of the company folder is not followed out.
  if (!inside(realRoot, real)) return { error: '会社フォルダの外を指すファイル（リンク）は付けられません。' }
  const name = sanitizeAttachmentName(path.basename(abs))
  if (!name) return { error: '付けられるのは PDF のファイルだけです（名前が「.pdf」で終わるもの）。' }
  let stat: fs.Stats
  try { stat = fs.statSync(real) } catch { return { error: 'ファイルが見つかりません。' } }
  if (!stat.isFile()) return { error: 'ファイルではありません。' }
  if (stat.size === 0) return { error: 'ファイルが空です。' }
  if (stat.size > ATTACHMENT_LIMITS.totalBytes) return { error: 'ファイルが大きすぎます（10 MB まで）。' }
  let bytes: Uint8Array
  try { bytes = new Uint8Array(fs.readFileSync(real)) } catch { return { error: 'ファイルを読めませんでした。' } }
  // Read once: what was checked is what is sent (the file may have grown since the stat).
  if (bytes.byteLength > ATTACHMENT_LIMITS.totalBytes) return { error: 'ファイルが大きすぎます（10 MB まで）。' }
  if (!looksLikePdf(bytes)) return { error: '中身が PDF ではありません。付けられるのは PDF のファイルだけです。' }
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

// 探す ⌘K's pure logic (the left tab's is `find.ts`).
import type { RecordViewSummary } from '../../../shared/record-views'
import { foldAsciiCase } from '../../../../shared/core/paths'
import { thingName, THING_NAMES, type ThingRecord } from '../../../shared/thing-words'

// --- 探す ⌘K: open anything by its name ----------------------------------------------------

/** A tab open in the middle, for 「最近開いたもの」: a file (company path) or a record with its look. */
export type PaletteRecent = { key: string; path: string } | { key: string; recordId: string; record: ThingRecord & { title: string } }

export interface PaletteItem {
  key: string
  title: string
  /** A company path, when it is a file. */
  path?: string
  recordId?: string
  record?: ThingRecord
  /** A skill (its id in the スキル tab's list) or an AI consultation (its conversation id). */
  skillId?: string
  consultationId?: string
  /** One of the screen's own lists (「片づけたタブ」), opened by the screen. */
  actionId?: string
  /** The line under the name: a skill's place (全社, 営業部…). */
  detail?: string
  /** The kind's plain name shown at the right (やること, 案件…). */
  kindName: string
}

/** A skill the member has (the スキル tab's list and the company-wide ones behind slash commands). */
export interface PaletteSkill { id: string; name: string; /** Its folder name, the slash command. */ command: string; group?: string }
/** A list of the screen's own found by its name or other words (「片づけたタブ」: タブ, 片づけ…). */
export interface PaletteAction { id: string; title: string; words: readonly string[] }
/** A consultation in 「AIへの相談」 (this computer's history), titled as the list shows it. */
export interface PaletteConsultation { id: string; title: string }

const MAX_FILES = 30
const MAX_SKILLS = 20
const MAX_CONSULTATIONS = 20

/**
 * What ⌘K lists: with nothing typed, the open tabs (newest first); typed, the records the server
 * found by those words, then the skills (by name or slash command), the consultations (by title)
 * and the files (by path) that hold them, A–Z folded, each kind in its given order and capped.
 */
export function paletteItems(
  query: string, files: readonly string[], records: readonly RecordViewSummary[], recent: readonly PaletteRecent[],
  more: { skills?: readonly PaletteSkill[]; consultations?: readonly PaletteConsultation[]; actions?: readonly PaletteAction[] } = {},
): PaletteItem[] {
  const q = query.trim()
  if (!q) {
    return recent.map(r => 'path' in r
      ? { key: r.key, title: r.path.split('/').pop() ?? r.path, path: r.path, kindName: THING_NAMES.file }
      : { key: r.key, title: r.record.title, recordId: r.recordId, record: r.record, kindName: thingName(r.record) })
  }
  const fold = (t: string) => foldAsciiCase(t.normalize('NFC'))
  const fq = fold(q)
  // The screen's own lists first: few, and named by what the member typed.
  const out: PaletteItem[] = (more.actions ?? [])
    .filter(a => [a.title, ...a.words].some(w => fold(w).includes(fq) || fq.includes(fold(w))))
    .map(a => ({ key: `action:${a.id}`, title: a.title, actionId: a.id, kindName: '一覧' }))
  out.push(...records.map(r => ({
    key: `record:${r.id}`, title: r.title, recordId: r.id, kindName: r.typeLabel,
    record: { type: r.type, typeLabel: r.typeLabel, implements: r.thing === 'bundle' ? ['bundle'] : undefined },
  })))
  const seen = new Set<string>()
  for (const s of more.skills ?? []) {
    if (seen.size >= MAX_SKILLS) break
    if (seen.has(s.id) || !(fold(s.name).includes(fq) || fold(s.command).includes(fq))) continue
    seen.add(s.id)
    out.push({ key: `skill:${s.id}`, title: s.name, skillId: s.id, detail: s.group, kindName: THING_NAMES.skill })
  }
  let c = 0
  for (const s of more.consultations ?? []) {
    if (c >= MAX_CONSULTATIONS) break
    if (fold(s.title).includes(fq)) { out.push({ key: `consultation:${s.id}`, title: s.title, consultationId: s.id, kindName: THING_NAMES.consultation }); c++ }
  }
  let n = 0
  for (const f of files) {
    if (n >= MAX_FILES) break
    if (fold(f).includes(fq)) { out.push({ key: `file:${f}`, title: f.split('/').pop() ?? f, path: f, kindName: THING_NAMES.file }); n++ }
  }
  return out
}

/**
 * Lステップ's preview readers of the JSON lists its own pages read (`explore` in ./declaration.ts,
 * 0.4.0, paginated from 0.5.0; design memo §34–§36, §38, the owner's login, read only). Each turns one answer into its declared
 * field only — an id, with the name as its label (the core cleans it and hands it to the operator as
 * outside text) — and nothing else of the answer. An answer that is not the shape seen on the real
 * site is `complete: false` (with the items it could still take out, or none), never a guess.
 *
 * Shapes seen:
 * - `GET /api/episode-groups` → `{ data: [{ id, name, order, item_count }] }` (no pages): the reminder
 *   folders (`group`).
 * - `GET /api/template-groups` → `{ data: [{ id, name, order, item_count }] }` (no pages): the template
 *   folders (`template_group`). It lists 「未分類」 as `id 0`: **not selectable** (decision, safe side:
 *   every id a plan or a read carries is a positive integer, as everywhere on Lステップ — `0` / `-1`
 *   are never "one item"), so it is left out and the list says it is not whole.
 * - `GET /api/episodes?group=<folder>&page=<n>` → `{ current_page, data, …, last_page, per_page: 50,
 *   total }`, each `{ id, name, order, type, created_at, group_id, group: { id, name, order } }`: the
 *   reminders (`reminder`).
 * - `GET /api/templates?group=<folder>&page=<n>` → the same pages, each `{ id, name, content_text,
 *   created_at, form_type, group: { id, name }, editor_version }`: the templates (`template`).
 * A paginated answer reports where it stands (`current_page`, `last_page`, `total`, each a whole
 * number, as `page`) and nothing more: whether and which page is read next is the app's (preview.ts,
 * the declaration's `pages`), and it is the app that checks the pages fit together. One without those
 * three numbers is incomplete. An entry of a folder list must name the asked folder — every folder id
 * it carries (`group_id`, `group.id`, a plain `group`) equal to it, and at least one —, else it is
 * left out and the read is incomplete (the folder filter may not have applied); checked on every page.
 */
import type { BrowserExploreItem, BrowserJsonExploreReader, BrowserJsonValue, BrowserListPage } from '../../shared/browser-runner'

type JsonObject = { readonly [key: string]: BrowserJsonValue }
const jsonObject = (v: BrowserJsonValue | undefined): JsonObject | null => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null)
/** A field of an object, its own only (the core's parser makes objects without a prototype; this holds anyway). */
const jsonField = (o: JsonObject | null, key: string): BrowserJsonValue | undefined => (o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined)

export const LSTEP_REMINDER_FOLDERS_READER = 'lstep.reminder_folders'
export const LSTEP_REMINDERS_READER = 'lstep.reminders'
export const LSTEP_TEMPLATE_FOLDERS_READER = 'lstep.template_folders'
export const LSTEP_TEMPLATES_READER = 'lstep.templates'

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/

/** An id as the site writes it: a positive integer, as a number or as digits (never 0). */
function idOf(v: BrowserJsonValue | undefined): string | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null
  return typeof v === 'string' && POSITIVE_ID.test(v) ? v : null
}

/** Where a paginated answer stands, as it says it (`current_page`, `last_page`, `total` as plain numbers), or null. */
function pageOf(answer: JsonObject | null): BrowserListPage | null {
  const current = jsonField(answer, 'current_page')
  const last = jsonField(answer, 'last_page')
  const total = jsonField(answer, 'total')
  return typeof current === 'number' && typeof last === 'number' && typeof total === 'number' ? { current, last, total } : null
}

/** Every folder id an entry carries (`group_id`, `group.id`, a plain `group`), as written. */
function foldersOf(entry: JsonObject | null): Array<BrowserJsonValue | undefined> {
  const out: Array<BrowserJsonValue | undefined> = []
  const groupId = jsonField(entry, 'group_id')
  if (groupId !== undefined) out.push(groupId)
  const group = jsonField(entry, 'group')
  if (group !== undefined) out.push(jsonObject(group) ? jsonField(jsonObject(group), 'id') : group)
  return out
}

interface ListRule {
  id: string
  field: string
  /** A paginated list: the answer reports where it stands (the app reads the pages). */
  paginated: boolean
  /** The folder (a `{name}` of the read) every entry must name. */
  folder?: string
}

function listReader(rule: ListRule): BrowserJsonExploreReader {
  return {
    id: rule.id,
    answer: 'json',
    fields: [rule.field],
    extra: [],
    read(values, json) {
      const answer = jsonObject(json)
      const data = jsonField(answer, 'data')
      if (!Array.isArray(data)) return { items: [], complete: false }
      const folder = rule.folder === undefined ? undefined : values[rule.folder]
      if (rule.folder !== undefined && (folder === undefined || !POSITIVE_ID.test(folder))) return { items: [], complete: false }
      const page = rule.paginated ? pageOf(answer) : null
      let complete = rule.paginated ? page !== null : jsonField(answer, 'last_page') === undefined
      const items: BrowserExploreItem[] = []
      for (const entry of data as readonly BrowserJsonValue[]) {
        const o = jsonObject(entry)
        const id = idOf(jsonField(o, 'id'))
        const name = jsonField(o, 'name')
        // A name that is empty once spaces, zero-width and bidi marks are removed cannot tell the entry apart.
        if (!id || typeof name !== 'string' || name.replace(/[\s\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') === '') { complete = false; continue }
        if (folder !== undefined) {
          const named = foldersOf(o)
          if (named.length === 0 || named.some(g => idOf(g) !== folder)) { complete = false; continue }
        }
        items.push({ field: rule.field, value: id, label: name })
      }
      return page ? { items, complete, page } : { items, complete }
    },
  }
}

export function createLstepListReaders(): BrowserJsonExploreReader[] {
  return [
    listReader({ id: LSTEP_REMINDER_FOLDERS_READER, field: 'group', paginated: false }),
    listReader({ id: LSTEP_REMINDERS_READER, field: 'reminder', paginated: true, folder: 'group' }),
    listReader({ id: LSTEP_TEMPLATE_FOLDERS_READER, field: 'template_group', paginated: false }),
    listReader({ id: LSTEP_TEMPLATES_READER, field: 'template', paginated: true, folder: 'template_group' }),
  ]
}

/**
 * 「落とすと、つながります」 (owner decision 2026-11-03: everything can be linked by drag and drop):
 * which link a record, a file or a folder dropped on a record's 「つながっているもの」 (or its list
 * row) becomes. The answer comes from the two types' definitions only — no type is named here:
 * a link of the record dropped on whose target is the dropped thing's type (or an interface it
 * implements), else a link of the dropped record pointing back at it (a やること dropped on a 案件
 * becomes that やること's 案件). Where the record came from (`origin`) is history and never offered;
 * nor is a link held by a record whose links only its service changes. Pure: main decides with it
 * (`tasks:dropLink`), tests import it.
 */
import type { LinkDef, TypeDefinition } from '../../shared/core/record-types'
import { SERVICE_STATE_TYPES } from '../../shared/core/core-types'
import { thingName } from './thing-words'

/** What was dropped: a record (by id), or a company path (a file or a folder). */
/**
 * What was dropped: a record, or a file / folder of the company folder. `local: true` (a company
 * without the shared folder): a file of the member's own working folder, linked as theirs alone
 * (records.md "File links without the shared folder").
 */
export type DroppedThing = { kind: 'record'; id: string } | { kind: 'path'; path: string; local?: true }

/** One way the drop can link: the link `link` held by `source` (the record dropped on, or the one dropped). */
export interface DropLinkChoice {
  source: 'target' | 'dropped'
  link: string
  /** What the choice says when the member picks (「関係するやること」, 「案件」). */
  label: string
}

export type DropLinkPlan =
  | { choices: DropLinkChoice[] }
  /** Nothing fits: one line that says so (「やることには決めたことはつなげません」). */
  | { refused: string }

/** The kind's plain name of a type (やること, 決めたこと, 案件…), as every screen says it. */
export function typeWord(def: Pick<TypeDefinition, 'name' | 'label' | 'implements'> | undefined, type: string): string {
  return thingName({ type, typeLabel: def?.label ?? null, implements: def?.implements ?? [] })
}

const linkTakes = (l: LinkDef, type: string, def: TypeDefinition | undefined): boolean =>
  l.origin !== true && (l.targetIsInterface ? !!def?.implements.includes(l.target) : l.target === type)

/** The link's name in members' words: a link to an interface says the kind it reached (never 「まとまり」). */
function choiceLabel(l: LinkDef, reached: string): string {
  return l.targetIsInterface ? reached : l.label.replace(/タスク/g, 'やること')
}

/** The links a drop may make between `target` (dropped on) and `dropped` (a record, or `file` for a path). */
export function dropLinkPlan(
  target: { type: string; def: TypeDefinition | undefined },
  dropped: { type: string; def: TypeDefinition | undefined } | 'file',
): DropLinkPlan {
  const targetWord = typeWord(target.def, target.type)
  if (dropped === 'file') {
    const files = target.def && !SERVICE_STATE_TYPES.includes(target.type)
      ? Object.entries(target.def.links).filter(([, l]) => l.target === 'file' && l.origin !== true) : []
    return files.length > 0
      ? { choices: files.map(([link, l]) => ({ source: 'target' as const, link, label: l.label })) }
      : { refused: `${targetWord}にはファイルやフォルダはつなげません` }
  }
  const droppedWord = typeWord(dropped.def, dropped.type)
  const out: DropLinkChoice[] = []
  if (target.def && !SERVICE_STATE_TYPES.includes(target.type)) {
    for (const [link, l] of Object.entries(target.def.links)) {
      if (linkTakes(l, dropped.type, dropped.def)) out.push({ source: 'target', link, label: choiceLabel(l, droppedWord) })
    }
  }
  // Only when the record dropped on holds no such link: the dropped record links back to it.
  if (out.length === 0 && dropped.def && !SERVICE_STATE_TYPES.includes(dropped.type)) {
    for (const [link, l] of Object.entries(dropped.def.links)) {
      if (linkTakes(l, target.type, target.def)) out.push({ source: 'dropped', link, label: choiceLabel(l, targetWord) })
    }
  }
  return out.length > 0 ? { choices: out } : { refused: `${targetWord}には${droppedWord}はつなげません` }
}

/** What `tasks:dropLink` answers. */
export type DropLinkResult =
  /** Linked: what to say, and the ledger entry 取り消す reverses (on the record that holds the link). */
  | { success: true; done: { text: string; undo: { recordId: string; version: number } | null } }
  /** Several links fit: the member picks one (`link` of a choice, sent again). */
  | { success: true; choose: DropLinkChoice[]; question: string }
  | { success: false; offline: boolean; error: string }

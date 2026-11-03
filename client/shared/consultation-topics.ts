/**
 * The やること / 案件 an AI consultation is about, for 「AIへの相談」's search and its rows
 * (chat-ui-and-history.md "Searching the list") and for 探す. A consultation keeps one main topic
 * (`topicRecordId`); main reads that record with the member's session (`recordViews:topics`), so a
 * record the member cannot read never arrives here. Pure: main, the renderer and tests use it.
 */
import type { RecordDetail } from '../../shared/types/records'
import type { TypeDefinition } from '../../shared/core/record-types'
import { thingKindOf, thingName, type ThingKind } from './thing-words'

/** A record as a consultation's row shows it: its title and the icon of its kind. */
export interface TopicRecordLook {
  id: string
  title: string
  thing: ThingKind
  /** The type's own label (案件, 企画…): a bundle's picture. */
  typeLabel: string | null
  /** The kind in words (やること, 案件…), read out with the icon. */
  kindName: string
}

/**
 * `own`: the topic record itself (a やること, a 会議…) unless it is a 案件 (まとまり); `bundle`: the
 * topic when it is one, else the 案件 the topic belongs to (its `bundle` link), when readable.
 */
export interface ConsultationTopic {
  own: TopicRecordLook | null
  bundle: TopicRecordLook | null
}

/**
 * `recordViews:topics`: by record id; `null` = no such record for this member (deleted, or one they
 * may not read). An id left out could not be asked (offline): ask again later.
 */
export type ConsultationTopicsResult =
  | { success: true; topics: Record<string, ConsultationTopic | null> }
  | { success: false; offline: boolean; error: string }

/** At most this many records are asked for in one call. */
export const MAX_TOPIC_IDS = 200

type Defs = ReadonlyMap<string, Pick<TypeDefinition, 'label' | 'implements'>>

function lookOf(r: RecordDetail['record'], defs: Defs): TopicRecordLook {
  const def = defs.get(r.type)
  const thing = { type: r.type, typeLabel: def?.label ?? null, implements: def?.implements, state: r.state }
  return { id: r.id, title: r.title || '（名前なし）', thing: thingKindOf(thing), typeLabel: def?.label ?? null, kindName: thingName(thing) }
}

/** The topic record's answer (`GET /records/item/:id`, which lists only readable linked records). */
export function consultationTopicOf(detail: RecordDetail, defs: Defs): ConsultationTopic {
  const self = lookOf(detail.record, defs)
  if (self.thing === 'bundle') return { own: null, bundle: self }
  const link = detail.links.find(l => l.direction === 'out' && l.name === 'bundle' && l.record)
  return { own: self, bundle: link?.record ? lookOf(link.record, defs) : null }
}

/**
 * The one record a consultation is found by and shown with: its own やること first, its 案件 only
 * when it has none (the same rule in 「AIへの相談」 and 探す).
 */
export function consultationLinkedRecord(topic: ConsultationTopic | null | undefined): TopicRecordLook | null {
  return topic ? topic.own ?? topic.bundle : null
}

/**
 * A record dropped on a consultation, or a consultation dropped on a record (owner 2026-11-03): what
 * happens to the consultation's topic — none yet → set it; the same → nothing; another → ask first
 * (`switchTopicQuestion`, ［切り替える］［このまま］).
 */
export function topicOnDrop(currentTopic: string | null | undefined, dropped: string): 'set' | 'same' | 'ask' {
  if (!currentTopic) return 'set'
  return currentTopic === dropped ? 'same' : 'ask'
}

/** 「『A』の相談を『B』の相談に切り替えますか？」 */
export function switchTopicQuestion(fromTitle: string, toTitle: string): string {
  return `『${fromTitle}』の相談を『${toTitle}』の相談に切り替えますか？`
}

// 「連絡」1枚 (inbox.md "One contact", owner decision 2026-11-28 「5番」): a 来た連絡 and its 返事のお願い shown as one card. Pure:
// what the card says and which buttons it shows, from the server's view alone — a button is shown only when the server's
// `may` says the member may press it now (the server decides again when it is pressed); where the contact goes in the
// inbox; the words after a press or a refusal. The two records stay two on the server; nothing here is stored.
import { OPEN_TASK_STATES } from '../../../shared/tasks'
import { shortDue } from '../../../shared/notifications-app'
import { NEXT_STEP, stateWord } from '../../../shared/thing-words'
import type {
  ContactFinishRequest, ContactFinishResult, ContactRefusal, ContactReplyEnd, ContactReplyView, ContactUndoRequest, ContactUndoResult, ContactView,
} from '../../../shared/contact-card'

const FINAL_REPLY = new Set(['closed', 'dropped'])
const OPEN_TASK = new Set<string>(OPEN_TASK_STATES)

export const isOpenReply = (r: Pick<ContactReplyView, 'state'>) => !!r.state && !FINAL_REPLY.has(r.state)
/** A やること still to do (a proposal the member has not taken up is not work yet). */
export const isOpenTask = (t: Pick<ContactView['tasks'][number], 'state'>) => !!t.state && OPEN_TASK.has(t.state)
/** Any finishing action the member may press on it now: it is theirs to answer. */
const mayAny = (r: ContactReplyView) => r.may.replied_elsewhere || r.may.close || r.may.drop

/** The badge of the card and of its inbox row. */
export type ContactTone = 'info' | 'ai' | 'neutral' | 'success'

/** A button of the card. `finish` ends the 返事のお願い (and the 連絡's 「済んだ」 where the server adds it) in one press. */
export type ContactButton =
  | { kind: 'finish'; replyId: string; end: ContactReplyEnd; label: string; hint?: string; asksReason?: true }
  | { kind: 'checkDraft'; draftId: string; label: string; hint?: string }

export interface ContactLook {
  status: { word: string; tone: ContactTone }
  /** The 返事のお願い the buttons act on (the first open one the member may finish), its lines. */
  reply: { id: string; lines: string[] } | null
  /** Open 返事のお願い of someone else: who answers and by when, read only (no button). */
  others: string[]
  main: ContactButton | null
  menu: ContactButton[]
  tasks: Array<{ id: string; title: string; state: string; open: boolean }>
  openTasks: number
  /** Every 返事のお願い it had is over (at least one), and a やること is still open: the line under the title. */
  leftWork: string | null
  truncated: boolean
}

const dueLine = (r: ContactReplyView): string | null =>
  r.due ? `${r.guidelineDue && r.guidelineDue === r.due ? '目安' : '期限'} ${shortDue(r.due)}` : null

/** 「田中さんが返します（期限 12/2）」, or 「ほかの人が返します」 without a name (the list did not name them). */
function othersLine(r: ContactReplyView, nameOf: (id: string) => string | null): string {
  const name = r.assignee ? nameOf(r.assignee) : null
  const due = dueLine(r)
  return `${name ? `${name}さん` : 'ほかの人'}が返します${due ? `（${due}）` : ''}`
}

export function leftWorkLine(openTasks: number): string {
  return `返事は済みました・やることが ${openTasks} 件残っています`
}

function statusOf(view: ContactView, mine: ContactReplyView | null, others: ContactReplyView[], openTasks: number, nameOf: (id: string) => string | null): ContactLook['status'] {
  if (mine) {
    const due = dueLine(mine)
    const paren = due ? `（${due}）` : ''
    if (mine.drafts.length > 0 && (mine.state === 'open' || mine.state === 'preparing')) return { word: `下書きがあります${paren}`, tone: 'info' }
    switch (mine.state) {
      case 'preparing': return { word: 'AI が下書きしています', tone: 'ai' }
      case 'open': return { word: `返事が要る${paren}`, tone: 'info' }
      case 'waiting_reply': return { word: `返事待ち${mine.waitUntil ? `（${shortDue(mine.waitUntil)} に追いかけ）` : ''}`, tone: 'neutral' }
      case 'checking': return { word: '返事が来ました・確かめています', tone: 'ai' }
    }
    return { word: stateWord(mine.state, 'reply_request') ?? '返事のお願い', tone: 'neutral' }
  }
  if (others.length > 0) return { word: othersLine(others[0], nameOf), tone: 'neutral' }
  if (view.replyRequests.length > 0) return openTasks > 0 ? { word: leftWorkLine(openTasks), tone: 'success' } : { word: '済んだ', tone: 'success' }
  return { word: stateWord(view.interaction.state, 'interaction') ?? '来た連絡', tone: 'neutral' }
}

function buttonsOf(r: ContactReplyView): { main: ContactButton | null; menu: ContactButton[] } {
  const finish = (end: ContactReplyEnd, label: string, hint?: string): ContactButton => ({ kind: 'finish', replyId: r.id, end, label, ...(hint ? { hint } : {}) })
  const drop: ContactButton[] = r.may.drop
    ? [{ kind: 'finish', replyId: r.id, end: 'drop', label: NEXT_STEP.noReplyNeeded, hint: '返事はしないことにします。わけを書いてください', asksReason: true }]
    : []
  const candidates: ContactButton[] = []
  const drafting = r.state === 'open' || r.state === 'preparing'
  if (drafting && r.drafts.length > 0) {
    candidates.push({ kind: 'checkDraft', draftId: r.drafts[0].id, label: NEXT_STEP.checkDraftAndSend, hint: '宛先と中身を確かめてから送ります' })
    if (r.may.replied_elsewhere) candidates.push(finish('replied_elsewhere', NEXT_STEP.repliedWithoutDraft, '下書きは送らずに片づけます（取り消すと戻ります）'))
  } else if (drafting) {
    if (r.may.replied_elsewhere) candidates.push(finish('replied_elsewhere', NEXT_STEP.replied, '電話やほかの経路で返したとき。連絡も済んだにします'))
  } else if (r.state === 'waiting_reply') {
    if (r.may.close) candidates.push(finish('close', NEXT_STEP.doneWaiting, 'もう相手の返事を待ちません'))
  } else if (r.state === 'checking') {
    if (r.may.close) candidates.push(finish('close', NEXT_STEP.doneChecking, 'AI が確かめている途中でも終えられます'))
  }
  const [main = null, ...rest] = candidates
  return { main, menu: [...rest, ...drop] }
}

/** The card from the server's view. `nameOf`: a member's name (the task list's), null when not known. */
export function contactLook(view: ContactView, nameOf: (id: string) => string | null = () => null): ContactLook {
  const open = view.replyRequests.filter(isOpenReply)
  const mine = open.find(mayAny) ?? null
  const others = open.filter(r => r !== mine && !mayAny(r))
  const tasks = view.tasks.map(t => ({ id: t.id, title: t.title, state: stateWord(t.state, 'task') ?? '', open: isOpenTask(t) }))
  const openTasks = tasks.filter(t => t.open).length
  const { main, menu } = mine ? buttonsOf(mine) : { main: null, menu: [] }
  const lines = mine ? [
    dueLine(mine),
    mine.state === 'waiting_reply' && mine.waitUntil ? `追いかけの日 ${shortDue(mine.waitUntil)}` : null,
    mine.drafts.length > 0 ? `AI の下書き ${mine.drafts.length} 件` : null,
  ].filter((l): l is string => l !== null) : []
  return {
    status: statusOf(view, mine, others, openTasks, nameOf),
    reply: mine ? { id: mine.id, lines } : null,
    others: others.map(r => othersLine(r, nameOf)),
    main, menu, tasks, openTasks,
    leftWork: open.length === 0 && view.replyRequests.length > 0 && openTasks > 0 ? leftWorkLine(openTasks) : null,
    truncated: view.truncated === true,
  }
}

/**
 * Where the contact's one row goes in the inbox (decision 5): its reply over but a やること still open → 「確認したもの」 (the
 * やること stays in the task list); otherwise where its notices put it (`null`).
 */
export function contactPlace(view: ContactView): 'seen' | null {
  return contactLook(view).leftWork ? 'seen' : null
}

export function finishRequestOf(view: ContactView, button: Extract<ContactButton, { kind: 'finish' }>, note?: string): ContactFinishRequest | null {
  const reply = view.replyRequests.find(r => r.id === button.replyId)
  if (!reply) return null
  const n = note?.trim()
  return {
    interaction: { expectedVersion: view.interaction.version },
    replyRequest: { id: reply.id, expectedVersion: reply.version, action: button.end, ...(n ? { note: n } : {}) },
  }
}

/**
 * What ［取り消す］ sends: each part's entry and the record's version the finish answered — never a version read later,
 * so a change someone made in between (a person, the AI) refuses the undo instead of being taken back with it. Nothing to
 * take back → null.
 */
export function undoRequestOf(r: ContactFinishResult): ContactUndoRequest | null {
  const rr = r.replyRequest
  if (rr.version === null) return null
  const it = r.interaction
  return {
    ...(it.version !== null ? { interaction: { version: it.version, expectedVersion: it.recordVersion } } : {}),
    replyRequest: { id: rr.recordId, version: rr.version, expectedVersion: rr.recordVersion },
  }
}

const ENDED: Record<ContactReplyEnd, string> = {
  replied_elsewhere: '返したことにしました',
  close: '済んだにしました',
  drop: '返事はしないことにしました',
}

export function finishedWords(end: ContactReplyEnd, r: ContactFinishResult, hadDrafts: boolean): string {
  if (r.replyRequest.outcome === 'already' && r.interaction.outcome !== 'done') return 'もう済んでいます'
  const both = r.interaction.outcome === 'done' || r.interaction.outcome === 'already' ? '（連絡も済んだにしました）' : ''
  const drafts = end === 'replied_elsewhere' && hadDrafts ? '下書きは送らずに片づけました。' : ''
  return `${ENDED[end]}${both}。${drafts}取り消すと、まとめて戻ります`
}

export function undoneWords(r: ContactUndoResult): string {
  return r.replyRequest.outcome === 'already' && (r.interaction === null || r.interaction.outcome === 'already') ? 'もう元に戻っています' : '元に戻しました（返事のお願いも連絡も）'
}

/**
 * A refusal in the member's words. The server writes both parts or neither, so every refusal says nothing changed —
 * except offline, where the press may have reached the server: the card reads again and shows what is true.
 */
export function refusalWords(r: ContactRefusal, pressed: 'finish' | 'undo'): string {
  if (r.offline) return `${r.error}（届いたかどうかは、読み直した表示で確かめてください）`
  if (r.gone) return 'この連絡は、もう見られません'
  switch (r.code) {
    case 'VERSION_CONFLICT': return pressed === 'finish'
      ? 'ほかの人か AI が先に変えたため、どちらも変えていません。最新を読み込みました。確かめてから、もう一度押してください'
      : 'ほかの人か AI が先に変えたため、取り消せませんでした（どちらもそのままです）。最新を読み込みました'
    case 'CHANGED_SINCE': return 'そのあとに変わったため、取り消せませんでした（どちらもそのままです）。最新を読み込みました'
    case 'NOT_THIS_CONTACT': return 'この返事のお願いは、この連絡のものではなくなりました。最新を読み込みました'
    case 'NOT_A_FINISH': return 'この変更は、ここからは取り消せません（どちらもそのままです）'
  }
  return `${r.error.replace(/[。.]$/, '')}。${pressed === 'finish' ? 'どちらも変えていません' : 'どちらもそのままです'}`
}

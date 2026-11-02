// Where each of a task's actions goes on its card (pure; 新しい画面のデモ C, J): one main button,
// the rest behind 「…」 with a line on what each does; actions that take the task off the member's
// list confirm first (what happens, who is told) and can be undone right after.
import type { TaskCardAction, TaskCardData } from '../../../shared/task-card'

/** Actions of チームの進め方: offered only with it on, and only on a task someone else is in. */
const TEAM_ACTIONS = new Set(['start', 'wait', 'request_review', 'decline', 'send_back'])
/** Actions that take the task out of the member's turn: confirmed first, then 「取り消す」. */
export const LEAVING_ACTIONS = new Set(['decline', 'wait', 'assign', 'cancel', 'request_review'])
/** Shown elsewhere on the card (the due's 「延ばす」). */
const ELSEWHERE = new Set(['set_due'])

export interface ActionPlacement {
  main: TaskCardAction | null
  /** No button, a word instead (「阿部さんが確かめています」「完了」). */
  status: string | null
  more: TaskCardAction[]
}

/** The order members meet them in the 「…」 menu. */
const ORDER = ['complete', 'start', 'reopen', 'request_review', 'wait', 'assign', 'send_back', 'decline', 'cancel']

const rank = (action: string) => (ORDER.indexOf(action) + 1 || 99)

export function placeActions(card: TaskCardData, team: boolean): ActionPlacement {
  const withSomeone = !!card.names.requester && !(card.roles.assignee && card.roles.requester)
  const offered = card.actions.filter(a => !ELSEWHERE.has(a.action))
    .filter(a => !TEAM_ACTIONS.has(a.action) || (team && withSomeone) || isHandToChecker(card, a))
  const find = (name: string, pred: (a: TaskCardAction) => boolean = () => true) => offered.find(a => a.action === name && pred(a)) ?? null
  const state = card.record.state

  let main: TaskCardAction | null = null
  let status: string | null = null
  if (state === 'done') status = '完了'
  else if (state === 'review' && !card.roles.reviewer && !card.roles.requester) status = `${card.names.reviewer ?? '確かめる人'}さんが確かめています`
  // While someone else checks it (or it is done) the word stands alone; 完了 stays in 「…」.
  if (!status) {
    main = find('take_over')
      ?? find('accept')
      ?? (card.whenDone === 'check' && card.roles.assignee ? find('request_review') : null)
      ?? find('complete', a => !a.needsOk)
      ?? find('complete')
  }
  const more = offered.filter(a => a !== main).sort((a, b) => rank(a.action) - rank(b.action))
  return { main, status, more }
}

/** 確かめてから: 「終わったので見てもらう」 is how the assignee finishes, not a team extra. */
function isHandToChecker(card: TaskCardData, a: TaskCardAction): boolean {
  return a.action === 'request_review' && card.whenDone === 'check' && card.roles.assignee
}

/** The words on a button or a menu row. */
export function actionText(a: TaskCardAction): string {
  switch (a.action) {
    case 'complete': return a.needsOk ? '完了にする（OK をもらった）' : '完了にする'
    case 'request_review': return '終わったので見てもらう'
    case 'start': return '進めている印をつける'
    case 'assign': return '人に頼む（担当を替える）'
    case 'decline': return '受けられない（頼んだ人に返す）'
    case 'cancel': return 'やめる（しまう）'
    default: return a.title
  }
}

/** One line on what the action does (the 「…」 menu). */
export function actionHint(a: TaskCardAction, card: TaskCardData): string | undefined {
  const requester = card.names.requester ? `${card.names.requester}さん` : '頼んだ人'
  switch (a.action) {
    case 'complete': return a.needsOk ? '確かめる人が ACB の外で OK をくれたとき。誰の OK かを書きます' : undefined
    case 'start': return '手を付けたことを見せます（付けなくても完了にできます）'
    case 'reopen': return '完了を取り消して、担当の番に戻します'
    case 'request_review': return '確かめる人の番になります。その人の OK で完了です'
    case 'wait': return '相手の返事を待つ間、あなたの番から外れます'
    case 'assign': return '頼んだ相手の番になります。あなたの一覧では「ほかの人の番」に残ります'
    case 'send_back': return '理由を添えて、担当に戻します'
    case 'decline': return `わけを添えて、${requester}に返します`
    case 'cancel': return '消しません。「やり直す」で戻せます'
    default: return undefined
  }
}

/** Before a leaving action: what happens and who is told (2 lines). */
export function leavingWords(a: TaskCardAction, card: TaskCardData, chosen: string | null): { title: string; what: string; tell: string; done: string } {
  const requester = card.names.requester ? `${card.names.requester}さん` : '頼んだ人'
  const assignee = card.names.assignee ? `${card.names.assignee}さん` : '担当'
  const who = chosen ? `${chosen}さん` : null
  switch (a.action) {
    case 'decline': return { title: '頼んだ人に返しますか？', what: `${requester}の番に戻ります。あなたの一覧では「ほかの人の番」に「受けられないと返した」の札で残ります`, tell: `${requester}（わけも届きます）`, done: `${requester}に返しました` }
    case 'wait': return { title: '返事待ちにしますか？', what: 'あなたの番から外れ、「ほかの人の番・返事待ち」に移ります', tell: 'だれにも知らせません', done: '返事待ちにしました' }
    case 'assign': return { title: '人に頼みますか？', what: `${who ?? '選んだ人'}の番になります。あなたの一覧では「ほかの人の番」に残ります`, tell: who ?? '選んだ人', done: `${who ?? '選んだ人'}に頼みました` }
    case 'request_review': return { title: '見てもらいますか？', what: `${who ?? '確かめる人'}の番になります。その人の OK で完了です`, tell: who ?? '確かめる人', done: `${who ?? '確かめる人'}に見てもらいます` }
    case 'cancel': return { title: 'このやることをしまいますか？', what: '一覧から外れます（消しません。「やり直す」で戻せます）', tell: card.roles.assignee ? 'だれにも知らせません' : assignee, done: 'しまいました' }
    default: return { title: actionText(a), what: '', tell: '', done: `${actionText(a)}にしました` }
  }
}

/** 「終わったら：…」: what finishing does, before the member presses it. */
export function whenDoneLine(card: TaskCardData): string | null {
  if (card.record.state === 'done' || card.record.state === 'cancelled') return null
  const checker = card.names.reviewer
  if (card.whenDone === 'check') return checker ? `終わったら：${checker}さんに確かめてもらう（${checker}さんの OK で完了）` : '終わったら：確かめる人に見てもらう（その人の OK で完了）'
  const requester = card.names.requester
  if (requester && !card.roles.requester) return `終わったら：${requester}さんに知らせるだけ（${requester}さんは「やり直す」で戻せます）`
  return null
}

/** 「〇〇しました」 after a press that stays on the member's list (取り消す follows). */
export function doneWords(a: TaskCardAction, card: TaskCardData): string {
  const requester = card.names.requester && !card.roles.requester ? `${card.names.requester}さん` : null
  switch (a.action) {
    case 'complete': return requester ? `完了にしました。${requester}に知らせました` : '完了にしました'
    case 'accept': return requester ? `引き受けました。${requester}に知らせました` : '引き受けました'
    case 'take_over': return 'AI から引き取りました'
    case 'start': return '進めている印をつけました'
    case 'reopen': return 'やり直しにしました'
    case 'send_back': return '差し戻しました'
    default: return `${a.title}：しました`
  }
}

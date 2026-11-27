/**
 * The operator's own trail of a 「ブラウザ操作」 run, for the person's card only (agent-browser.md "The operator's trail on the
 * card"; owner 2026-11-27: a run stopped with 「人の判断が要る」 and nobody could see what the operator AI tried or why).
 *
 * Per step: the action, the button's or field's label **in the run log's kept form** (`browseLogStep`: the recording's rules,
 * no value) and the operator's own short `reason` for that step; at the end, its own words for why it stopped (or finished);
 * and its last `notes`. Everything the operator wrote here was written by an AI that reads page text, so it is **outside
 * text**: shown only on the person's card (never in the consultation AI's words, the server's run log or any file), one
 * line each and capped, plain text (the card renders text, never markup), collapsed under 「係の AI のメモを見る」 with the
 * label `BROWSER_TRAIL_WORDS.heading`. Kept in main's memory with the card it belongs to, so it is gone when the app quits.
 *
 * Pure: the read run (electron/features/browser/browse.ts), the write run (work.ts), the views' checks and the card import it.
 * No site word.
 */
import { BROWSER_RUN_ACTIONS, type BrowserRunAction, type BrowserRunLogStep } from '../../shared/core/browser-run-log'
import { cleanLabel } from './browser-page'

export const BROWSER_TRAIL_LIMITS = Object.freeze({
  /** The operator's reason for one step, and for stopping (one line). */
  reason: 200,
  /** Its working notes as the card shows them (they are ≤ 4000 as it writes them: `BROWSER_BROWSE_LIMITS.notes`). */
  notes: 4000,
  /** Steps shown per run (the largest budget's steps; more are counted, not shown). */
  steps: 60,
  /** A kept-form label or page pattern (already bounded by the run log's rules). */
  label: 200,
  /** Runs on one card: a write task's preview and its work. */
  runs: 2,
  /** The operator's question to the person when it stopped for their decision (one line; the browse operator's cap). */
  question: 300,
})
const L = BROWSER_TRAIL_LIMITS

export const BROWSER_TRAIL_PHASES = ['browse', 'preview', 'work'] as const
export type BrowserTrailPhase = typeof BROWSER_TRAIL_PHASES[number]
export const BROWSER_TRAIL_ENDS = ['done', 'plan', 'stop'] as const
export type BrowserTrailEnd = typeof BROWSER_TRAIL_ENDS[number]

export interface BrowserTrailStep {
  action: BrowserRunAction
  /** The page as the run log keeps it (a pattern), and the button's or field's label in its kept form; null when none. */
  page: string
  label: string | null
  /** The operator's own words for the step (outside text), or null when it gave none. */
  reason: string | null
}

/**
 * Why the app refused an operator's answer (`parseBrowseAnswer` / `parseWorkAnswer`'s problem), in fixed words: told back
 * to the operator once in its re-ask, and named on the card's trail when the run then ends on it (`bad-answer`). The
 * words are the app's, never the operator's.
 */
export const BROWSER_ANSWER_PROBLEMS = [
  'not-json', 'shape', 'keys', 'notes', 'reason', 'unlisted', 'ref', 'point', 'text', 'option', 'path', 'seconds', 'done', 'stop',
  'plan', 'plan-keys', 'plan-summary', 'plan-affects', 'plan-unread', 'plan-values', 'plan-value', 'plan-writes',
] as const
export type BrowserAnswerProblem = typeof BROWSER_ANSWER_PROBLEMS[number]
export const BROWSER_ANSWER_PROBLEM_WORDS: Readonly<Record<BrowserAnswerProblem, string>> = {
  'not-json': '答えが JSON 1つではありませんでした',
  shape: '答えに "do" がないか、知らない "do" でした',
  keys: '答えに決まりにない項目があるか、要る項目がありませんでした',
  notes: 'notes が文字でないか、長すぎました',
  reason: 'reason が文字ではありませんでした',
  unlisted: 'unlisted が文字ではありませんでした',
  ref: 'ref が画面にない要素か、その操作に合わない要素でした',
  point: 'click の x, y が画像の中の位置（画素の整数）ではないか、画像がありませんでした（ref と x, y の両方は書けません）',
  text: '入れる文字が長すぎるか、使えない文字がありました',
  option: 'option が、その select の options にありませんでした',
  path: 'go の path が、このサイトのアドレスの形ではありませんでした',
  seconds: 'wait の seconds が 1〜5 ではありませんでした',
  done: 'done の形が決まりに合いませんでした',
  stop: 'stop の形が決まりに合いませんでした（why は決まった言葉のどれか）',
  plan: 'plan は、いまの段階では出せません',
  'plan-keys': 'plan に決まりにない項目がありました',
  'plan-summary': 'plan の summary がないか、文字ではありませんでした',
  'plan-affects': 'plan の affects が文字ではありませんでした',
  'plan-unread': 'plan の unread の番号が正しくありませんでした',
  'plan-values': 'plan の values が一覧でないか、多すぎました（10個まで）',
  'plan-value': 'plan の values の1つが {"label":"…","value":"…"} の形ではありませんでした',
  'plan-writes': 'plan の writes が決まりに合いませんでした',
}
/** A parser's problem as one of the fixed codes (anything else: `shape`). */
export const answerProblemOf = (problem: string): BrowserAnswerProblem =>
  ((BROWSER_ANSWER_PROBLEMS as readonly string[]).includes(problem) ? problem as BrowserAnswerProblem : 'shape')

export interface BrowserTrailRun {
  phase: BrowserTrailPhase
  steps: BrowserTrailStep[]
  /** Steps done but not shown (past `BROWSER_TRAIL_LIMITS.steps`). */
  more: number
  /** How the operator itself ended (done, its plan, a stop) with its own words; null when the app ended the run. */
  end: { kind: BrowserTrailEnd; reason: string | null } | null
  /** Its last working notes, or null. */
  notes: string | null
  /** When the app ended the run on an answer out of its form: which rule it broke (a fixed code; absent otherwise). */
  problem?: BrowserAnswerProblem
  /**
   * The operator's last word for something it saw on the screen image that had no ref in `page.elements` (its own words,
   * one line); absent when it said none. The card shows it under `BROWSER_TRAIL_WORDS.unlisted`.
   */
  unlisted?: string
}

export type BrowserOperatorTrail = BrowserTrailRun[]

export const BROWSER_TRAIL_WORDS = {
  heading: 'ブラウザ操作の係の AI のメモ（係の AI が書いたもの。確かめた事実ではありません）',
  open: '係の AI のメモを見る',
  phase: { browse: '読む作業', preview: '下見', work: '書く作業' } satisfies Record<BrowserTrailPhase, string>,
  action: { click: '押した', type: '入力した', select: '選んだ', go: 'ページを開いた', back: '戻った', wait: '待った' } satisfies Record<BrowserRunAction, string>,
  end: { done: '終えた', plan: '計画をまとめた', stop: '止まった' } satisfies Record<BrowserTrailEnd, string>,
  // Not 「止まった理由」: the card's fixed words say why once; this is the operator's own line when it stopped.
  stopReason: '止めたときの係の AI の言葉',
  appEnded: 'アプリが作業を終えました（係の AI の言葉はありません）。',
  noReason: '（理由は書かれていません）',
  more: (n: number) => `ほかに ${n} 回の操作（表示していません）`,
  notes: '係の AI の覚え書き',
  noSteps: '操作はしていません。',
  problem: (words: string) => `アプリが止めました：係の AI の答えの形が決まりに合いませんでした（${words}）。`,
  unlisted: '画面にはあるが押せる部品として拾えなかった（係の AI の言葉）',
} as const

// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** One line of the operator's words: NFC, no control / bidirectional / zero-width characters, cut; empty → null. */
export function trailLine(v: unknown, max: number = L.reason): string | null {
  if (typeof v !== 'string') return null
  const s = cleanLabel(v, max)
  return s === '' ? null : s
}

/** The operator's notes as the card shows them: line breaks kept, every other unsafe character dropped, cut; empty → null. */
export function trailNotes(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(UNSAFE_MULTILINE_RE, ' ').trim().slice(0, L.notes).trim()
  return s === '' ? null : s
}

/**
 * One run's trail as the loop goes (memory only): each action with its kept-form log step and the operator's reason, how
 * the operator ended, its last notes. `view()` is a copy for the card.
 */
export function createOperatorTrail(phase: BrowserTrailPhase) {
  const steps: BrowserTrailStep[] = []
  let more = 0
  let end: BrowserTrailRun['end'] = null
  let notes: string | null = null
  let problem: BrowserAnswerProblem | null = null
  let unlisted: string | null = null
  return {
    step(log: BrowserRunLogStep, reason: unknown): void {
      if (steps.length >= L.steps) { more++; return }
      steps.push({
        action: log.action, page: trailLine(log.page, L.label) ?? '', label: log.label === null ? null : trailLine(log.label, L.label), reason: trailLine(reason),
      })
    },
    end(kind: BrowserTrailEnd, reason: unknown): void { end = { kind, reason: trailLine(reason) } },
    notes(v: unknown): void { if (v !== undefined) notes = trailNotes(v) },
    /** The app ended the run on an answer out of its form (`bad-answer`): which rule, in fixed words. */
    problem(code: BrowserAnswerProblem): void { problem = code },
    /** The operator said something on the screen has no ref (`unlisted`): its last such words are kept. */
    unlisted(v: unknown): void { const line = trailLine(v); if (line !== null) unlisted = line },
    view(): BrowserTrailRun {
      return {
        phase, steps: steps.map(s => ({ ...s })), more, end: end ? { ...end } : null, notes, ...(problem ? { problem } : {}),
        ...(unlisted !== null ? { unlisted } : {}),
      }
    },
  }
}
export type OperatorTrailRecorder = ReturnType<typeof createOperatorTrail>

/** The runs that did anything (a step, an end of its own, notes), for a card; none → null (the card shows no memo). */
export function trailForCard(runs: readonly BrowserTrailRun[]): BrowserOperatorTrail | null {
  const shown = runs.filter(r => r.steps.length > 0 || r.more > 0 || r.end !== null || r.notes !== null || r.problem !== undefined || r.unlisted !== undefined).slice(0, L.runs)
  return shown.length > 0 ? shown : null
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const lineOrNull = (v: unknown, max: number): v is string | null => v === null || (typeof v === 'string' && v.length <= max && trailLine(v, max) === v)

/**
 * A trail as the renderer is handed it: every field checked for its shape and its cap (one line, no unsafe character) and
 * copied alone; null when any is off (the card then shows no memo).
 */
export function readBrowserOperatorTrail(v: unknown): BrowserOperatorTrail | null {
  if (!Array.isArray(v) || v.length > L.runs) return null
  const runs: BrowserTrailRun[] = []
  for (const r of v) {
    if (!isMap(r) || !(BROWSER_TRAIL_PHASES as readonly unknown[]).includes(r.phase) || !Array.isArray(r.steps) || r.steps.length > L.steps) return null
    if (!Number.isSafeInteger(r.more) || (r.more as number) < 0) return null
    const steps: BrowserTrailStep[] = []
    for (const s of r.steps) {
      if (!isMap(s) || !(BROWSER_RUN_ACTIONS as readonly unknown[]).includes(s.action) || typeof s.page !== 'string' || (s.page !== '' && !lineOrNull(s.page, L.label))) return null
      if (!lineOrNull(s.label, L.label) || !lineOrNull(s.reason, L.reason)) return null
      steps.push({ action: s.action as BrowserRunAction, page: s.page, label: s.label, reason: s.reason })
    }
    let end: BrowserTrailRun['end'] = null
    if (r.end !== null) {
      if (!isMap(r.end) || !(BROWSER_TRAIL_ENDS as readonly unknown[]).includes(r.end.kind) || !lineOrNull(r.end.reason, L.reason)) return null
      end = { kind: r.end.kind as BrowserTrailEnd, reason: r.end.reason }
    }
    if (!(r.notes === null || (typeof r.notes === 'string' && trailNotes(r.notes) === r.notes))) return null
    if (r.problem !== undefined && !(BROWSER_ANSWER_PROBLEMS as readonly unknown[]).includes(r.problem)) return null
    if (r.unlisted !== undefined && !(typeof r.unlisted === 'string' && lineOrNull(r.unlisted, L.reason))) return null
    runs.push({
      phase: r.phase as BrowserTrailPhase, steps, more: r.more as number, end, notes: r.notes, ...(r.problem !== undefined ? { problem: r.problem as BrowserAnswerProblem } : {}),
      ...(r.unlisted !== undefined ? { unlisted: r.unlisted as string } : {}),
    })
  }
  return runs
}

// ── What a stopped card asks of the person ──────────────────────────────────────────────────────────────────────────

/**
 * What a write task's stopped card puts first (agent-browser.md "The stopped card asks one thing"; owner 2026-11-27: the
 * operator's question 「同名のタグが既にある。既存のタグを使ってよいか？」 sat at the bottom of the collapsed memo and the
 * card had no button to answer it):
 * - `decide`: the operator stopped for a person's decision (`need-person`) and said what to decide (its `question`, outside
 *   text, one line ≤ 300). The card's first line is 「決めてほしいこと：…」 with ［そのまま進める］［やめる］, each **the
 *   member's own message to the consultation** (`stopAnswerMessage`), sent through the chat's ordinary send — no new way
 *   to the site: the consultation AI asks again, and the new run starts from its own read as every run does.
 * - `login`: the site showed its login (`need-login`): ［開いてログイン］, the window's existing 「開いてログイン」.
 * Any other stop asks nothing: its fixed words are the first line, and there is no button.
 */
export type BrowserStopNext = { kind: 'decide'; question: string } | { kind: 'login' }

export const BROWSER_STOP_WORDS = {
  decide: '決めてほしいこと',
  proceed: 'そのまま進める',
  cancel: 'やめる',
  openSite: '開いてログイン',
  /** Under the two buttons: what they do (fixed words; the question itself is above). */
  sendsNote: '押すと、あなたの返事として相談に送ります。続きは AI がサイトを読み直してから始めます（済んだ書き込みをもう一度送ることはありません）。',
  sent: '相談に返事を送りました。',
} as const

/**
 * The member's message a button sends (their own words to the consultation, as if typed). To go on it names the question as
 * the card showed it — the consultation AI cannot see the card, and writes the decision into its next request from it; to
 * stop, fixed words only.
 */
export function stopAnswerMessage(answer: 'proceed' | 'cancel', question: string): string {
  return answer === 'proceed'
    ? `ブラウザ操作の係の AI の問い「${question}」は、それでよいです。そのまま続けてください。`
    : 'ブラウザ操作の係の AI が止まった作業は、ここでやめます。続けないでください。'
}

/** The operator's question as the card may show it: one line, NFC, no control / bidirectional / zero-width character, ≤ 300; none → null. */
export function stopQuestion(v: unknown): string | null {
  return trailLine(v, L.question)
}

/** A stopped card's `next` as the renderer is handed it (exact keys, the question one clean line within its cap), or null. */
export function readBrowserStopNext(v: unknown): BrowserStopNext | null {
  if (!isMap(v)) return null
  if (v.kind === 'login' && Object.keys(v).length === 1) return { kind: 'login' }
  if (v.kind === 'decide' && Object.keys(v).length === 2 && typeof v.question === 'string' && stopQuestion(v.question) === v.question) {
    return { kind: 'decide', question: v.question }
  }
  return null
}

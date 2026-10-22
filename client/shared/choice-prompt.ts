/**
 * Choice prompts: the AI asks the member to pick from options and continues
 * with the answer (Claude Code's built-in `AskUserQuestion`, and the app's
 * `ask_user` tool for Codex). Pure module shared by the main process
 * (validation, the answer each agent receives) and the renderer (card,
 * transcript summary, chat history).
 */

export interface ChoiceOption { label: string; description: string }
export interface ChoiceQuestion {
  question: string
  /** Short chip label (Claude asks for max 12 characters). */
  header: string
  options: ChoiceOption[]
  multiSelect: boolean
}
/** One answer per question: the picked option labels and/or 「その他」 text. */
export interface ChoiceAnswer { selected: string[]; other?: string }
export type ChoiceCancelReason = 'cancelled' | 'timeout' | 'aborted' | 'unavailable'
export type ChoiceResult = { answers: ChoiceAnswer[] } | { cancelled: ChoiceCancelReason }

/** What the transcript keeps (a `data-choice-prompt` part, and `choicePrompts` in chat history). */
export interface ChoicePromptRecord {
  /** The agent's tool call id when known. */
  id: string
  questions: ChoiceQuestion[]
  answers?: ChoiceAnswer[]
  cancelled?: ChoiceCancelReason
}

export const CHOICE_PART_TYPE = 'data-choice-prompt'
/** Unanswered for this long → treated as cancelled. */
export const CHOICE_TIMEOUT_MS = 10 * 60_000
export const MAX_CHOICE_QUESTIONS = 4
export const MAX_CHOICE_OPTIONS = 6
export const MAX_OTHER_LENGTH = 2000
/** Tool names that ask the member (Claude Code native; Codex through the app's MCP helper). */
export const CLAUDE_CHOICE_TOOL = 'AskUserQuestion'
export const CODEX_CHOICE_SERVER = 'acb_ask'
export const CODEX_CHOICE_TOOL = 'ask_user'
export const CHOICE_TOOL_NAMES: ReadonlySet<string> = new Set([CLAUDE_CHOICE_TOOL, `mcp__${CODEX_CHOICE_SERVER}__${CODEX_CHOICE_TOOL}`])

const MAX_TEXT = 1000
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`選択肢の質問の${field}が空です。`)
  if (value.length > max) throw new Error(`選択肢の質問の${field}が長すぎます。`)
  return value
}

/**
 * The agent's `questions` input → validated questions. Throws a message the
 * agent receives (it then asks in plain text or fixes the call). Claude keys
 * its answers by question text, so duplicate questions are refused.
 */
export function parseChoiceQuestions(value: unknown): ChoiceQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHOICE_QUESTIONS) throw new Error(`選択肢の質問は1〜${MAX_CHOICE_QUESTIONS}問で指定してください。`)
  const seen = new Set<string>()
  return value.map(q => {
    if (!object(q)) throw new Error('選択肢の質問の形式が不正です。')
    const question = text(q.question, '質問文')
    if (seen.has(question)) throw new Error('同じ質問文が重複しています。')
    seen.add(question)
    const header = typeof q.header === 'string' ? q.header.slice(0, 40) : ''
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > MAX_CHOICE_OPTIONS) throw new Error(`選択肢は1〜${MAX_CHOICE_OPTIONS}個で指定してください。`)
    const labels = new Set<string>()
    const options = q.options.map(o => {
      if (!object(o)) throw new Error('選択肢の形式が不正です。')
      const label = text(o.label, '選択肢', 200)
      if (labels.has(label)) throw new Error('同じ選択肢が重複しています。')
      labels.add(label)
      return { label, description: typeof o.description === 'string' ? o.description.slice(0, MAX_TEXT) : '' }
    })
    if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') throw new Error('multiSelect は true / false で指定してください。')
    return { question, header, options, multiSelect: q.multiSelect === true }
  })
}

/** Whether `answers` is a complete, well-formed answer to `questions`. */
export function validChoiceAnswers(questions: readonly ChoiceQuestion[], answers: unknown): answers is ChoiceAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) return false
  return questions.every((q, i) => {
    const a = answers[i]
    if (!object(a) || !Array.isArray(a.selected) || (a.other !== undefined && typeof a.other !== 'string')) return false
    const other = typeof a.other === 'string' ? a.other.trim() : ''
    if (other.length > MAX_OTHER_LENGTH) return false
    const selected = a.selected as unknown[]
    if (new Set(selected).size !== selected.length || !selected.every(s => typeof s === 'string' && q.options.some(o => o.label === s))) return false
    if (!q.multiSelect && selected.length + (other ? 1 : 0) > 1) return false
    return selected.length > 0 || !!other
  })
}

/** Keeps only the fields the agent and the transcript use. */
export function normalizeChoiceAnswers(answers: readonly ChoiceAnswer[]): ChoiceAnswer[] {
  return answers.map(a => {
    const other = a.other?.trim()
    return other ? { selected: [...a.selected], other } : { selected: [...a.selected] }
  })
}

/** One answer as text: labels (and 「その他」 text) joined with ", " — Claude Code's multiSelect convention. */
export function choiceAnswerText(answer: ChoiceAnswer): string {
  return [...answer.selected, ...(answer.other?.trim() ? [answer.other.trim()] : [])].join(', ')
}

/**
 * Claude Code's AskUserQuestion contract: canUseTool allows the call with
 * `updatedInput = { ...input, answers }`, `answers` keyed by question text.
 */
export function claudeAnswers(questions: readonly ChoiceQuestion[], answers: readonly ChoiceAnswer[]): Record<string, string> {
  const result: Record<string, string> = {}
  questions.forEach((q, i) => { result[q.question] = choiceAnswerText(answers[i]) })
  return result
}

/** The `ask_user` tool result Codex receives. */
export function codexAnswerText(questions: readonly ChoiceQuestion[], answers: readonly ChoiceAnswer[]): string {
  const lines = questions.map((q, i) => `- ${q.header ? `[${q.header}] ` : ''}${q.question}\n  回答: ${choiceAnswerText(answers[i])}`)
  return `ユーザーが回答しました。\n${lines.join('\n')}\n回答内容をよく読み、その内容に従って作業を続けてください。`
}

/** What the agent receives when there is no answer. */
export function choiceCancelMessage(reason: ChoiceCancelReason): string {
  switch (reason) {
    case 'timeout': return 'ユーザーは10分以内に質問へ回答しませんでした。同じ質問を繰り返さず、回答がなかったことを短く伝えて、ユーザーの返信を待ってください。'
    case 'aborted': return 'ユーザーが応答を停止したため、質問は取り消されました。'
    case 'unavailable': return 'この画面では選択肢の質問を表示できません。質問は通常の文章で尋ねてください。'
    default: return 'ユーザーは質問に回答せずに閉じました。同じ質問を繰り返したり、勝手に選んで進めたりせず、ユーザーの指示を待ってください。'
  }
}

export function choiceCancelLabel(reason: ChoiceCancelReason): string {
  return reason === 'timeout' ? '10分間回答がなかったため終了しました' : reason === 'aborted' ? '応答の停止で取り消されました' : reason === 'unavailable' ? '表示できませんでした' : '回答せずに閉じました'
}

const CANCEL_REASONS: ReadonlySet<string> = new Set(['cancelled', 'timeout', 'aborted', 'unavailable'])

/** A stored record (chat history, data part) → validated record, else undefined. */
export function readChoiceRecord(value: unknown): ChoicePromptRecord | undefined {
  if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.length > 200) return
  let questions: ChoiceQuestion[]
  try { questions = parseChoiceQuestions(value.questions) } catch { return }
  if (value.answers !== undefined) {
    if (!validChoiceAnswers(questions, value.answers)) return
    return { id: value.id, questions, answers: normalizeChoiceAnswers(value.answers) }
  }
  if (typeof value.cancelled === 'string' && CANCEL_REASONS.has(value.cancelled)) return { id: value.id, questions, cancelled: value.cancelled as ChoiceCancelReason }
  return undefined
}

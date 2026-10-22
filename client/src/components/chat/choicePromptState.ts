import { MAX_OTHER_LENGTH, choiceAnswerText, type ChoiceAnswer, type ChoicePromptRecord, type ChoiceQuestion } from '../../../shared/choice-prompt'

/** What the member has picked so far for one question (pure, for the card and its tests). */
export interface ChoiceDraft { selected: string[]; otherOn: boolean; otherText: string }

export const emptyDraft = (): ChoiceDraft => ({ selected: [], otherOn: false, otherText: '' })

/** Click on an option: radio semantics for single choice (clears 「その他」), toggle for multiSelect. */
export function toggleOption(question: ChoiceQuestion, draft: ChoiceDraft, label: string): ChoiceDraft {
  if (!question.multiSelect) return { ...draft, selected: [label], otherOn: false }
  const selected = draft.selected.includes(label) ? draft.selected.filter(l => l !== label) : [...draft.selected, label]
  // Keep the option order, not the click order.
  return { ...draft, selected: question.options.map(o => o.label).filter(l => selected.includes(l)) }
}

/** Click on 「その他」: single choice replaces the picked option; multiSelect adds it. */
export function toggleOther(question: ChoiceQuestion, draft: ChoiceDraft): ChoiceDraft {
  if (!question.multiSelect) return { ...draft, selected: [], otherOn: true }
  return { ...draft, otherOn: !draft.otherOn }
}

export function draftComplete(draft: ChoiceDraft): boolean {
  const other = draft.otherOn ? draft.otherText.trim() : ''
  if (other.length > MAX_OTHER_LENGTH) return false
  return draft.selected.length > 0 || !!other
}

/** The answers to send, or undefined while a question is unanswered. */
export function buildChoiceAnswers(questions: readonly ChoiceQuestion[], drafts: readonly ChoiceDraft[]): ChoiceAnswer[] | undefined {
  if (drafts.length !== questions.length || !drafts.every(draftComplete)) return undefined
  return drafts.map(d => {
    const other = d.otherOn ? d.otherText.trim() : ''
    return other ? { selected: [...d.selected], other } : { selected: [...d.selected] }
  })
}

/** The answer as the member's own words (one line per question). */
export function choiceAnswerLines(record: ChoicePromptRecord): string[] {
  if (!record.answers) return []
  return record.questions.map((q, i) => {
    const text = choiceAnswerText(record.answers![i])
    return record.questions.length > 1 ? `${q.header || q.question}：${text}` : text
  })
}

import { z } from 'zod'
import type { AskUser } from './connection'
import type { LoopbackTool } from './loopback-mcp'
import {
  CODEX_CHOICE_TOOL, MAX_CHOICE_OPTIONS, MAX_CHOICE_QUESTIONS,
  choiceCancelMessage, claudeAnswers, codexAnswerText, parseChoiceQuestions,
} from '../../shared/choice-prompt'

type ClaudePermission =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

/**
 * Claude Code's built-in AskUserQuestion. The CLI always routes it through
 * canUseTool — in every permission mode, bypassPermissions included
 * (`requiresUserInteraction`), even when a PreToolUse hook allowed it — and
 * runs it with the input canUseTool returns: `{ questions, answers }`, the
 * answers keyed by question text, multiSelect labels joined with ", ".
 * Verified against CLI 2.1.304 (tool result: `The user answered: "Q"="A"`).
 * Denying is how "no answer" reaches the model.
 */
export async function answerAskUserQuestion(askUser: AskUser | undefined, input: Record<string, unknown>, toolUseId: string | undefined, signal: AbortSignal | undefined): Promise<ClaudePermission> {
  if (!askUser) return { behavior: 'deny', message: choiceCancelMessage('unavailable') }
  let questions
  try { questions = parseChoiceQuestions(input.questions) } catch (error) {
    return { behavior: 'deny', message: `${error instanceof Error ? error.message : String(error)} 形式を直して再度質問するか、通常の文章で質問してください。` }
  }
  const result = await askUser(questions, toolUseId, signal ?? new AbortController().signal)
  if ('answers' in result) return { behavior: 'allow', updatedInput: { ...input, answers: claudeAnswers(questions, result.answers) } }
  return { behavior: 'deny', message: choiceCancelMessage(result.cancelled) }
}

/** The same input shape as AskUserQuestion, so both agents ask alike. */
export const askUserSchema = {
  questions: z.array(z.object({
    question: z.string().describe('質問文。具体的に、疑問形で。複数選択なら「どれを〜しますか（複数可）」のように。'),
    header: z.string().describe('チップに表示する短いラベル（12文字以内）。例: 「出力形式」「対象期間」'),
    options: z.array(z.object({
      label: z.string().describe('選択肢の表示名（短く）'),
      description: z.string().describe('その選択肢を選ぶと何が起きるか、トレードオフの説明'),
    })).min(1).max(MAX_CHOICE_OPTIONS).describe('2〜4個が目安。「その他」は自動で追加されるので含めない'),
    multiSelect: z.boolean().default(false).describe('複数選べる場合は true'),
  })).min(1).max(MAX_CHOICE_QUESTIONS),
}

export const ASK_USER_DESCRIPTION = 'ユーザーに選択肢つきの質問をして、回答を待ちます（アプリの画面に選択カードが表示されます）。方針・対象・形式などをユーザーに選んでもらう必要があるときに使います。回答はこのツールの結果として返ります。'

export const CODEX_ASK_USER_INSTRUCTIONS = `\n\n【ユーザーへの選択肢つきの質問】作業の方針・対象・形式などをユーザーに選んでもらう必要があるときは、文章で質問して応答を終えるのではなく、${CODEX_CHOICE_TOOL} ツール（acb_ask）で選択肢を示して質問し、その回答に従って作業を続けてください。選択肢は2〜4個、「その他」は自動で追加されるので含めないでください。ユーザーが回答しなかった場合は、勝手に選んで進めず、そのことを伝えて終えてください。`

/** Codex's `ask_user` (loopback MCP): blocks until the member answers. */
export function codexAskUserTool(askUser: AskUser, nextToolCallId: () => string | undefined, signal: AbortSignal): LoopbackTool {
  return {
    name: CODEX_CHOICE_TOOL,
    description: ASK_USER_DESCRIPTION,
    inputSchema: askUserSchema,
    async execute(args) {
      let questions
      try { questions = parseChoiceQuestions(args.questions) } catch (error) {
        return `${error instanceof Error ? error.message : String(error)} 形式を直して再度質問するか、通常の文章で質問してください。`
      }
      const result = await askUser(questions, nextToolCallId(), signal)
      return 'answers' in result ? codexAnswerText(questions, result.answers) : choiceCancelMessage(result.cancelled)
    },
  }
}

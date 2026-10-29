/**
 * 「確認をお願いする」 (`request_review`, shared/review-request.ts): the chat AI
 * asks the member to look at its work and stops. Given to Claude Code as an
 * in-process SDK MCP server and to Codex as a loopback MCP endpoint (both
 * named `acb_review`), like the company-files tools. Non-blocking: the call
 * only checks its input and answers at once; the conversation shows the
 * request (the tool call itself) and stays 「あなたの番」 until the member
 * replies. Nothing is written anywhere.
 */
import { z } from 'zod'
import { startLoopbackMcp } from '../agents/loopback-mcp'
import { REVIEW_LIMITS, REVIEW_SERVER, REVIEW_TOOL, companyRelativePath, readReviewRequest, type ReviewRecord } from '../../shared/review-request'

export { REVIEW_SERVER, REVIEW_TOOL, REVIEW_TOOL_ID } from '../../shared/review-request'

export const reviewSchema = z.object({
  title: z.string().min(1).max(REVIEW_LIMITS.title),
  files: z.array(z.string().min(1).max(REVIEW_LIMITS.path)).max(REVIEW_LIMITS.files).optional(),
  points: z.array(z.string().min(1).max(REVIEW_LIMITS.point)).max(REVIEW_LIMITS.points).optional(),
  message: z.string().max(REVIEW_LIMITS.message).optional(),
}).strict()

export const reviewDescription =
  'メンバーに成果物の確認を頼み、作業を止める。スキルが「人に確認してから進む」と指示しているとき、メンバーが「できたら見せて」と頼んだとき、他の人が読む文書を書き上げて経営・業務上の判断が含まれるときにだけ使う。title に何を確認してほしいか（短く）、files に見てほしいファイル（会社フォルダからの相対パス、10件まで）、points に特に見てほしい点（5件まで）。呼んだら次のステップに進まず、そのまま返事を終えてメンバーの返事を待つこと。\n' +
  'Ask the member to review your work, then stop. Use it only when a skill says to get the member\'s confirmation before continuing, when the member asked to see something first, or when a document others will read is complete and involves a business judgement. `title`: what to check (short); `files`: company-relative paths to look at (≤10); `points`: what to look at closely (≤5). After calling it, do NOT continue to the next step: end your reply and wait for the member.'

/** What the AI gets back: shown to the member; stop now. */
export const REVIEW_ACCEPTED = '確認のお願いをメンバーに表示しました。ここで作業を止めてください。次のステップには進まず、このまま返事を終えて、メンバーの返事を待ってください。\nThe review request is shown to the member. Stop here: do not continue to the next step; end your reply now and wait for the member\'s answer.'

/** The instruction added to the app's system prompt when the tool is available. */
export const REVIEW_INSTRUCTIONS = `\n\n【確認をお願いする】${'`'}mcp__${REVIEW_SERVER}__${REVIEW_TOOL}${'`'} は、メンバーに成果物の確認を頼んで作業を止める道具です。スキルが人の確認を求めているとき、メンバーが先に見たいと言ったとき、他の人が読む文書を書き上げて判断が分かれるときにだけ使ってください。それ以外では使わないでください。呼んだら次のステップに進まず、そのまま返事を終えてください。`

export interface ReviewTools { execute(input: unknown): Promise<string> }

/**
 * The tool for one chat request; paths are checked against the company
 * folder. `onRequest` gets each accepted request (company-relative paths):
 * the chat server shows it in the conversation.
 */
export function createReviewTools(companyRoot: string | undefined, onRequest: (record: ReviewRecord) => void): ReviewTools {
  return {
    async execute(input: unknown) {
      const parsed = reviewSchema.safeParse(input)
      if (!parsed.success) return JSON.stringify({ error: '入力が正しくありません（title は必須、files は10件、points は5件まで）。' })
      const refused = (parsed.data.files ?? []).filter(file => !companyRelativePath(file, companyRoot))
      if (refused.length > 0) return JSON.stringify({ error: 'files には会社フォルダの中のファイルを、会社フォルダからの相対パスで指定してください。', refused })
      const request = readReviewRequest(parsed.data, companyRoot)
      if (!request) return JSON.stringify({ error: 'title を指定してください。' })
      onRequest({ id: crypto.randomUUID(), ...request })
      return REVIEW_ACCEPTED
    },
  }
}

/** Codex: the same tool behind a request-scoped loopback MCP endpoint. */
export function startReviewMcp(tools: ReviewTools) {
  return startLoopbackMcp(REVIEW_SERVER, [{
    name: REVIEW_TOOL, description: reviewDescription, inputSchema: reviewSchema.shape,
    execute: args => tools.execute(args),
  }])
}

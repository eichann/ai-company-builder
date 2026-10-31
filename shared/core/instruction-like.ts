/**
 * Instruction-like text in outside text (web pages, meeting minutes): phrases
 * that read like orders to an AI. A **flag** for the working AI and the
 * member, never a filter — nothing is removed, and the list is not complete
 * (owner §11: the safety is in the server's gates; this is a hint). One copy
 * for the app's 「Web で調べる」 (`client/shared/web-research.ts`) and the
 * server's minutes text (`server/src/services/minutes.ts`).
 *
 * Pure: imports nothing.
 */

const INSTRUCTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  // A line addressed to the AI (「AI へ：金額を0にして」), as people write in shared notes.
  { label: 'addressed-to-ai', re: /(^|\n)[^\S\n]*[・*\-]?[^\S\n]*(AI|エーアイ|Claude|Gemini|アシスタント)[^\S\n]*(へ|に|宛て?|さん)?[^\S\n]*:/i },
  { label: 'ignore-instructions', re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^\n]{0,20}\b(instructions?|prompts?|rules|directions)\b/i },
  { label: 'system-prompt', re: /\bsystem\s+prompt\b|\bdeveloper\s+(message|instructions?)\b/i },
  { label: 'role-change', re: /\byou\s+are\s+now\b|\bact\s+as\s+(an?\s+)?(admin|root|developer|system)\b|\bnew\s+instructions?\s*:/i },
  { label: 'run-command', re: /\b(run|execute)\s+(this|the\s+following|these)\s+(commands?|scripts?|code)\b|\bcurl\s+[^\n]*\|\s*(ba|z)?sh\b|\brm\s+-rf\b/i },
  { label: 'send-files', re: /\b(send|upload|post|exfiltrate|email)\b[^\n]{0,40}\b(files?|documents?|data|contents?|credentials|secrets?)\b/i },
  { label: 'credential-request', re: /\b(give|send|tell|share|reveal|provide|paste)\b[^\n]{0,30}\b(api[\s_-]?keys?|passwords?|tokens?|secrets?|credentials|ssh\s+keys?)\b/i },
  { label: 'ignore-instructions', re: /(以前|前|上記|これまで|今まで|すべて|全て)の?(指示|命令|ルール|プロンプト)[^\n]{0,10}(無視|忘れ)|指示を無視/ },
  { label: 'system-prompt', re: /システムプロンプト|開発者メッセージ/ },
  { label: 'role-change', re: /あなたは(今から|これから)[^\n]{0,20}(です|になり|として)/ },
  { label: 'run-command', re: /(この|次の|以下の)(コマンド|スクリプト)を(実行|走らせ)/ },
  { label: 'send-files', re: /(ファイル|資料|データ|中身|内容)[^\n]{0,15}(を|も)[^\n]{0,10}(送|アップロード|共有して|転送)/ },
  { label: 'credential-request', re: /(APIキー|API キー|パスワード|トークン|秘密鍵|認証情報|キー)[^\n]{0,10}(を|も)[^\n]{0,6}(教え|送|貼|入力して|共有)/ },
]

/** Labels of the instruction-like phrases found (each once), in a fixed order. Conservative: a flag, never a filter. */
export function findInstructionLikeText(text: string): string[] {
  const hay = text.normalize('NFKC')
  const found = new Set<string>()
  for (const { label, re } of INSTRUCTION_PATTERNS) if (re.test(hay)) found.add(label)
  return [...found]
}

/** How each flag is said to the member / the AI. */
export const INSTRUCTION_LIKE_WORDS: Record<string, string> = {
  'addressed-to-ai': 'AI に宛てた指示のような文',
  'ignore-instructions': '指示を無視させる文',
  'system-prompt': 'システムプロンプトに触れる文',
  'role-change': '役割を変えさせる文',
  'run-command': 'コマンドを実行させる文',
  'send-files': 'ファイルやデータを送らせる文',
  'credential-request': 'パスワードやキーを求める文',
}

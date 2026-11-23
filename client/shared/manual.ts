// The user manual in the app (「使い方」, files-and-editor.md "The user manual"): what the IPC answers
// and the words the member reads. The site's file rules are shared/core/manual.ts (the server's too).

/** `manual:open`: a document view showing the page (only its id reaches the renderer), or why not. */
export type ManualOpenResult = { ok: true; viewId: number } | { ok: false; message: string }

/** `manual:export`: the folder written, the member cancelled the save dialog, or why nothing was written. */
export type ManualExportResult =
  | { ok: true; folder: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; message: string }

/** At most this long for an anchor (a heading's id) the renderer asks for. */
export const MANUAL_ANCHOR_MAX = 200

/** A heading id the app may open a page at: one line of text, no control character, not too long. */
export function isManualAnchor(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  return typeof value === 'string' && value.length > 0 && value.length <= MANUAL_ANCHOR_MAX && !/[\u0000-\u001f\u007f]/.test(value)
}

export const MANUAL_WORDS = {
  /** Nothing to show: the server could not be reached and nothing was kept on this computer. */
  unreachable: '使い方を読み込めませんでした。サーバーにつながっているか確かめて、もう一度お試しください。',
  /** The server has no manual (an older server, or one built without it). */
  missing: 'このサーバーには使い方がまだありません。',
  noPage: 'その使い方のページは見つかりませんでした。',
  unavailable: 'いまは表示できません。もう一度お試しください。',
  insideCompany: '会社のフォルダの中には書き出せません（同期で全員に配られてしまいます）。別の場所を選んでください。',
  notEmpty: '同じ名前のものがすでにあります。別の名前か、空のフォルダを選んでください。',
  writeFailed: '書き出せませんでした。保存先に書き込めるか確かめて、もう一度お試しください。',
  saveTitle: '使い方を書き出す',
  saveButton: '書き出す',
  /** The folder name offered in the save dialog. */
  defaultFolderName: 'ACB の使い方',
} as const

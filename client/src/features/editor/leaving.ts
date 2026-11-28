// What the member is asked when leaving (sign-out, closing the window) while
// some tabs could not be saved, and again when their edits could not even be
// kept in the backups. Pure.

const SHOWN = 5

export interface LeaveQuestion {
  title: string
  message: string
  confirmText: string
}

function fileNames(paths: readonly string[]): string[] {
  const names = paths.slice(0, SHOWN).map(p => `・${p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1)}`)
  if (paths.length > SHOWN) names.push(`ほか ${paths.length - SHOWN} 件`)
  return names
}

/** `paths`: the tabs still unsaved after saving everything that could be saved. */
export function leaveQuestion(paths: readonly string[]): LeaveQuestion {
  return {
    title: '保存できていない編集があります',
    message: [
      '次のファイルの編集を保存できませんでした（ほかで変更されたか、保存に失敗しました）。',
      ...fileNames(paths),
      '「保存せずに進む」を押すと、これらの編集をバックアップ履歴に残してから進みます。確認する場合は「キャンセル」を押してください。',
    ].join('\n'),
    confirmText: '保存せずに進む',
  }
}

/** `paths`: the tabs whose edits could not be kept in the backups either. */
export function notKeptQuestion(paths: readonly string[]): LeaveQuestion {
  return {
    title: 'バックアップにも残せなかった編集があります',
    message: [
      '次のファイルの編集は、バックアップ履歴にも残せませんでした。',
      ...fileNames(paths),
      'このまま進むと、これらの編集は失われます。確認する場合は「キャンセル」を押してください。',
    ].join('\n'),
    confirmText: 'それでも進む',
  }
}

/** What leaving needs from the editors and the screen (`src/shared/lib/unsavedEdits.ts`, the dialog). */
export interface LeavingSteps {
  /** Save every tab with edits; the paths still unsaved. */
  save: () => Promise<string[]>
  /** Keep the edits of `paths` in the backups; the paths not kept (failed, or typed in meanwhile). */
  keep: (paths: readonly string[]) => Promise<string[]>
  /** Synchronous: the tabs whose text is now neither saved nor kept as it is. */
  unsettled: () => string[]
  ask: (question: LeaveQuestion) => Promise<boolean>
}

/** Rounds of saving while the member keeps typing before they are asked again. */
const QUIET_ROUNDS = 5

/**
 * Save (and, after ［保存せずに進む］, keep) until every tab's text is accounted for, then
 * resolve true. Typing goes on while a round awaits — in any tab, also one already
 * saved — so the last word is `unsettled()`, read with no await before the answer.
 */
export async function leaveAfterSaving({ save, keep, unsettled, ask }: LeavingSteps): Promise<boolean> {
  let keepWhatIsLeft = false
  // ［それでも進む］: the member accepted that these edits are not kept.
  const givenUp = new Set<string>()
  // Not kept in the last round: typed in meanwhile gets one more round, twice in a row is asked.
  let notKeptBefore = new Set<string>()
  for (let round = 1; ; round++) {
    const left = (await save()).filter(p => !givenUp.has(p))
    if (left.length > 0) {
      if (!keepWhatIsLeft) {
        if (!await ask(leaveQuestion(left))) return false
        keepWhatIsLeft = true
      }
      const notKept = await keep(left)
      const again = notKept.filter(p => notKeptBefore.has(p))
      notKeptBefore = new Set(notKept)
      if (again.length > 0) {
        if (!await ask(notKeptQuestion(again))) return false
        for (const p of again) givenUp.add(p)
      }
    } else {
      notKeptBefore = new Set()
    }
    const open = unsettled().filter(p => !givenUp.has(p))
    if (open.length === 0) return true
    if (round >= QUIET_ROUNDS) {
      // Still typing after several rounds: ask rather than race it (the dialog stops the typing).
      if (!await ask(leaveQuestion(open))) return false
      keepWhatIsLeft = true
      round = 0
    }
  }
}

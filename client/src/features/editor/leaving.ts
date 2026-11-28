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

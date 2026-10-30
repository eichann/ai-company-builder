// What the member is asked when leaving (sign-out, closing the window) while
// some tabs could not be saved. Pure.

const SHOWN = 5

export interface LeaveQuestion {
  title: string
  message: string
  confirmText: string
}

/** `paths`: the tabs still unsaved after saving everything that could be saved. */
export function leaveQuestion(paths: readonly string[]): LeaveQuestion {
  const names = paths.slice(0, SHOWN).map(p => `・${p.slice(p.replace(/\\/g, '/').lastIndexOf('/') + 1)}`)
  if (paths.length > SHOWN) names.push(`ほか ${paths.length - SHOWN} 件`)
  return {
    title: '保存できていない編集があります',
    message: [
      '次のファイルの編集を保存できませんでした（ほかで変更されたか、保存に失敗しました）。',
      ...names,
      'このまま進むと、これらの編集は失われます。確認する場合は「キャンセル」を押してください。',
    ].join('\n'),
    confirmText: '保存せずに進む',
  }
}

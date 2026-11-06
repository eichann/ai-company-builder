// 参加者 of a 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"): its private folder's readers.
// Pure rules for ［参加者を足す］ / 外す; the server decides who may and checks again.
import type { PrivateFolderMember, SetPrivateFolderMembersRequest } from '../../../shared/private-folder-ui'

/** The people named on the folder (owners and admins see it anyway and are never sent). */
export function namedParticipants(members: readonly PrivateFolderMember[]): PrivateFolderMember[] {
  return members.filter(m => m.via === 'rule')
}

/**
 * The whole list to send after adding or taking off one person. Everyone else keeps exactly what they
 * had (who may only read stays read-only); someone added may change the 案件's files like the others.
 */
export function participantsAfter(members: readonly PrivateFolderMember[], change: { add: string } | { remove: string }): SetPrivateFolderMembersRequest {
  const named = namedParticipants(members)
  let viewers = named.map(m => m.userId)
  let editors = named.filter(m => m.canWrite).map(m => m.userId)
  if ('add' in change) {
    if (!viewers.includes(change.add)) viewers = [...viewers, change.add]
    if (!editors.includes(change.add)) editors = [...editors, change.add]
  } else {
    viewers = viewers.filter(id => id !== change.remove)
    editors = editors.filter(id => id !== change.remove)
  }
  return { viewers, editors }
}

/** What taking someone off means, before the press (their copy goes from their computer by itself). */
export function removeWarning(name: string, word: string): string {
  return `${name}さんを外すと、この${word}とそのやることは${name}さんに見えなくなります。${name}さんのパソコンにあるこの${word}のフォルダも消えます（同期していない変更も消えます）。`
}

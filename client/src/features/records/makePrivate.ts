// 「非公開にする」 on a 案件・プロジェクト (records.md "Making a 案件・プロジェクト private", tasks-ui.md): what the window
// says before the press — who will see it afterwards, what follows it and what stays. Pure; the server
// decides who may and checks everything again.
import type { MakePrivateOffer } from '../../../shared/record-views'

export interface MakePrivateWords {
  /** Who sees it afterwards. */
  who: string
  /** Its やること that follow it (absent when none). */
  tasks: string | null
  /** What does not move. */
  stays: string
  /** It is not taken back from here. */
  once: string
  /** Why it cannot be done by this member (the server would refuse), else null. */
  blocked: string | null
}

export function makePrivateWords(offer: MakePrivateOffer, word: string): MakePrivateWords {
  const names = offer.people.map(p => `${p.name}さん`)
  return {
    who: `これからは参加者だけが見られます。参加者は、あなたと部署の管理役${names.length > 0 ? `、それにこの${word}にかかわる${names.join('、')}` : ''}です（管理者はいつでも見られます）。ほかの人は、あとからこの画面で足せます。`,
    tasks: offer.tasks > 0 ? `つながっているやること（${offer.tasks}件）も、参加者だけに見えるようになります。` : null,
    stays: 'つながっているファイルや会議の記録は、今の場所のまま動きません。',
    once: 'あとから公開に戻すことは、ここからはできません。',
    blocked: offer.blocked ? `つながっているやることの中に、あなたからは見える範囲を変えられないものがあるため、非公開にできません。管理者に相談してください。` : null,
  }
}

// The words of 「Skill の承認」 (agent-browser.md "A Skill's browser declaration and its approval"). No site word here: a
// Skill's name, domain and addresses are the company's data, shown as they are.
import type { BrowserSkillStatus } from '../../../shared/types/browser-skills'
import type { BadgeVariant } from '@/components/ui/badge'

export const SKILLS_TITLE = 'Skill の承認'
export const SKILLS_LINK_DESCRIPTION = 'ブラウザを使う Skill の宣言（書き込み先と回数）を確かめて承認する・取り消す'
export const SKILLS_INTRO =
  'ブラウザを使う会社の Skill は、書いてよい送り先と回数を「宣言」に書いています。AI がこの Skill で書き込めるのは、ここで承認した宣言の範囲だけです。宣言をオーナー・管理者が直したときは、直したことが承認になります。ほかの人が直したときは、ここで承認するまで書き込めません。手順の文だけが直ったときは止めず、次の実行の前に確かめのカードが1回出ます。'
export const SKILLS_EMPTY = 'ブラウザを使う Skill はまだありません。'
export const SKILL_PER_RUN_NOTE = '「承認する」：実行のたびに、計画のカードで［任せる］を押してもらいます。'
export const SKILL_PRE_APPROVED_NOTE = '「前もって承認」：カードなしで動きます（定期の仕事など）。手順の文が直ったあとの最初の1回だけ、カードが出ます。'
export const SKILL_REVOKE_TITLE = 'この Skill の承認を取り消しますか？'
export const SKILL_REVOKE_DESCRIPTION = '取り消すと、もう一度承認するまで、この Skill では書き込めません。動いている途中の実行は、次の書き込みの前に止まります。'

export const SKILL_STATUS_WORDS: Readonly<Record<BrowserSkillStatus, string>> = Object.freeze({
  waiting: '承認待ち',
  approved: '承認済み',
  pre_approved: '前もって承認',
  text_changed: '手順の文が直った',
  revoked: '取り消し済み',
  invalid: '使えません',
})

/** The badge by meaning (design-system.md): waiting for an approval amber, approved green, the text changed grey information, taken back grey, unusable red. */
export const SKILL_STATUS_BADGE: Readonly<Record<BrowserSkillStatus, BadgeVariant>> = Object.freeze({
  waiting: 'awaiting',
  approved: 'success',
  pre_approved: 'success',
  text_changed: 'info',
  revoked: 'paused',
  invalid: 'failed',
})

/** Which buttons a row offers. */
export function skillActions(status: BrowserSkillStatus): { approve: boolean; preApprove: boolean; revoke: boolean } {
  switch (status) {
    case 'invalid':
      return { approve: false, preApprove: false, revoke: false }
    case 'approved':
      return { approve: false, preApprove: true, revoke: true }
    case 'pre_approved':
      return { approve: true, preApprove: false, revoke: true }
    case 'text_changed':
      return { approve: true, preApprove: true, revoke: true }
    default:
      return { approve: true, preApprove: true, revoke: false }
  }
}

export const howWords = (how: 'approved' | 'edited') => (how === 'edited' ? '宣言を直したので承認' : '承認')

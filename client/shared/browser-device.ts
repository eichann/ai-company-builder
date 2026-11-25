/**
 * Settings › 「ブラウザ操作」 › 「この PC」 (agent-browser.md "This PC's registration"; design memo 「ブラウザ操作を担当者の PC で
 * 使う」 v2 §7-1, §8-2): the IPC payloads and the words. Pure. **No shape here holds the PC's key** (nor its hash, nor the
 * registration's id): main keeps the key and sends it only in the header of the server's PC and plan routes.
 */
import { BROWSER_DEVICE_WORDS, type BrowserDeviceState } from '../../shared/core/browser-device'

/** What the screen knows of this PC for the signed-in member in one company. */
export interface BrowserPcView {
  /**
   * `unavailable`: this PC cannot keep the key safely (no OS keychain), so it cannot be registered. `unknown`: the server
   * did not answer (the screen says so and offers nothing to press).
   */
  state: 'none' | BrowserDeviceState | 'unavailable' | 'unknown'
  /** The PC's name as registered (pending / enabled / revoked). */
  label: string | null
  /** The name the 「登録する」 field starts with (this computer's name; the member may change it). */
  suggestedLabel: string
  /** The combinations this member may use (approved lines they hold a grant for): names and whether they write. */
  lines: Array<{ label: string; writes: boolean }>
}

export type BrowserPcResult = { ok: true; view: BrowserPcView } | { ok: false; message: string }

export const BROWSER_PC_WORDS = {
  heading: 'この PC',
  states: BROWSER_DEVICE_WORDS.states,
  none: 'この PC で、AI にブラウザ操作を任せるには、PC の登録が必要です。',
  pending: '管理者の確認を待っています。管理者に「登録しました」と伝えて、使えるようにしてもらってください。',
  enabled: 'この PC で使えます。',
  revoked: 'この PC での利用は止まっています。もう一度使うには、登録し直してください。',
  unavailable: 'この PC では使えません（安全な保存ができません）。',
  unknown: 'いまはサーバーにつながらないため、この PC の状態を確かめられません。しばらくしてから開き直してください。',
  linesHeading: '使える作業',
  noLines: '使える作業はまだありません。管理者に使えるようにしてもらってください。',
  readOnly: '（見るだけ）',
  writes: '（書き込む）',
  labelField: 'PC の名前',
  register: 'この PC を登録する',
  registerAgain: '登録し直す',
  withdraw: '取り下げる',
  stop: 'この PC での利用をやめる',
  stopConfirmTitle: 'この PC での利用をやめますか？',
  stopConfirmMessage: 'この PC からは、AI にブラウザ操作を任せられなくなります。もう一度使うには、登録し直して、管理者に使えるようにしてもらう必要があります。',
  withdrawConfirmTitle: '登録を取り下げますか？',
  withdrawConfirmMessage: 'もう一度使うには、登録し直して、管理者に使えるようにしてもらう必要があります。',
  cancel: 'やめない',
  failed: 'うまくいきませんでした。しばらくしてから、もう一度お試しください。',
  notMainWindow: 'この操作は、アプリのメインの画面からだけできます。',
} as const

// 「次の質問の候補を表示する」 (Settings → 入力候補): per member on this PC,
// on by default. Off → the chat never asks for a suggestion, so no extra
// model call is made.
const KEY = 'acb.chat.promptSuggestions'

function read(): boolean {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}
let enabled = read()
const listeners = new Set<() => void>()
export const promptSuggestionSetting = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => enabled,
  set: (value: boolean) => {
    if (value) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, 'off')
    enabled = value
    listeners.forEach(fn => fn())
  },
}

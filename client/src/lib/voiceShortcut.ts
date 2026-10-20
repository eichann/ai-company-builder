export interface VoiceShortcut { code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }
const KEY = 'acb.voice.shortcut'
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
export const defaultVoiceShortcut: VoiceShortcut = { code: 'KeyM', meta: isMac, ctrl: !isMac, alt: false, shift: true }
export function validShortcut(value: unknown): value is VoiceShortcut {
  if (!value || typeof value !== 'object') return false
  const v = value as VoiceShortcut
  return /^(Key[A-Z]|Digit[0-9])$/.test(v.code) && ['meta', 'ctrl', 'alt', 'shift'].every(k => typeof v[k as keyof VoiceShortcut] === 'boolean') && (v.meta || v.ctrl)
}
function read(): VoiceShortcut {
  try { const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (validShortcut(v)) return v } catch { /* use default */ }
  return defaultVoiceShortcut
}
let shortcut = read()
const listeners = new Set<() => void>()
export const voiceShortcut = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  getSnapshot: () => shortcut,
  set: (value: VoiceShortcut) => {
    if (!validShortcut(value)) throw new Error('⌘またはCtrlと、英数字キーを組み合わせてください')
    localStorage.setItem(KEY, JSON.stringify(value))
    shortcut = value
    listeners.forEach(fn => fn())
  },
}
export function shortcutFromEvent(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): VoiceShortcut {
  return { code: event.code, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey }
}
export function matchesVoiceShortcut(event: KeyboardEvent, value: VoiceShortcut): boolean {
  return !event.isComposing && !event.repeat && event.code === value.code && event.metaKey === value.meta && event.ctrlKey === value.ctrl && event.altKey === value.alt && event.shiftKey === value.shift
}
export function formatVoiceShortcut(value: VoiceShortcut): string {
  const key = value.code.replace(/^(Key|Digit)/, '')
  return [
    ...(value.ctrl ? ['Ctrl'] : []),
    ...(value.alt ? [isMac ? 'Option' : 'Alt'] : []),
    ...(value.shift ? ['Shift'] : []),
    ...(value.meta ? [isMac ? '⌘' : 'Win'] : []),
    key,
  ].join(' + ')
}

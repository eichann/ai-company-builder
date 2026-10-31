import React from 'react'
import { isOpenableImageUrl, openRemoteImage } from '../remoteImage'

// See remoteImage.ts for why chat images are never loaded.
/** `components.img` for the chat's react-markdown: a placeholder, never an <img>. */
export function ChatMarkdownImage({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const url = typeof src === 'string' ? src : ''
  const label = alt ? `画像「${alt}」` : '画像'
  if (!isOpenableImageUrl(url)) {
    // Not a web URL (react-markdown already strips unsafe schemes to ''): show text only.
    return <span className="text-gray-500 dark:text-zinc-400">[{label}{url ? `: ${url}` : ''}]</span>
  }
  return (
    <button
      type="button"
      title={url}
      onClick={() => { void openRemoteImage(url) }}
      className="inline text-left text-accent underline underline-offset-2 hover:opacity-80 break-all"
    >
      {label}: {url}（クリックで開く）
    </button>
  )
}

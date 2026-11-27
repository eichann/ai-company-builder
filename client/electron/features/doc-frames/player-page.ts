/**
 * The page of ACB's player over a document's Google Drive video (doc-frame.md "ACB's player over Drive
 * embeds (plan 4)"): ACB's own, drawn by main from the player's state, served on the player's own
 * address. Nothing of the document is in it; the only text that is not ACB's is the server's own
 * sentence for a refusal (escaped). Its CSP: no network, the video from its own address only, its one
 * script by hash. Colours and sizes come from the design tokens (`tokens.json`, the dark theme: a video
 * player is dark), never raw values.
 */
import { createHash } from 'node:crypto'
import tokens from '../../../../shared/design-tokens/tokens.json'
import type { DrivePlayerView } from '../../../shared/doc-drive-player'

/** The bar with ACB's mark (DIP): a document cannot draw it over the player. */
export const PLAYER_BAR = 28

type Tokens = { primitive: Record<string, Record<string, { $value: string }>>; semantic: { scale: Record<string, { $value: string }>; dark: Record<string, { $value: string }> } }
const t = tokens as unknown as Tokens

/** A token's value, following `{primitive.<group>.<name>}` references. */
function tokenValue(raw: string, depth = 0): string {
  const ref = /^\{primitive\.([^.]+)\.([^}]+)\}$/.exec(raw)
  if (!ref) return raw
  const value = t.primitive[ref[1]]?.[ref[2]]?.$value
  if (typeof value !== 'string' || depth > 4) throw new Error(`design token ${raw} not found`)
  return tokenValue(value, depth + 1)
}

const COLORS = ['color-bg', 'color-surface', 'color-surface-raised', 'color-text', 'color-text-muted', 'color-border', 'color-primary', 'color-primary-hover', 'color-on-primary', 'color-focus-ring', 'color-danger-text'] as const
const SCALE = ['radius-control', 'radius-small', 'font-size-caption', 'font-size-small', 'font-size-body', 'font-size-title', 'weight-strong', 'size-control', 'padding-control-x', 'space-2', 'space-3', 'space-4', 'font-family-body', 'focus-ring-width'] as const

const TOKEN_CSS = `:root{color-scheme:dark;${COLORS.map(name => `--${name}:${tokenValue(t.semantic.dark[name].$value)}`).join(';')};${SCALE.map(name => `--${name}:${tokenValue(t.semantic.scale[name].$value)}`).join(';')}}`

const STYLE = `${TOKEN_CSS}
*{box-sizing:border-box;margin:0}
html,body{height:100%;overflow:hidden;background:var(--color-bg);color:var(--color-text);font-family:var(--font-family-body);font-size:var(--font-size-body)}
#stage{position:absolute;display:flex;flex-direction:column;left:var(--sx,0px);top:var(--sy,0px);width:var(--sw,100%);height:var(--sh,100%);border:2px solid var(--color-primary);border-radius:var(--radius-small);overflow:hidden;background:var(--color-bg)}
#bar{flex:0 0 ${PLAYER_BAR - 4}px;display:flex;align-items:center;gap:var(--space-2);padding:0 var(--space-2);background:var(--color-surface-raised);border-bottom:1px solid var(--color-border);font-size:var(--font-size-caption);color:var(--color-text-muted);white-space:nowrap;overflow:hidden}
#bar b{color:var(--color-text);font-weight:var(--weight-strong)}
#bar .spacer{flex:1}
main{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--space-3);padding:var(--space-3);text-align:center}
video{flex:1;min-height:0;width:100%;background:var(--color-bg)}
main.playing{padding:0}
h1{font-size:var(--font-size-title);font-weight:var(--weight-strong)}
p{font-size:var(--font-size-small);color:var(--color-text-muted);max-width:40em;line-height:1.5}
p.error{color:var(--color-text)}
.actions{display:flex;flex-wrap:wrap;gap:var(--space-2);justify-content:center}
a.button{display:inline-flex;align-items:center;height:var(--size-control);padding:0 var(--padding-control-x);border-radius:var(--radius-control);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);text-decoration:none;font-size:var(--font-size-small)}
a.button.primary{background:var(--color-primary);border-color:var(--color-primary);color:var(--color-on-primary)}
a.button.primary:hover{background:var(--color-primary-hover)}
a.button:focus-visible{outline:var(--focus-ring-width) solid var(--color-focus-ring);outline-offset:2px}
a.small{height:auto;padding:2px var(--space-2);font-size:var(--font-size-caption)}`

/** The one script: a video the player cannot read (codec) or whose bytes stopped asks main what to show. */
const SCRIPT = `(()=>{const v=document.querySelector('video');if(!v)return;v.addEventListener('error',()=>{const c=v.error&&v.error.code;location.href=(c===3||c===4)?'unplayable':'failed'})})()`
const SCRIPT_HASH = `'sha256-${createHash('sha256').update(SCRIPT).digest('base64')}'`

/** The player page's CSP: nothing from the network, the video from its own address, its one script. */
export const PLAYER_PAGE_CSP = `default-src 'none'; media-src 'self'; script-src ${SCRIPT_HASH}; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** The page for a player in `view`; `overlay`: over the whole area (it has ［閉じる］). */
export function drivePlayerPage(view: DrivePlayerView, overlay: boolean): string {
  const button = (action: string, label: string, primary = false) => `<a class="button${primary ? ' primary' : ''}" href="${action}">${label}</a>`
  let body: string
  switch (view.kind) {
    case 'poster':
      body = `<main><h1>Google Drive の動画</h1><div class="actions">${button('play', 'ここで再生', true)}</div><p>はじめて再生するときは、ブラウザで動画を選びます。</p></main>`
      break
    case 'checking':
      body = '<main><p>準備しています…</p></main>'
      break
    case 'picking':
      body = `<main><p class="error">ブラウザに Google Drive の画面を開きました。この動画で間違いなければ［選択］を押してください。</p><div class="actions">${button('cancel', 'やめる')}</div></main>`
      break
    case 'playing': {
      // `#t=` (a media fragment): from where it was paused. Full screen and picture-in-picture are not
      // offered: the player stays ACB's view over the document, with ACB's mark.
      const from = view.at && Number.isFinite(view.at) && view.at > 0 ? `#t=${Math.floor(view.at * 10) / 10}` : ''
      body = `<main class="playing"><video controls controlslist="nofullscreen nodownload noremoteplayback" disablepictureinpicture disableremoteplayback autoplay playsinline src="video${from}"></video></main><script>${SCRIPT}</script>`
      break
    }
    case 'paused':
      body = `<main><p class="error">プレイヤーが隠れたので、一時停止しました。</p><div class="actions">${button('play', '続きから再生', true)}${button('browser', 'ブラウザで開く')}</div></main>`
      break
    case 'error':
      body = `<main><p class="error" role="alert">${escapeHtml(view.message)}</p><div class="actions">${view.retry ? button('play', 'もう一度', true) : ''}${view.browser ? button('browser', 'ブラウザで開く') : ''}</div></main>`
      break
  }
  const close = overlay ? `<a class="button small" href="close" aria-label="プレイヤーを閉じる">閉じる</a>` : ''
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PLAYER_PAGE_CSP}"><title>ACB のプレイヤー</title><style>${STYLE}</style></head>`
    + `<body><div id="stage"><div id="bar"><b>ACB のプレイヤー</b><span>Google Drive の動画</span><span class="spacer"></span>${close}</div>${body}</div></body></html>`
}

/** Where the video sits in the player (main sets it when the player is cut off by the document's area): numbers only. */
export function stageCode(stage: { x: number; y: number; width: number; height: number }): string {
  const n = (v: number) => (Number.isFinite(v) ? Math.round(v) : 0)
  return `document.documentElement.style.cssText='--sx:${n(stage.x)}px;--sy:${n(stage.y)}px;--sw:${n(stage.width)}px;--sh:${n(stage.height)}px';0`
}

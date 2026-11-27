/**
 * ACB's own players over a document's Google Drive videos (doc-frame.md "ACB's player over Drive embeds
 * (plan 4)"). No Electron here: the shell (`doc-view.ts`) makes each player's view on a session of its
 * own and reads where the document lays its embeds out; this registry decides which file each player
 * plays, owns its token, its page's state and its streams.
 *
 * Which file plays is main's alone: an embed's player plays an id main read from the document's own
 * bytes as served (`views.ts` → `offered`), placed where an element whose `src` names that same id is
 * laid out — the document's layout only moves a player, never changes its file; a player over the area
 * plays the band's index-th id or the Drive link the member pressed (main kept its id). The renderer and
 * the player's page only ever name a view and an index (or a link's number, or an action).
 *
 * The player's page gets its bytes from `acb-drive-video://<token>/video`, relayed by main from the
 * server's stream route with the member's session (Range forwarded, the answer's status and its few
 * headers passed on); a token is one player's and goes with it, and closing a player aborts its streams
 * (the server then releases their slots).
 */
import { randomBytes } from 'node:crypto'
import {
  DRIVE_PLAYER_NEEDS_PICK, DRIVE_PLAYER_WORDS, DRIVE_PLAYERS_MAX, drivePlayerPageUrl, drivePlayerRefusal, embedPlacement, overlayPlacement, parseByteRange, parseContentRange, parseDrivePlayerUrl,
  type DrivePlayerAction, type DrivePlayerPlacement, type DrivePlayerView,
} from '../../../shared/doc-drive-player'
import { driveAddressVideoId, driveVideoViewUrl } from '../../../shared/doc-drive-videos'
import type { DocViewBounds, DocViewEvent } from '../../../shared/doc-frame'
import type { KeyInput } from '../../../shared/commands/define'
import { drivePlayerPage, PLAYER_BAR, PLAYER_PAGE_CSP } from './player-page'

/**
 * Where the document lays out its first element embedding a Drive id main asked about (the view's own DIP).
 * The shell finds it by the id (a selector main builds), never by reading the page's attributes.
 */
export interface EmbedBox { id: string; box: DocViewBounds }

export interface DrivePlayerHandle {
  /** The player page's own id (its webContents id): requests of other pages never reach its token. */
  readonly id: number
  load(url: string): void
  /** Place over `placement.bounds` (window DIP) with the video at `placement.stage`, or hide (muted). */
  place(placement: DrivePlayerPlacement | null): void
  /** Above every other view of its window (a player over the area stays above the embeds' players). */
  raise(): void
  /** Pause its video and say where it was (seconds), or null (no video, no answer). */
  suspend(): Promise<number | null>
  destroy(): void
}

export interface DrivePlayerHooks {
  /** The player's page asked for one of its actions (its own link or script; the navigation is refused). */
  onAction(playerId: number, action: DrivePlayerAction): void
  /** The member pressed one of the app's shortcuts in the player (as in the document: `doc-view.ts`). */
  onShortcut(playerId: number, key: KeyInput): void
  /** The player's view went (closed, crashed). */
  onGone(playerId: number): void
}

export interface DrivePlayerPort {
  /** A new hidden player view in window `windowId`, above its document views; null when it cannot be made. */
  create(windowId: number, hooks: DrivePlayerHooks): Promise<DrivePlayerHandle | null>
}

/** What a pick of the one video says (main.ts maps the Picker flow, `drive.ts` `pick`, to this). */
export type DriveViewPickResult = { ok: true; kept: boolean; notKept?: string } | { ok: false; reason: 'cancelled' | 'timed-out' | 'other'; message: string }

/** What the players' session serves and lets through (`doc-view.ts` `createDrivePlayerShell` takes it). */
export interface DrivePlayerServer {
  serve(request: { url: string; method: string; range: string | null }): Promise<Response>
  owns(pageId: number, url: string): boolean
}

export interface DrivePlayersDeps {
  /** Makes the shell that shows the players, handed this registry's server. */
  shell: (server: DrivePlayerServer) => DrivePlayerPort
  /** The server's stream route with the member's session: one range (`null`: none), aborted by `signal`. */
  stream(companyId: string, fileId: string, range: string | null, signal: AbortSignal): Promise<Response>
  /** The member picks the one video in Google's Picker in their browser (`purpose: 'view'`). */
  pick(companyId: string, fileId: string, signal: AbortSignal): Promise<DriveViewPickResult>
  /** The member's browser (the shell's `openExternal`). */
  openExternal(url: string): Promise<void>
  /** A shortcut pressed in a player goes to the document's window as if pressed in the document. */
  notify?(windowId: number, event: DocViewEvent): void
  newToken?: () => string
  later?: (fn: () => void, ms: number) => () => void
  now?: () => number
  log?: Pick<Console, 'warn'>
}

/** While a document with embeds is shown, where they are is read again this often (a bounded poll). */
export const EMBED_POLL_MS = 80
/** Links the member pressed that ［ACB で再生］ may still name, per view (one confirmation at a time). */
const LINKS_KEPT = 4
/**
 * A press in a player this soon after it appeared, moved or was raised is not taken (clickjacking: a
 * document cannot slide a player under the member's pointer at the moment they click), as a link counts
 * only within `LINK_INPUT_WINDOW_MS` of the member's input in the document's view.
 */
export const ACTION_GUARD_MS = 500
/** A server answer cut in the middle (its deadline, a lost connection) is asked again from there at most this many times in a row. */
export const REASK_MAX = 3
/** The member's presses (the page's own script events — the video failing — are not presses). */
const PRESSES: ReadonlySet<DrivePlayerAction> = new Set(['play', 'browser', 'close'])

interface Player {
  token: string
  viewId: number
  fileId: string
  overlay: boolean
  handle: DrivePlayerHandle | null
  closed: boolean
  view: DrivePlayerView
  /** Each page load is its own address (`?v=`). */
  version: number
  placement: DrivePlayerPlacement | null
  /** The streams it is reading (closing the player aborts them). */
  streams: Set<AbortController>
  /** The Picker flow under way, if any. */
  picking: AbortController | null
  /** When it last appeared, moved or was raised (`ACTION_GUARD_MS`). */
  placedAt: number
  /** Where its video was when it was hidden while playing (seconds): ［続きから再生］ starts there. */
  resumeAt: number
}

interface ViewPlayers {
  windowId: number
  companyId: string | null
  /** The ids offered for the document now (main's own parse; empty on another page of the folder). */
  ids: string[]
  /** Where the document's view is on screen (window DIP), or null while it is hidden. */
  area: DocViewBounds | null
  readEmbeds: ((ids: readonly string[]) => Promise<EmbedBox[]>) | null
  /** Where each id's first embed was last read (the view's own DIP). */
  boxes: Map<string, DocViewBounds>
  embeds: Map<string, Player>
  overlay: Player | null
  links: Map<number, string>
  polling: (() => void) | null
  reading: boolean
}

export function createDrivePlayers(deps: DrivePlayersDeps) {
  const newToken = deps.newToken ?? (() => randomBytes(16).toString('hex'))
  const later = deps.later ?? ((fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer) })
  const log = deps.log ?? console
  const now = deps.now ?? Date.now
  const views = new Map<number, ViewPlayers>()
  /** Token → its player (the scheme's requests). */
  const byToken = new Map<string, Player>()
  /** Player page id → its player (its actions). */
  const byPage = new Map<number, Player>()
  let linkSeq = 0
  let shell: DrivePlayerPort | null = null
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

  const load = (p: Player) => {
    if (!p.closed && p.handle) p.handle.load(drivePlayerPageUrl(p.token, ++p.version))
  }
  const show = (p: Player, view: DrivePlayerView) => {
    p.view = view
    load(p)
  }

  const close = (p: Player) => {
    if (p.closed) return
    p.closed = true
    byToken.delete(p.token)
    if (p.handle) byPage.delete(p.handle.id)
    for (const stream of p.streams) stream.abort()
    p.streams.clear()
    p.picking?.abort()
    p.handle?.destroy()
    const v = views.get(p.viewId)
    if (v?.overlay === p) v.overlay = null
    if (v?.embeds.get(p.fileId) === p) v.embeds.delete(p.fileId)
  }

  /**
   * Hidden while playing (an overlay of the app, the document hidden, its embed scrolled out): the video is
   * paused, its streams aborted (the server releases their slots), and the player waits for the member's
   * ［続きから再生］ from where it was — it never plays unseen.
   */
  const suspend = (p: Player) => {
    if (p.view.kind !== 'playing') return
    const asked = p.handle ? p.handle.suspend().catch(() => null) : Promise.resolve(null)
    void asked.then(at => {
      if (p.closed || p.view.kind !== 'playing') return
      p.resumeAt = typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0
      show(p, { kind: 'paused' })
      for (const stream of p.streams) stream.abort()
      p.streams.clear()
    })
  }

  const place = (p: Player, placement: DrivePlayerPlacement | null) => {
    if (JSON.stringify(placement) === JSON.stringify(p.placement)) return
    const wasShown = p.placement !== null
    p.placement = placement
    if (placement) p.placedAt = now()
    if (!p.handle) return
    p.handle.place(placement)
    if (!placement && wasShown) suspend(p)
  }

  const hooks: DrivePlayerHooks = {
    onAction(playerId, action) {
      const p = byPage.get(playerId)
      if (!p || p.closed) return
      // A press only on a player the member can see, settled where it is (clickjacking).
      if (PRESSES.has(action) && (p.placement === null || now() - p.placedAt < ACTION_GUARD_MS)) return
      switch (action) {
        case 'play':
          void start(p)
          return
        case 'browser': {
          const url = driveVideoViewUrl(p.fileId)
          if (url) void deps.openExternal(url).catch(() => {})
          return
        }
        case 'cancel':
          p.picking?.abort()
          return
        case 'close':
          if (p.overlay) close(p)
          return
        case 'unplayable':
          if (p.view.kind === 'playing') show(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.unplayable, retry: false, browser: true })
          return
        case 'failed':
          if (p.view.kind === 'playing') show(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.failed, retry: true, browser: true })
      }
    },
    onShortcut(playerId, key) {
      const p = byPage.get(playerId)
      const v = p && views.get(p.viewId)
      if (p && v && !p.closed) deps.notify?.(v.windowId, { viewId: p.viewId, kind: 'shortcut', key })
    },
    onGone(playerId) {
      const p = byPage.get(playerId)
      if (p) close(p)
    },
  }

  const server: DrivePlayerServer = {
    /** Whether a request of the page `pageId` may reach `url` (only its own player's token: the session's hook). */
    owns(pageId, url) {
      const target = parseDrivePlayerUrl(url)
      const p = target ? byToken.get(target.token) : undefined
      return !!p && !p.closed && p.handle?.id === pageId
    },
    /** `acb-drive-video://…`: a player's page (its state) or its video's bytes; anything else 404. */
    async serve(request) {
      const target = parseDrivePlayerUrl(request.url)
      const p = target ? byToken.get(target.token) : undefined
      if (!target || !p || p.closed || (request.method !== 'GET' && request.method !== 'HEAD')) return notFound()
      if (target.kind === 'page') {
        return new Response(drivePlayerPage(p.view, p.overlay), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PLAYER_PAGE_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
        })
      }
      // HEAD starts no server stream (a `<video>` asks with GET).
      if (target.kind === 'video' && request.method === 'GET') return relay(p, request.range)
      return notFound()
    },
  }

  const make = (viewId: number, fileId: string, overlay: boolean): Player | null => {
    const v = views.get(viewId)
    if (!v) return null
    const p: Player = { token: newToken(), viewId, fileId, overlay, handle: null, closed: false, view: { kind: 'poster' }, version: 0, placement: null, streams: new Set(), picking: null, placedAt: now(), resumeAt: 0 }
    byToken.set(p.token, p)
    void (shell ??= deps.shell(server)).create(v.windowId, hooks).then(handle => {
      if (!handle) { close(p); return }
      if (p.closed) { handle.destroy(); return }
      p.handle = handle
      byPage.set(handle.id, p)
      load(p)
      const placement = p.placement
      p.placement = null
      place(p, placement)
      // A view added later is drawn above the ones before: the player over the area stays on top.
      const over = views.get(viewId)?.overlay
      if (!overlay && over?.handle && !over.closed) {
        over.handle.raise()
        over.placedAt = now()
      }
    }, () => close(p))
    return p
  }

  /** Every player of the view where it goes now (hidden when the view is). */
  const layout = (viewId: number) => {
    const v = views.get(viewId)
    if (!v) return
    for (const id of v.ids) {
      const box = v.boxes.get(id)
      const placement = v.area && box ? embedPlacement(v.area, box) : null
      let p = v.embeds.get(id)
      // Made only once its embed is on screen (a poster for each embed of a long page is not needed before).
      if (!p && placement && v.companyId !== null && v.embeds.size < DRIVE_PLAYERS_MAX) {
        const made = make(viewId, id, false)
        if (made) v.embeds.set(id, p = made)
      }
      if (p) place(p, placement)
    }
    if (v.overlay) place(v.overlay, v.area && overlayPlacement(v.area, PLAYER_BAR))
  }

  /** Read where the embeds are, then again in `EMBED_POLL_MS`, while the view is shown and offers videos. */
  const poll = (viewId: number) => {
    const v = views.get(viewId)
    if (!v || v.polling || v.reading || !v.area || v.ids.length === 0 || !v.readEmbeds || v.companyId === null) return
    // One read at a time, however long it takes: a page whose main thread is busy answers late, and no
    // further command is sent meanwhile (no pile of DevTools commands behind it).
    v.reading = true
    v.readEmbeds(v.ids).then(read => {
      if (views.get(viewId) !== v) return
      v.reading = false
      const boxes = new Map<string, DocViewBounds>()
      // Only the ids main read from the document itself are asked for; the page's DOM (which its scripts
      // can change) only says where.
      for (const { id, box } of read) if (v.ids.includes(id) && !boxes.has(id)) boxes.set(id, box)
      v.boxes = boxes
      layout(viewId)
      v.polling = later(() => { v.polling = null; poll(viewId) }, EMBED_POLL_MS)
    }, () => {
      if (views.get(viewId) !== v) return
      v.reading = false
      v.polling = later(() => { v.polling = null; poll(viewId) }, EMBED_POLL_MS)
    })
  }

  /** Read where the embeds are now (something changed), then keep polling. */
  const pollNow = (viewId: number) => {
    const v = views.get(viewId)
    if (!v) return
    v.polling?.()
    v.polling = null
    poll(viewId)
  }

  /** The stream route's answer for a player: the first byte asked (does it play, or must it be picked?). */
  async function probe(p: Player, companyId: string): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> {
    const controller = new AbortController()
    p.streams.add(controller)
    try {
      const answer = await deps.stream(companyId, p.fileId, 'bytes=0-0', controller.signal)
      if (answer.status === 200 || answer.status === 206) {
        await answer.body?.cancel().catch(() => {})
        return { ok: true }
      }
      return { ok: false, status: answer.status, body: await answer.json().catch(() => null) }
    } catch {
      return { ok: false, status: 0, body: null }
    } finally {
      p.streams.delete(controller)
    }
  }

  /** ［ここで再生］ / ［もう一度］: play at once when the member may; else the Picker first, then play. */
  async function start(p: Player) {
    const v = views.get(p.viewId)
    if (!v || p.closed || p.view.kind === 'checking' || p.view.kind === 'picking' || p.view.kind === 'playing') return
    const companyId = v.companyId
    if (companyId === null) { show(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.noCompany, retry: false, browser: true }); return }
    show(p, { kind: 'checking' })
    let first = await probe(p, companyId)
    if (p.closed) return
    if (!first.ok && first.status !== 0 && DRIVE_PLAYER_NEEDS_PICK.has(String((first.body as { code?: unknown } | null)?.code))) {
      const picking = new AbortController()
      p.picking = picking
      show(p, { kind: 'picking' })
      const picked = await deps.pick(companyId, p.fileId, picking.signal).catch((): DriveViewPickResult => ({ ok: false, reason: 'other', message: DRIVE_PLAYER_WORDS.failed }))
      if (p.picking === picking) p.picking = null
      if (p.closed) return
      if (!picked.ok) {
        const message = picked.reason === 'cancelled' ? DRIVE_PLAYER_WORDS.cancelled : picked.reason === 'timed-out' ? DRIVE_PLAYER_WORDS.timedOut : picked.message
        show(p, { kind: 'error', message, retry: true, browser: true })
        return
      }
      if (!picked.kept) {
        show(p, { kind: 'error', message: `${DRIVE_PLAYER_WORDS.notKept}${picked.notKept ?? ''}`, retry: true, browser: true })
        return
      }
      show(p, { kind: 'checking' })
      first = await probe(p, companyId)
      if (p.closed) return
    }
    if (first.ok) {
      const at = p.resumeAt
      p.resumeAt = 0
      show(p, at > 0 ? { kind: 'playing', at } : { kind: 'playing' })
    }
    else if (first.status === 0) show(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.offline, retry: true, browser: true })
    else show(p, drivePlayerRefusal(first.status, first.body))
  }

  /** The player's video stopped getting bytes from the server: what the member reads instead (once). */
  const streamFailed = (p: Player, view: DrivePlayerView) => {
    if (!p.closed && p.view.kind === 'playing') show(p, view)
  }

  /**
   * One server answer for `range` of the player's file, or why not: the server's refusal is shown in the
   * player (its own sentence), a lost connection as offline.
   */
  async function ask(p: Player, companyId: string, range: string | null, controller: AbortController): Promise<Response | null> {
    let answer: Response
    try {
      answer = await deps.stream(companyId, p.fileId, range, controller.signal)
    } catch {
      // Never the file: only that the server could not be reached.
      if (!controller.signal.aborted) {
        log.warn('[doc-player] the server could not be reached for a video')
        streamFailed(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.offline, retry: true, browser: true })
      }
      return null
    }
    if ((answer.status === 200 || answer.status === 206 || answer.status === 416) && answer.body) return answer
    streamFailed(p, drivePlayerRefusal(answer.status, await answer.json().catch(() => null)))
    return null
  }

  /**
   * The bytes of a playing player's video for the range its `<video>` asked. The server answers at most
   * one chunk per request (a shorter 206, and every range is authorized again there); Chromium's player on
   * this scheme does not take a shorter 206 than it asked (measured, Electron 45: 「unplayable」 after the
   * first 512 KB), so main answers the whole range it asked as one 206 and fills it with the server's
   * answers in order — each asked only when the one before has been read, the next starting exactly
   * where it ended. A refusal or a wrong range in between ends the answer with an error.
   */
  async function relay(p: Player, range: string | null): Promise<Response> {
    const v = views.get(p.viewId)
    const companyId = v?.companyId ?? null
    if (companyId === null || p.view.kind !== 'playing') return notFound()
    const asked = range === null ? { start: 0, end: null } : parseByteRange(range)
    const controller = new AbortController()
    p.streams.add(controller)
    const release = () => { p.streams.delete(controller) }
    const first = await ask(p, companyId, range, controller)
    if (!first || p.closed) {
      controller.abort()
      release()
      return notFound()
    }
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' })
    const type = first.headers.get('content-type')
    if (type !== null && /^video\/[a-z0-9.+-]+$/i.test(type)) headers.set('Content-Type', type)
    const got = parseContentRange(first.headers.get('content-range'))
    let status = first.status
    /** The last byte the player asked for, when the server answered less of it (else null: passed on as it is). */
    let wantedEnd: number | null = null
    if (first.status === 206 && asked && got && got.start === asked.start) {
      const end = Math.min(asked.end ?? got.size - 1, got.size - 1)
      if (end > got.end) wantedEnd = end
      headers.set('Content-Range', `bytes ${got.start}-${wantedEnd ?? got.end}/${got.size}`)
      headers.set('Content-Length', String((wantedEnd ?? got.end) - got.start + 1))
    } else if (first.status === 206) {
      // Not the range asked: never passed on as if it were.
      streamFailed(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.failed, retry: true, browser: true })
      controller.abort()
      release()
      return notFound()
    } else {
      for (const name of ['content-length', 'content-range']) {
        const value = first.headers.get(name)
        if (value !== null) headers.set(name, value)
      }
      status = first.status
    }
    let reader = first.body!.getReader()
    /** The server part being read ends here (null: a 200 or 416, passed on as it is). */
    let partEnd: number | null = first.status === 206 && got ? got.end : null
    /** The next byte owed to the player. */
    let at = got ? got.start : 0
    const last = wantedEnd ?? partEnd
    let tries = 0
    /** Ask the server for `bytes=<at>-<last>`: a 206 starting exactly there, ending inside, or the answer ends with an error. */
    const askFrom = async () => {
      const more = await ask(p, companyId, `bytes=${at}-${last}`, controller)
      const part = more && more.status === 206 ? parseContentRange(more.headers.get('content-range')) : null
      if (!more || !part || part.start !== at || last === null || part.end > last) {
        if (more && !part) streamFailed(p, { kind: 'error', message: DRIVE_PLAYER_WORDS.failed, retry: true, browser: true })
        await more?.body?.cancel().catch(() => {})
        throw new Error('the video stopped')
      }
      reader = more.body!.getReader()
      partEnd = part.end
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(out) {
        try {
          for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
              chunk = await reader.read()
            } catch (error) {
              // The server's answer was cut in the middle (its own deadline while the player read slowly, a
              // lost connection): asked again from the byte not yet passed on, a few times in a row at most.
              if (controller.signal.aborted || partEnd === null || last === null || tries >= REASK_MAX) throw error
              tries++
              await askFrom()
              continue
            }
            if (!chunk.done) {
              let value = chunk.value
              // Never more than the part said (a longer answer is cut; bytes are counted per part).
              if (partEnd !== null && value.byteLength > partEnd - at + 1) {
                value = value.subarray(0, Math.max(0, partEnd - at + 1))
                reader.cancel().catch(() => {})
              }
              if (value.byteLength === 0) continue
              at += value.byteLength
              tries = 0
              out.enqueue(value)
              return
            }
            if (partEnd === null || last === null || at > last) { release(); out.close(); return }
            // The part ended (where it said, or short: asked again from there), and more was asked for.
            if (at <= partEnd) {
              if (tries >= REASK_MAX) throw new Error('the video stopped')
              tries++
            }
            await askFrom()
          }
        } catch (error) {
          release()
          controller.abort()
          out.error(error)
        }
      },
      // The player stopped reading (a seek, the page gone): the server's answer is aborted too.
      cancel() {
        release()
        controller.abort()
        reader.cancel().catch(() => {})
      },
    })
    return new Response(body, { status, headers })
  }

  const overlayFor = (viewId: number, fileId: string) => {
    const v = views.get(viewId)
    if (!v || v.companyId === null) return
    if (v.overlay) close(v.overlay)
    const p = make(viewId, fileId, true)
    if (!p) return
    v.overlay = p
    layout(viewId)
  }

  const closeView = (viewId: number) => {
    const v = views.get(viewId)
    if (!v) return
    views.delete(viewId)
    v.polling?.()
    for (const p of [...v.embeds.values()]) close(p)
    if (v.overlay) close(v.overlay)
  }

  return {
    /** A document view was opened for `companyId` (null: nothing of a company's, e.g. the user manual). */
    opened(viewId: number, windowId: number, companyId: string | null) {
      views.set(viewId, { windowId, companyId, ids: [], area: null, readEmbeds: null, boxes: new Map(), embeds: new Map(), overlay: null, links: new Map(), polling: null, reading: false })
    },

    /**
     * The videos the view offers now (`ids`, main's own read of its document), and whether it shows its
     * document (`ownPage`). Another page of the folder closes every player of the view; a changed list
     * rebuilds the embeds' players (a reload of the same file keeps them, playing).
     */
    offered(viewId: number, ids: readonly string[], ownPage: boolean) {
      const v = views.get(viewId)
      if (!v) return
      const next = ownPage ? [...ids] : []
      if (!ownPage) {
        for (const p of [...v.embeds.values()]) close(p)
        if (v.overlay) close(v.overlay)
      }
      if (next.join('\n') !== v.ids.join('\n')) {
        for (const p of [...v.embeds.values()]) close(p)
        v.boxes = new Map()
      }
      v.ids = next
      layout(viewId)
      pollNow(viewId)
    },

    /** The view is on screen at `area` (window DIP), or hidden (null): its players follow, or hide. */
    placed(viewId: number, area: DocViewBounds | null, readEmbeds?: (ids: readonly string[]) => Promise<EmbedBox[]>) {
      const v = views.get(viewId)
      if (!v) return
      v.area = area
      if (readEmbeds) v.readEmbeds = readEmbeds
      if (!area) { v.polling?.(); v.polling = null }
      layout(viewId)
      pollNow(viewId)
    },

    /** The view's page loaded again (a reload, auto refresh): where the embeds are is read afresh. */
    reloaded(viewId: number) {
      const v = views.get(viewId)
      if (!v) return
      // The boxes as last read stay until the new read (a playing video does not blink on an auto refresh).
      pollNow(viewId)
    },

    closeView,

    /** Every player of every view (sign-out, the app quitting). */
    closeAll() {
      for (const viewId of [...views.keys()]) closeView(viewId)
    },

    /** The `index`-th id of the view's offered list plays over its area (the band's ［ACB で再生］). */
    playIndex(viewId: number, index: unknown) {
      const v = views.get(viewId)
      if (!v || typeof index !== 'number' || !Number.isInteger(index)) return
      const id = v.ids[index]
      if (id !== undefined) overlayFor(viewId, id)
    },

    /**
     * A web link the member pressed in the view (main's own copy, from the shell): its number when it is a
     * Drive file link that may play in ACB's player, else null. Only the newest few are kept.
     */
    linkPressed(viewId: number, url: string): number | null {
      const v = views.get(viewId)
      const id = driveAddressVideoId(url)
      if (!v || !id || v.companyId === null) return null
      const n = ++linkSeq
      v.links.set(n, id)
      for (const old of [...v.links.keys()].slice(0, Math.max(0, v.links.size - LINKS_KEPT))) v.links.delete(old)
      return n
    },

    /** The link numbered `linkId` (one main handed this view's window) plays over the area: ［ACB で再生］ on the link question. */
    playLink(viewId: number, linkId: unknown) {
      const v = views.get(viewId)
      const id = typeof linkId === 'number' ? v?.links.get(linkId) : undefined
      if (!v || id === undefined) return
      v.links.delete(linkId as number)
      overlayFor(viewId, id)
    },

    ...server,

    /** For tests and the log: how many players exist and how many streams are open. */
    counts() {
      let streams = 0
      for (const p of byToken.values()) streams += p.streams.size
      return { players: byToken.size, streams }
    },
  }
}

export type DrivePlayers = ReturnType<typeof createDrivePlayers>

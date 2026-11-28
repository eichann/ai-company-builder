import { useCallback, useMemo, useRef, useState } from 'react'
import { Callout, Button } from '../../../shared/ui/primitives'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { usePreviewSearch } from '../hooks/usePreviewSearch'
import { previewFrontmatter } from '../markdownFrontmatter'
import { IN_PLACE_REFUSAL_TEXT, loadInPlaceEngine, type InPlaceRefusal, type InPlaceSurface } from '../inPlaceEditing'
import { FrontmatterNote, MarkdownPreview, PreviewSearchBar } from './MarkdownPreview'

interface Props {
  paneId: string
  filePath: string
  /** The tab's text: what the editor shows, and what it was told last. */
  content: string
  onChange: (text: string) => void
  onShowSource: () => void
  previewRef: React.MutableRefObject<HTMLDivElement | null>
  initialScrollRatio: number | undefined
}

/**
 * A Markdown document read and edited in the same view (files-and-editor.md "Editing a document in
 * place"). A change of the tab's text that did not come from here (the disk version loaded, the AI
 * wrote the file while nothing was edited) opens the document afresh.
 */
export function InPlaceMarkdownEditor(props: Props) {
  // The text the shown editor holds: it was opened with it or wrote it.
  const [held, setHeld] = useState({ text: props.content, opening: 0 })
  if (props.content !== held.text) setHeld({ text: props.content, opening: held.opening + 1 })
  const onChange = useLatestRef(props.onChange)
  const changed = useCallback((text: string) => {
    setHeld(h => ({ ...h, text }))
    onChange.current(text)
  }, [onChange])
  return <Surface key={held.opening} {...props} onChange={changed} />
}

function Surface({ paneId, filePath, content, onChange, onShowSource, previewRef, initialScrollRatio }: Props) {
  const [state, setState] = useState<'opening' | 'open' | InPlaceRefusal>('opening')
  const [takenBack, setTakenBack] = useState(false)
  // Opened once with the text of its first render; a later outside change mounts a new Surface.
  const [opened] = useState(content)
  const latestChange = useLatestRef(onChange)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<InPlaceSurface | null>(null)
  const folder = filePath.substring(0, filePath.lastIndexOf('/'))
  // Read when the editor is made: the host callback must stay the same, or the editor is made again.
  const startAt = useLatestRef({ folder, initialScrollRatio })
  const front = useMemo(() => previewFrontmatter(opened), [opened])

  // The editor is a widget outside React: made when its host appears, destroyed when it goes.
  const host = useCallback((el: HTMLDivElement | null) => {
    if (!el) { surfaceRef.current?.destroy(); surfaceRef.current = null; return }
    let gone = false
    surfaceRef.current = { destroy: () => { gone = true }, focus: () => {} }
    void loadInPlaceEngine()
      .then(engine => engine.open(el, opened, {
        folder: startAt.current.folder,
        onChange: text => latestChange.current(text),
        onChangeTakenBack: () => setTakenBack(true),
      }))
      .then(result => {
        if (gone) { if (result.ok) result.surface.destroy(); return }
        if (!result.ok) { setState(result.reason); return }
        surfaceRef.current = result.surface
        setState('open')
        const scroller = scrollRef.current
        const ratio = startAt.current.initialScrollRatio
        if (scroller && ratio && ratio > 0) {
          requestAnimationFrame(() => { scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * ratio })
        }
      })
      .catch(() => { if (!gone) setState('unavailable') })
  }, [opened, latestChange, startAt])

  // ⌘F reads the editor's text; it lives only while the document is edited here (the reading view
  // shown on a refusal has its own).
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const setHost = useCallback((el: HTMLDivElement | null) => { bodyRef.current = el; host(el) }, [host])

  const setScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    previewRef.current = el
  }, [previewRef])

  if (state !== 'opening' && state !== 'open') {
    return (
      <div className="h-full flex flex-col">
        <div className="px-8 pt-4">
          <Callout tone="info" action={<Button size="sm" onClick={onShowSource}>もとの書き方で直す</Button>}>
            {IN_PLACE_REFUSAL_TEXT[state]}
          </Callout>
        </div>
        <div className="flex-1 min-h-0">
          <MarkdownPreview ref={previewRef} paneId={paneId} content={content} basePath={folder} initialScrollRatio={initialScrollRatio} />
        </div>
      </div>
    )
  }
  return (
    <div ref={setScroll} className="h-full overflow-auto px-8 py-6 relative" data-in-place-editor>
      <InPlaceFind scrollRef={scrollRef} bodyRef={bodyRef} content={content} paneId={paneId} />
      {takenBack && (
        <div className="max-w-3xl mx-auto mb-4">
          <Callout
            tone="warning"
            role="status"
            action={<div className="flex gap-2"><Button size="sm" onClick={onShowSource}>もとの書き方で直す</Button><Button size="sm" variant="ghost" onClick={() => setTakenBack(false)}>閉じる</Button></div>}
          >
            いまの直しは、ファイルにそのまま書き戻せないため元に戻しました。この直しは［もとの書き方で直す］でしてください。
          </Callout>
        </div>
      )}
      <div className="max-w-3xl mx-auto">
        <FrontmatterNote info={front.info} />
        <div ref={setHost} className={state === 'opening' ? 'invisible' : undefined} aria-label="文章（その場で直せます）" />
      </div>
    </div>
  )
}

function InPlaceFind({ scrollRef, bodyRef, content, paneId }: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  bodyRef: React.MutableRefObject<HTMLDivElement | null>
  content: string
  paneId: string
}) {
  const search = usePreviewSearch(scrollRef, bodyRef, content, paneId, 'highlights')
  return <PreviewSearchBar search={search} />
}

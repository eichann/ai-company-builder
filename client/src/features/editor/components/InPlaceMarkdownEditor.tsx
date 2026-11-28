import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { Callout, Button } from '../../../shared/ui/primitives'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useCommandHandler } from '../../../shared/commands/commands'
import { usePreviewSearch } from '../hooks/usePreviewSearch'
import { previewFrontmatter } from '../markdownFrontmatter'
import { IN_PLACE_REFUSAL_TEXT, loadInPlaceEngine, type InPlaceMark, type InPlaceRefusal, type InPlaceSelection, type InPlaceSurface, type TextSize } from '../inPlaceEditing'
import type { CommentBoxProps } from '../selectionSlot'
import type { CommentSeverity } from '../../doc-review/model'
import { FrontmatterNote, MarkdownPreview, PreviewSearchBar } from './MarkdownPreview'
import { SelectionBubble, type BubbleMode } from './SelectionBubble'

/** ［コメント］ on the selected words: the review's comment box (from app/) and where the comment goes (the editor's review). */
export interface InPlaceComment {
  box: (props: CommentBoxProps) => ReactNode
  add: (selectedText: string, body: string, severity: CommentSeverity) => Promise<boolean>
}

interface Props {
  paneId: string
  filePath: string
  /** The tab's text: what the editor shows, and what it was told last. */
  content: string
  onChange: (text: string) => void
  onShowSource: () => void
  previewRef: React.MutableRefObject<HTMLDivElement | null>
  initialScrollRatio: number | undefined
  comment?: InPlaceComment
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

function Surface({ paneId, filePath, content, onChange, onShowSource, previewRef, initialScrollRatio, comment }: Props) {
  const [state, setState] = useState<'opening' | 'open' | InPlaceRefusal>('opening')
  const [takenBack, setTakenBack] = useState(false)
  // Opened once with the text of its first render; a later outside change mounts a new Surface.
  const [opened] = useState(content)
  const latestChange = useLatestRef(onChange)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const surfaceRef = useRef<InPlaceSurface | null>(null)
  // Stops an editor still loading when its host goes.
  const cancelRef = useRef(() => {})
  // The bubble: the words selected and what it shows. A box that takes the focus (the link's address,
  // the comment) keeps the words it was opened for while the document has no selection.
  const [bubble, setBubble] = useState<{ selection: InPlaceSelection; mode: BubbleMode } | null>(null)
  const onSelection = useCallback((selection: InPlaceSelection | null) => {
    setBubble(b => (selection ? { selection, mode: b?.mode === 'size' ? 'size' : 'tools' } : b && (b.mode === 'link' || b.mode === 'comment') ? b : null))
  }, [])
  const folder = filePath.substring(0, filePath.lastIndexOf('/'))
  // Read when the editor is made: the host callback must stay the same, or the editor is made again.
  const startAt = useLatestRef({ folder, initialScrollRatio })
  const front = useMemo(() => previewFrontmatter(opened), [opened])

  // The editor is a widget outside React: made when its host appears, destroyed when it goes.
  const host = useCallback((el: HTMLDivElement | null) => {
    if (!el) { cancelRef.current(); surfaceRef.current?.destroy(); surfaceRef.current = null; return }
    let gone = false
    cancelRef.current = () => { gone = true }
    void loadInPlaceEngine()
      .then(engine => engine.open(el, opened, {
        folder: startAt.current.folder,
        onChange: text => latestChange.current(text),
        onChangeTakenBack: () => setTakenBack(true),
        onSelection,
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
  }, [opened, latestChange, startAt, onSelection])

  // The bubble's keys (command catalog, editor area): only while the focus is in this document, else
  // the key is the app's (⌘B the left column, ⌘K 探す).
  const inDocument = () => !!surfaceRef.current?.hasFocus()
  const withSelection = () => inDocument() && bubble !== null
  const mark = (m: InPlaceMark) => () => surfaceRef.current?.toggleMark(m)
  const size = (z: TextSize) => () => surfaceRef.current?.setSize(z)
  const keys = { target: paneId, acceptsKey: inDocument }
  useCommandHandler('editor.toggleBold', mark('strong'), keys)
  useCommandHandler('editor.toggleItalic', mark('emphasis'), keys)
  useCommandHandler('editor.toggleStrike', mark('strike'), keys)
  useCommandHandler('editor.toggleCode', mark('code'), keys)
  useCommandHandler('editor.editLink', () => setBubble(b => b && (b.selection.link ? (surfaceRef.current?.setLink(null), b) : { ...b, mode: 'link' })), { target: paneId, acceptsKey: withSelection })
  useCommandHandler('editor.setBodyText', size(0), keys)
  useCommandHandler('editor.setHeadingOne', size(1), keys)
  useCommandHandler('editor.setHeadingTwo', size(2), keys)
  useCommandHandler('editor.setHeadingThree', size(3), keys)

  const closeBox = () => { setBubble(null); surfaceRef.current?.focus() }

  // ⌘F reads the file's information box and the editor's text (only highlights: nothing is put into
  // the editor's DOM); it lives only while the document is edited here (a refusal's reading view has its own).
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const setScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    previewRef.current = el
  }, [previewRef])

  if (state !== 'opening' && state !== 'open') {
    return (
      <div className="h-full flex flex-col">
        <div className="px-8 pt-4">
          {/* Buttons under the words: beside them a narrow column left the words one character wide. */}
          <Callout tone="info">
            <p>{IN_PLACE_REFUSAL_TEXT[state]}</p>
            <div className="mt-2"><Button size="sm" onClick={onShowSource}>もとの書き方で直す</Button></div>
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
          <Callout tone="warning" role="status">
            <p>いまの直しは、ファイルにそのまま書き戻せないため元に戻しました。この直しは［もとの書き方で直す］でしてください。</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={onShowSource}>もとの書き方で直す</Button>
              <Button size="sm" variant="ghost" onClick={() => setTakenBack(false)}>閉じる</Button>
            </div>
          </Callout>
        </div>
      )}
      <div ref={bodyRef} className="max-w-3xl mx-auto">
        <FrontmatterNote info={front.info} />
        <div ref={host} className={state === 'opening' ? 'invisible' : undefined} aria-label="文章（その場で直せます）" />
      </div>
      {bubble && state === 'open' && (bubble.mode === 'comment' && comment ? comment.box({
        position: { x: Math.min(bubble.selection.box.left, window.innerWidth - 300), y: bubble.selection.box.bottom },
        selectedText: bubble.selection.text,
        onSubmit: async (body, severity) => {
          const saved = await comment.add(bubble.selection.text, body, severity)
          if (saved) closeBox()
          return saved
        },
        onClose: closeBox,
      }) : (
        <SelectionBubble
          selection={bubble.selection}
          mode={bubble.mode}
          onMode={m => { setBubble(b => b && { ...b, mode: m }); if (m === 'tools') surfaceRef.current?.focus() }}
          onMark={m => surfaceRef.current?.toggleMark(m)}
          onSize={z => surfaceRef.current?.setSize(z)}
          onLink={href => surfaceRef.current?.setLink(href)}
          canComment={!!comment}
        />
      ))}
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

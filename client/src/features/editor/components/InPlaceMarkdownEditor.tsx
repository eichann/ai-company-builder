// Over ~300 lines: the document's surface and the parts drawn over and under it (bubble, 「/」 list, table bar,
// the AI's fix) share the one editor handle and selection; split, each would re-wire the same handle.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Callout, Button } from '../../../shared/ui/primitives'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { useCommandHandler } from '../../../shared/commands/commands'
import { isMacControlKey, type KeyInput } from '../../../../shared/commands/define'
import { usePreviewSearch } from '../hooks/usePreviewSearch'
import { previewFrontmatter } from '../markdownFrontmatter'
import { IN_PLACE_REFUSAL_TEXT, loadInPlaceEngine, type InPlaceBlockMenu, type InPlaceMark, type InPlaceRefusal, type InPlaceSelection, type InPlaceSurface, type InPlaceTable, type TextSize } from '../inPlaceEditing'
import type { AiFixPart, CommentBoxProps } from '../selectionSlot'
import type { CommentSeverity } from '../../doc-review/model'
import { FrontmatterNote, MarkdownPreview, PreviewSearchBar } from './MarkdownPreview'
import { SelectionBubble, type BubbleMode } from './SelectionBubble'
import { BlockMenu, TableBar } from './BlockTools'
import { AiFixCard } from './AiFixCard'
import { useAiFix } from '../hooks/useAiFix'
import { saveDocumentImage } from '../api'
import { documentImageFileRefusal } from '../../../../shared/document-images'

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/** ［コメント］ on the selected words: the review's comment box (from app/) and where the comment goes (the editor's review). */
export interface InPlaceComment {
  box: (props: CommentBoxProps) => ReactNode
  add: (selectedText: string, body: string, severity: CommentSeverity) => Promise<boolean>
}

/** ［AI に反映してもらう］ on a review comment: asked as soon as the document is open here (its quote's place in the text). */
export interface CommentFixStart {
  quote: string
  body: string
  /** The quote in the tab's text (`findTextInMarkdown`), or null when it is not found. */
  at: { start: number; end: number } | null
  /** Taken: the screen forgets it (a document opened afresh does not ask again). */
  onStarted: () => void
  /** ［レビューに戻る］ after the fix is adopted. */
  onBackToReview: () => void
}

interface Props {
  paneId: string
  filePath: string
  /** The tab's text: what the editor shows, and what it was told last. */
  content: string
  onChange: (text: string) => void
  /** Changes and deletes of the file from outside seen so far (it grows): with edits kept, the text shown stays the same. */
  outsideChanges: number
  onShowSource: () => void
  previewRef: React.MutableRefObject<HTMLDivElement | null>
  initialScrollRatio: number | undefined
  comment?: InPlaceComment
  /** The consultation's AI (the screen's part): ［AI に直してもらう］ in the bubble, a comment's reflection. */
  aiFix?: AiFixPart
  startFix?: CommentFixStart
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
  // A request to the AI still open when the document is opened afresh (its file changed from outside) is lost: said here.
  const [fixLost, setFixLost] = useState(false)
  return (
    <>
      {fixLost && (
        <div className="px-8 pt-4">
          <Callout tone="warning" role="status">
            <p>AI に頼んでいる間に文書がほかから変わったため、AI の直し案は使えません。もう一度頼んでください。</p>
            <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setFixLost(false)}>閉じる</Button></div>
          </Callout>
        </div>
      )}
      <Surface key={held.opening} {...props} onChange={changed} onFixLost={() => setFixLost(true)} />
    </>
  )
}

function Surface({ paneId, filePath, content, onChange, outsideChanges, onShowSource, previewRef, initialScrollRatio, comment, aiFix, startFix, onFixLost }: Props & { onFixLost: () => void }) {
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
    setBubble(b => (selection ? { selection, mode: b?.mode === 'size' ? 'size' : 'tools' } : b && (b.mode === 'link' || b.mode === 'comment' || b.mode === 'aiFix') ? b : null))
  }, [])
  // The 「/」 list (its highlighted choice starts at the first again when what was typed changes) and the table bar.
  const [menu, setMenu] = useState<{ menu: InPlaceBlockMenu; index: number } | null>(null)
  // What the editor reported last, at once: a key pressed before the list is drawn again meets the editor's own state.
  const shownMenu = useRef<InPlaceBlockMenu | null>(null)
  const onBlockMenu = useCallback((next: InPlaceBlockMenu | null) => {
    shownMenu.current = next
    setMenu(m => (next ? { menu: next, index: m && m.menu.query === next.query ? m.index : 0 } : null))
  }, [])
  const [table, setTable] = useState<InPlaceTable | null>(null)
  const folder = filePath.substring(0, filePath.lastIndexOf('/'))
  // Read when the editor is made: the host callback must stay the same, or the editor is made again.
  const startAt = useLatestRef({ folder, initialScrollRatio })
  // A pasted or dropped image: kept beside the document by main (files-and-editor.md "Images in a
  // document"); what was not kept is said in one line above the document, nothing is put in.
  const [imageProblem, setImageProblem] = useState<string | null>(null)
  const documentPath = useLatestRef(filePath)
  const storeImage = useCallback(async (file: File): Promise<string | null> => {
    const name = file.name || '画像'
    const refused = documentImageFileRefusal(file)
    if (refused) { setImageProblem(`${name}: ${refused}`); return null }
    const result = await saveDocumentImage(documentPath.current, await file.arrayBuffer())
      .catch(() => ({ success: false as const, error: '保存できませんでした' }))
    if (result.success) { setImageProblem(null); return result.address }
    setImageProblem(`${name}: ${result.error}`)
    return null
  }, [documentPath])
  const front = useMemo(() => previewFrontmatter(opened), [opened])
  const fixes = useAiFix(aiFix, filePath.substring(filePath.lastIndexOf('/') + 1), surfaceRef, outsideChanges)
  const lostRef = useLatestRef(() => { if (fixes.open()) onFixLost() })
  // A comment's reflection, taken once when the document first opens here.
  const [commentFix] = useState(startFix)
  const askAboutComment = useLatestRef(() => {
    if (!commentFix) return
    commentFix.onStarted()
    const surface = surfaceRef.current
    const passage = commentFix.at && surface ? surface.passageAt(commentFix.at.start, commentFix.at.end) : null
    fixes.ask(passage, '', { quote: commentFix.quote, body: commentFix.body })
  })

  // The editor is a widget outside React: made when its host appears, destroyed when it goes.
  const host = useCallback((el: HTMLDivElement | null) => {
    if (!el) { lostRef.current(); cancelRef.current(); surfaceRef.current?.destroy(); surfaceRef.current = null; return }
    let gone = false
    cancelRef.current = () => { gone = true }
    void loadInPlaceEngine()
      .then(engine => engine.open(el, opened, {
        folder: startAt.current.folder,
        onChange: text => latestChange.current(text),
        onChangeTakenBack: () => setTakenBack(true),
        onSelection,
        onBlockMenu,
        onTable: setTable,
        storeImage,
      }))
      .then(result => {
        if (gone) { if (result.ok) result.surface.destroy(); return }
        if (!result.ok) { setState(result.reason); return }
        surfaceRef.current = result.surface
        setState('open')
        askAboutComment.current()
        const scroller = scrollRef.current
        const ratio = startAt.current.initialScrollRatio
        if (scroller && ratio && ratio > 0) {
          requestAnimationFrame(() => { scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * ratio })
        }
      })
      .catch(() => { if (!gone) setState('unavailable') })
  }, [opened, latestChange, startAt, onSelection, onBlockMenu, storeImage, lostRef, askAboutComment])

  // The bubble's keys (command catalog, editor area): only while the focus is in this document, else
  // the key is the app's (⌘B the left column, ⌘K 探す).
  // On a Mac, Ctrl+letter is the text's own movement (Ctrl+B back, Ctrl+E line end): only ⌘ is the shortcut.
  const inDocument = (input: KeyInput) => !!surfaceRef.current?.hasFocus() && !isMacControlKey(input, IS_MAC)
  const withSelection = (input: KeyInput) => inDocument(input) && bubble !== null
  const mark = (m: InPlaceMark) => () => surfaceRef.current?.toggleMark(m)
  const size = (z: TextSize) => () => surfaceRef.current?.setSize(z)
  const keys = { target: paneId, acceptsKey: inDocument }
  useCommandHandler('editor.toggleBold', mark('strong'), keys)
  useCommandHandler('editor.toggleItalic', mark('emphasis'), keys)
  useCommandHandler('editor.toggleStrike', mark('strike'), keys)
  useCommandHandler('editor.toggleCode', mark('code'), keys)
  useCommandHandler('editor.editLink', () => {
    if (!bubble) return
    if (bubble.selection.link) surfaceRef.current?.setLink(null)
    else setBubble({ ...bubble, mode: 'link' })
  }, { target: paneId, acceptsKey: withSelection })
  useCommandHandler('editor.setBodyText', size(0), keys)
  useCommandHandler('editor.setHeadingOne', size(1), keys)
  useCommandHandler('editor.setHeadingTwo', size(2), keys)
  useCommandHandler('editor.setHeadingThree', size(3), keys)
  // The 「/」 list's keys: only while it shows in this document, never while a word is being composed.
  const menuKeys = { target: paneId, acceptsKey: (input: KeyInput) => inDocument(input) && shownMenu.current !== null && !input.isComposing }
  const step = (by: number) => () => setMenu(m => m && { ...m, index: (m.index + by + m.menu.choices.length) % m.menu.choices.length })
  useCommandHandler('editor.blockMenuNext', step(1), menuKeys)
  useCommandHandler('editor.blockMenuPrevious', step(-1), menuKeys)
  useCommandHandler('editor.blockMenuChoose', () => {
    const now = shownMenu.current
    if (!now) return
    const index = menu && menu.menu.query === now.query ? menu.index : 0
    surfaceRef.current?.turnInto(now.choices[Math.min(index, now.choices.length - 1)])
  }, menuKeys)
  useCommandHandler('editor.blockMenuClose', () => surfaceRef.current?.closeBlockMenu(), menuKeys)

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
      {imageProblem && (
        <div className="max-w-3xl mx-auto mb-4">
          <Callout tone="warning" role="status">
            <p>画像を入れられませんでした。{imageProblem}</p>
            <div className="mt-2"><Button size="sm" variant="ghost" onClick={() => setImageProblem(null)}>閉じる</Button></div>
          </Callout>
        </div>
      )}
      {fixes.notice && (
        <div className="max-w-3xl mx-auto mb-4">
          <Callout tone="info" role="status">
            <p>{fixes.notice.text}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {fixes.notice.fromComment && commentFix && <Button size="sm" onClick={commentFix.onBackToReview}>レビューに戻る</Button>}
              <Button size="sm" variant="ghost" onClick={fixes.closeNotice}>閉じる</Button>
            </div>
          </Callout>
        </div>
      )}
      <div ref={bodyRef} className="max-w-3xl mx-auto">
        <FrontmatterNote info={front.info} />
        <div ref={host} className={state === 'opening' ? 'invisible' : undefined} aria-label="文章（その場で直せます）" />
      </div>
      {menu && state === 'open' && (
        <BlockMenu
          menu={menu.menu}
          index={menu.index}
          onHover={index => setMenu(m => m && { ...m, index })}
          onChoose={block => surfaceRef.current?.turnInto(block)}
        />
      )}
      {table && !bubble && !menu && state === 'open' && <TableBar table={table} onEdit={edit => surfaceRef.current?.editTable(edit)} />}
      {bubble && state === 'open' && (bubble.mode === 'comment' && comment ? comment.box({
        position: { x: Math.min(bubble.selection.box.left, window.innerWidth - 300), y: bubble.selection.box.bottom },
        selectedText: bubble.selection.text.trim(),
        onSubmit: async (body, severity) => {
          const saved = await comment.add(bubble.selection.text.trim(), body, severity)
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
          onAskAi={aiFix ? ask => { const passage = surfaceRef.current?.selectedPassage() ?? null; setBubble(null); fixes.ask(passage, ask) } : undefined}
        />
      ))}
      {fixes.fix && aiFix && createPortal(
        <AiFixCard ask={fixes.fix.ask} phase={fixes.fix.phase} preview={aiFix.preview} onAdopt={fixes.adopt} onCancel={fixes.putAway} />,
        fixes.fix.host,
      )}
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

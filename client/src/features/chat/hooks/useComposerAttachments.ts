import { useCallback, useRef, useState } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'
import { draggedRecord, draggedRecordWord, dropEffectAllowed, type DraggedRecord } from '../../../shared/lib/dragTypes'
import { composerDragOf, type ComposerDrag } from '../recordDrop'

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 4
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB

interface Attachments {
  images: File[]
  filePaths: string[]
}

/**
 * Images and file references dropped on the composer, sent with the next
 * message; a dropped record goes to `onDropRecord` (the conversation's topic and summary). Every change tells `onAttachmentsChange` the count right away
 * (the conversation reads it when the member leaves, to keep a tab with
 * attachments).
 */
export function useComposerAttachments(
  onSend: (text: string, files?: File[], filePaths?: string[]) => void,
  onAttachmentsChange?: (count: number) => void,
  onDropRecord?: (record: DraggedRecord & { word: string }) => void,
) {
  const [attached, setAttached] = useState<Attachments>({ images: [], filePaths: [] })
  // What is dragged over the input (the drop frame says what dropping it does: recordDrop.ts).
  const [drag, setDrag] = useState<ComposerDrag>(null)
  const onDropRecordRef = useLatestRef(onDropRecord)
  const [imageWarning, setImageWarning] = useState('')
  const dragCounterRef = useRef(0)
  const currentRef = useRef(attached)
  const onAttachmentsChangeRef = useLatestRef(onAttachmentsChange)

  const update = useCallback((next: Attachments) => {
    const before = currentRef.current
    currentRef.current = next
    setAttached(next)
    const count = next.images.length + next.filePaths.length
    if (count !== before.images.length + before.filePaths.length) onAttachmentsChangeRef.current?.(count)
  }, [onAttachmentsChangeRef])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    const over = composerDragOf(e.dataTransfer)
    // A record is taken only where the conversation handles it (not the composer preview without it).
    if (over && (over.kind === 'file' || onDropRecordRef.current)) setDrag(over)
  }, [onDropRecordRef])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setDrag(null)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // An effect the source allows, or the browser fires no drop (a tab or a record allows only link).
    const allowed = e.dataTransfer.effectAllowed
    const effect = (['copy', 'link', 'move'] as const).find(d => dropEffectAllowed(allowed, d))
    if (effect) e.dataTransfer.dropEffect = effect
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDrag(null)
    dragCounterRef.current = 0
    const current = currentRef.current

    // A record (やること, 案件…): the consultation becomes one about it (ChatConversation decides).
    const record = draggedRecord(e.dataTransfer)
    if (record) {
      onDropRecordRef.current?.({ ...record, word: draggedRecordWord(e.dataTransfer) ?? '記録' })
      return
    }

    // File paths from the file tree
    const rawPaths = e.dataTransfer.getData('application/x-file-paths')
    if (rawPaths) {
      try {
        const paths: string[] = JSON.parse(rawPaths)
        const existing = new Set(current.filePaths)
        const newPaths = paths.filter(p => !existing.has(p))
        if (newPaths.length > 0) update({ ...current, filePaths: [...current.filePaths, ...newPaths] })
        return
      } catch { /* fall through to image handling */ }
    }

    // Image files (max 4, max 2MB each)
    const validFiles = Array.from(e.dataTransfer.files).filter(f => IMAGE_MIME_TYPES.includes(f.type))
    const oversized = validFiles.filter(f => f.size > MAX_IMAGE_SIZE)
    const files = validFiles.filter(f => f.size <= MAX_IMAGE_SIZE)
    const warnings: string[] = []
    if (oversized.length > 0) warnings.push(`${oversized.length}件の画像が2MBを超えています`)
    if (files.length > 0) {
      const combined = [...current.images, ...files]
      if (combined.length > MAX_IMAGES) warnings.push(`画像は最大${MAX_IMAGES}枚までです`)
      update({ ...current, images: combined.slice(0, MAX_IMAGES) })
    }
    if (warnings.length > 0) {
      setImageWarning(warnings.join('、'))
      setTimeout(() => setImageWarning(''), 4000)
    }
  }, [update, onDropRecordRef])

  const removeImage = useCallback((index: number) => {
    const current = currentRef.current
    update({ ...current, images: current.images.filter((_, i) => i !== index) })
  }, [update])

  const removeFilePath = useCallback((index: number) => {
    const current = currentRef.current
    update({ ...current, filePaths: current.filePaths.filter((_, i) => i !== index) })
  }, [update])

  const sendWithAttachments = useCallback((text: string) => {
    const { images, filePaths } = currentRef.current
    onSend(text, images.length > 0 ? [...images] : undefined, filePaths.length > 0 ? [...filePaths] : undefined)
    update({ images: [], filePaths: [] })
  }, [onSend, update])

  return {
    images: attached.images,
    filePaths: attached.filePaths,
    drag,
    imageWarning,
    dropHandlers: { onDragEnter: handleDragEnter, onDragLeave: handleDragLeave, onDragOver: handleDragOver, onDrop: handleDrop },
    removeImage,
    removeFilePath,
    sendWithAttachments,
  }
}

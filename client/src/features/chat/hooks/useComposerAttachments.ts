import { useCallback, useRef, useState } from 'react'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGES = 4
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB

interface Attachments {
  images: File[]
  filePaths: string[]
}

/**
 * Images and file references dropped on the composer, sent with the next
 * message. Every change tells `onAttachmentsChange` the count right away
 * (the conversation reads it when the member leaves, to keep a tab with
 * attachments).
 */
export function useComposerAttachments(
  onSend: (text: string, files?: File[], filePaths?: string[]) => void,
  onAttachmentsChange?: (count: number) => void,
) {
  const [attached, setAttached] = useState<Attachments>({ images: [], filePaths: [] })
  const [isDragOver, setIsDragOver] = useState(false)
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
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-file-paths')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    dragCounterRef.current = 0
    const current = currentRef.current

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
  }, [update])

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
    isDragOver,
    imageWarning,
    dropHandlers: { onDragEnter: handleDragEnter, onDragLeave: handleDragLeave, onDragOver: handleDragOver, onDrop: handleDrop },
    removeImage,
    removeFilePath,
    sendWithAttachments,
  }
}

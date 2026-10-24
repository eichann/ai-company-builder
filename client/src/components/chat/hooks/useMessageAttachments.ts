import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import { historyThumbnail } from '../historyThumbnail'

/**
 * Images and file-tree references attached to a message. Two halves:
 * - what the next request sends (`pendingImagesRef`, `pendingFilePathsRef`:
 *   the request body consumes them, chatRequestBody.ts), and
 * - what each user bubble shows (`messageImages`, `messageReferenceFiles`, by
 *   message id; saved with the history). The pending display copies wait in
 *   refs until the user message they belong to appears
 *   (useAttachToLatestUserMessage).
 *
 * Called before useChat (the transport reads the refs).
 */
export function useMessageAttachments() {
  // Pending images to send with next message
  const pendingImagesRef = useRef<Array<{ mediaType: string; data: string }>>([])
  // Pending data URLs to associate with the next user message
  const pendingImageDataUrlsRef = useRef<string[]>([])
  // Store sent images keyed by message ID for display in chat
  const [messageImages, setMessageImages] = useState<Map<string, string[]>>(new Map())
  // Store reference file paths keyed by message ID for display in chat
  const [messageReferenceFiles, setMessageReferenceFiles] = useState<Map<string, string[]>>(new Map())
  // Pending file paths to send as reference context
  const pendingFilePathsRef = useRef<string[]>([])
  // Pending file paths for display (kept separately so transport body clearing doesn't lose them)
  const pendingDisplayFilePathsRef = useRef<string[]>([])

  /** Convert images to base64 for the request; the bubble and the history keep a small copy. */
  const stageImages = useCallback(async (files: File[]) => {
    const imageParts: Array<{ mediaType: string; data: string }> = []
    const dataUrls: string[] = []
    for (const file of files) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(file)
      })
      // The AI gets the full image; the bubble and the history keep a small copy.
      dataUrls.push(await historyThumbnail(dataUrl))
      imageParts.push({ mediaType: file.type, data: dataUrl.split(',')[1] })
    }
    pendingImagesRef.current = imageParts
    pendingImageDataUrlsRef.current = dataUrls
  }, [])

  /** File paths for the request (sent as referenceFiles in the system prompt) and the bubble. */
  const stageFilePaths = useCallback((filePaths: string[]) => {
    pendingFilePathsRef.current = [...filePaths]
    pendingDisplayFilePathsRef.current = [...filePaths]
  }, [])

  return {
    pendingImagesRef, pendingImageDataUrlsRef, pendingFilePathsRef, pendingDisplayFilePathsRef,
    messageImages, setMessageImages, messageReferenceFiles, setMessageReferenceFiles,
    stageImages, stageFilePaths,
  }
}

export type MessageAttachments = ReturnType<typeof useMessageAttachments>

/** The pending display copies go to the newest user message once it appears. */
export function useAttachToLatestUserMessage(messages: UIMessage[], a: MessageAttachments): void {
  const { pendingImageDataUrlsRef, pendingDisplayFilePathsRef, messageImages, setMessageImages, messageReferenceFiles, setMessageReferenceFiles } = a

  // Associate pending images with new user messages
  useEffect(() => {
    if (pendingImageDataUrlsRef.current.length === 0) return
    const userMsgs = messages.filter(m => m.role === 'user')
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    if (lastUserMsg && !messageImages.has(lastUserMsg.id)) {
      const urls = pendingImageDataUrlsRef.current
      pendingImageDataUrlsRef.current = []
      setMessageImages(prev => new Map(prev).set(lastUserMsg.id, urls))
    }
  }, [messages, messageImages, pendingImageDataUrlsRef, setMessageImages])

  // Associate pending reference files with new user messages
  useEffect(() => {
    if (pendingDisplayFilePathsRef.current.length === 0) return
    const userMsgs = messages.filter(m => m.role === 'user')
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    if (lastUserMsg && !messageReferenceFiles.has(lastUserMsg.id)) {
      const paths = pendingDisplayFilePathsRef.current
      pendingDisplayFilePathsRef.current = []
      setMessageReferenceFiles(prev => new Map(prev).set(lastUserMsg.id, paths))
    }
  }, [messages, messageReferenceFiles, pendingDisplayFilePathsRef, setMessageReferenceFiles])
}

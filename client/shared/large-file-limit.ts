/**
 * The one size limit for sharing a file: sync keeps a file strictly larger
 * than this on this computer (`electron/sync/large-files.ts`, sync.md step 4),
 * and the file tree refuses a Finder drop of a video over it, so nothing the
 * app takes in is then silently left unshared (files-and-editor.md).
 */
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024 // 100MB

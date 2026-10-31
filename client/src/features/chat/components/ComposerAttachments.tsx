import { useEffect, useState } from 'react'

// Stable blob URL management for image previews
function ImagePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string>('')

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  if (!url) return null

  return (
    <div className="relative group">
      <img
        src={url}
        alt={file.name}
        className="w-16 h-16 object-cover rounded-lg border border-border overflow-hidden"
      />
      <button
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs"
      >
        ×
      </button>
    </div>
  )
}

interface ComposerAttachmentsProps {
  imageWarning: string
  filePaths: string[]
  images: File[]
  onRemoveFilePath: (index: number) => void
  onRemoveImage: (index: number) => void
}

/** What waits to go out with the next message: a warning, file chips and image previews. */
export function ComposerAttachments({ imageWarning, filePaths, images, onRemoveFilePath, onRemoveImage }: ComposerAttachmentsProps) {
  return (
    <>
      {/* Image warning */}
      {imageWarning && (
        <div className="px-3 pt-2 text-xs text-amber-500">{imageWarning}</div>
      )}

      {/* File path chips */}
      {filePaths.length > 0 && (
        <div className="flex gap-1.5 px-3 pt-2 pb-1 flex-wrap">
          {filePaths.map((filePath, i) => {
            const fileName = filePath.split('/').pop() || filePath
            return (
              <div
                key={filePath}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-accent/10 text-accent text-xs group"
                title={filePath}
              >
                <span className="max-w-[200px] truncate">{fileName}</span>
                <button
                  onClick={() => onRemoveFilePath(i)}
                  className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-accent/20 opacity-60 group-hover:opacity-100 transition-opacity text-[10px]"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-2 pb-1 flex-wrap">
          {images.map((file, i) => (
            <ImagePreview key={`${file.name}-${file.size}-${i}`} file={file} onRemove={() => onRemoveImage(i)} />
          ))}
        </div>
      )}
    </>
  )
}

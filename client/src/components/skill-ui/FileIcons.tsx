// File type icons with colors
// Using inline SVG for precise control and no external dependencies

interface FileIconProps {
  size?: number
  className?: string
}

// Python icon
export function PythonIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#3572A5"
        d="M11.914 0C5.82 0 6.2 2.656 6.2 2.656l.007 2.752h5.814v.826H3.9S0 5.789 0 11.969c0 6.18 3.403 5.96 3.403 5.96h2.03v-2.867s-.109-3.42 3.35-3.42h5.766s3.24.052 3.24-3.148V3.202S18.28 0 11.914 0zM8.708 1.85c.578 0 1.046.47 1.046 1.052 0 .581-.468 1.051-1.046 1.051-.578 0-1.046-.47-1.046-1.051 0-.582.468-1.052 1.046-1.052z"
      />
      <path
        fill="#FDD835"
        d="M12.087 24c6.093 0 5.713-2.656 5.713-2.656l-.007-2.752h-5.814v-.826h8.121s3.9.445 3.9-5.735c0-6.18-3.403-5.96-3.403-5.96h-2.03v2.867s.109 3.42-3.35 3.42H9.45s-3.24-.052-3.24 3.148v5.292S5.72 24 12.087 24zm3.206-1.85c-.578 0-1.046-.47-1.046-1.052 0-.581.468-1.051 1.046-1.051.578 0 1.046.47 1.046 1.051 0 .582-.468 1.052-1.046 1.052z"
      />
    </svg>
  )
}

// JavaScript icon
export function JavaScriptIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="2" fill="#F7DF1E" />
      <path
        fill="#000"
        d="M6.5 18.5l1.8-1.1c.35.62.67 1.15 1.43 1.15.73 0 1.2-.29 1.2-1.4v-7.6h2.2v7.65c0 2.3-1.35 3.35-3.32 3.35-1.78 0-2.81-.92-3.31-2.05zm7.9-.25l1.8-1.05c.48.78 1.1 1.35 2.2 1.35.92 0 1.52-.46 1.52-1.1 0-.76-.61-1.03-1.63-1.47l-.56-.24c-1.62-.69-2.7-1.55-2.7-3.37 0-1.68 1.28-2.96 3.28-2.96 1.42 0 2.45.5 3.18 1.8l-1.74 1.12c-.38-.69-.8-.96-1.44-.96-.66 0-1.08.42-1.08.96 0 .67.42.94 1.38 1.36l.56.24c1.9.82 2.98 1.65 2.98 3.52 0 2.02-1.58 3.12-3.7 3.12-2.08 0-3.43-1-4.1-2.32z"
      />
    </svg>
  )
}

// TypeScript icon
export function TypeScriptIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="2" fill="#3178C6" />
      <path
        fill="#fff"
        d="M5.5 12.5v-1h7v1h-2.8v7h-1.4v-7H5.5zm8.1-1h1.3v3.15c0 .61.05 1.02.15 1.22.17.36.53.54 1.06.54.5 0 .87-.18 1.1-.55.12-.19.18-.6.18-1.21V11.5h1.3v3.26c0 .98-.14 1.68-.42 2.1-.45.66-1.18 1-2.2 1-.98 0-1.7-.33-2.15-.98-.28-.4-.43-1.1-.43-2.12V11.5z"
      />
    </svg>
  )
}

// JSON icon
export function JsonIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#F5A623"
        d="M5.036 18.673c-2.04-1.07-2.036-5.225-2.036-6.673s-.004-5.603 2.036-6.673c.762-.4 1.996.094 2.465.32l-1.51 1.937c-.192-.016-.593-.022-.734.047-1.008.491-1.024 3.377-1.024 4.369s.016 3.878 1.024 4.369c.141.07.542.063.734.047l1.51 1.937c-.469.226-1.703.72-2.465.32z"
      />
      <path
        fill="#F5A623"
        d="M18.964 18.673c2.04-1.07 2.036-5.225 2.036-6.673s.004-5.603-2.036-6.673c-.762-.4-1.996.094-2.465.32l1.51 1.937c.192-.016.593-.022.734.047 1.008.491 1.024 3.377 1.024 4.369s-.016 3.878-1.024 4.369c-.141.07-.542.063-.734.047l-1.51 1.937c.469.226 1.703.72 2.465.32z"
      />
      <circle cx="8.5" cy="12" r="1.5" fill="#F5A623" />
      <circle cx="12" cy="12" r="1.5" fill="#F5A623" />
      <circle cx="15.5" cy="12" r="1.5" fill="#F5A623" />
    </svg>
  )
}

// Markdown icon
export function MarkdownIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect x="1" y="4" width="22" height="16" rx="2" fill="#083FA1" />
      <path
        fill="#fff"
        d="M4 16V8h2l2 3 2-3h2v8h-2v-4.5l-2 3-2-3V16H4zm11 0v-4l2 2.5L19 12v4h2V8h-2l-2 2.5L15 8h-2v8h2z"
      />
    </svg>
  )
}

// HTML icon
export function HtmlIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="#E44D26" d="M3 2l1.6 18L12 22l7.4-2L21 2H3z" />
      <path fill="#F16529" d="M12 4v16l5.5-1.5L19 4H12z" />
      <path
        fill="#fff"
        d="M12 8H7.3l.2 2H12v2H7.7l.2 2.4 4.1 1.1v2.2l-5.6-1.5-.4-4.2H8l.1 2 3.9 1V8z"
      />
      <path
        fill="#EBEBEB"
        d="M12 8v2h4.5l-.2 2H12v2h4.1l-.4 4.4L12 19.5v-2.2l2.1-.6.1-1.7H12V8z"
      />
    </svg>
  )
}

// CSS icon
export function CssIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="#1572B6" d="M3 2l1.6 18L12 22l7.4-2L21 2H3z" />
      <path fill="#33A9DC" d="M12 4v16l5.5-1.5L19 4H12z" />
      <path
        fill="#fff"
        d="M7.3 10H12v2H7.5l.2 2H12v2l-4.1 1.1-.4-4.2H9.3l.1 1 2.6.7V10z"
      />
      <path
        fill="#EBEBEB"
        d="M12 10v2h4.3l-.4 4.4L12 17.5v2.2l5.6-1.5.4-4.2.4-4H12z"
      />
    </svg>
  )
}

// YAML icon
export function YamlIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="2" fill="#CB171E" />
      <path
        fill="#fff"
        d="M4 7h2l2 4 2-4h2l-3.5 6V17H7.5v-4L4 7zm10 0h2v4h3v2h-3v4h-2V7z"
      />
    </svg>
  )
}

// Shell/Bash icon
export function ShellIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <rect width="24" height="24" rx="2" fill="#4EAA25" />
      <path
        fill="#fff"
        d="M5 7l5 5-5 5v-2l3-3-3-3V7zm7 8h7v2h-7v-2z"
      />
    </svg>
  )
}

// SQL icon
export function SqlIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <ellipse cx="12" cy="6" rx="8" ry="3" fill="#00758F" />
      <path fill="#00758F" d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6c0 1.66-3.58 3-8 3S4 7.66 4 6z" />
      <ellipse cx="12" cy="6" rx="8" ry="3" fill="#00758F" />
      <path fill="#F29111" opacity="0.3" d="M4 10c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      <path fill="#F29111" opacity="0.3" d="M4 14c0 1.66 3.58 3 8 3s8-1.34 8-3" />
    </svg>
  )
}

// React/JSX icon
export function ReactIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <circle cx="12" cy="12" r="2" fill="#61DAFB" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#61DAFB" strokeWidth="1" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#61DAFB" strokeWidth="1" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="#61DAFB" strokeWidth="1" transform="rotate(120 12 12)" />
    </svg>
  )
}

// Generic file icon
export function GenericFileIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#6b7280"
        d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"
      />
    </svg>
  )
}

// Folder icon (for completeness)
export function FolderIcon({ size = 16, className = '', isOpen = false }: FileIconProps & { isOpen?: boolean }) {
  if (isOpen) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
        <path
          fill="#FDD835"
          d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V6h5.2l2 2H20v10z"
        />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#FDD835"
        d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"
      />
    </svg>
  )
}

// Special folder icons
export function GitFolderIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#F05032"
        d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"
      />
    </svg>
  )
}

// Config file icon
export function ConfigIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#6b7280"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
      />
    </svg>
  )
}

// Image file icon
export function ImageIcon({ size = 16, className = '' }: FileIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path
        fill="#26A69A"
        d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"
      />
    </svg>
  )
}

// Get appropriate icon component for a file
export function getFileIcon(fileName: string, isDirectory: boolean = false) {
  if (isDirectory) {
    // Special folder names
    const lowerName = fileName.toLowerCase()
    if (lowerName === '.git' || lowerName === '.github') {
      return GitFolderIcon
    }
    return FolderIcon
  }

  const ext = fileName.split('.').pop()?.toLowerCase()
  const baseName = fileName.toLowerCase()

  // Special file names
  if (baseName === '.gitignore' || baseName === '.gitattributes') {
    return ConfigIcon
  }
  if (baseName.includes('config') || baseName.includes('rc') || baseName === '.env') {
    return ConfigIcon
  }

  // Extension-based icons
  switch (ext) {
    case 'py':
    case 'pyw':
    case 'pyi':
    case 'pyx':
      return PythonIcon
    case 'js':
    case 'mjs':
    case 'cjs':
      return JavaScriptIcon
    case 'jsx':
      return ReactIcon
    case 'ts':
    case 'mts':
    case 'cts':
      return TypeScriptIcon
    case 'tsx':
      return ReactIcon
    case 'json':
    case 'jsonc':
      return JsonIcon
    case 'md':
    case 'mdx':
    case 'markdown':
      return MarkdownIcon
    case 'html':
    case 'htm':
      return HtmlIcon
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return CssIcon
    case 'yaml':
    case 'yml':
      return YamlIcon
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
      return ShellIcon
    case 'sql':
      return SqlIcon
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return ImageIcon
    default:
      return GenericFileIcon
  }
}

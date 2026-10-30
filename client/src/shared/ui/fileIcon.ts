import {
  ConfigIcon,
  CssIcon,
  FolderIcon,
  GenericFileIcon,
  GitFolderIcon,
  HtmlIcon,
  ImageIcon,
  JavaScriptIcon,
  JsonIcon,
  MarkdownIcon,
  PythonIcon,
  ReactIcon,
  ShellIcon,
  SqlIcon,
  TypeScriptIcon,
  YamlIcon,
} from './FileIcons'

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

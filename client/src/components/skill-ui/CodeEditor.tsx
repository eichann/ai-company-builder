import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { useAppStore } from '../../stores/appStore'

// Language imports
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  fileName: string
  readOnly?: boolean
}

// Get language extension based on file extension
function getLanguageExtension(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'ts':
    case 'mts':
    case 'cts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'py':
    case 'pyw':
    case 'pyi':
      return python()
    case 'json':
    case 'jsonc':
      return json()
    case 'md':
    case 'mdx':
    case 'markdown':
      return markdown()
    case 'html':
    case 'htm':
      return html()
    case 'css':
    case 'scss':
    case 'less':
      return css()
    case 'yaml':
    case 'yml':
      return yaml()
    default:
      return null
  }
}

// Plugin to dynamically measure gutter width and set CSS variable for scrollbar alignment
const gutterWidthPlugin = ViewPlugin.fromClass(class {
  constructor(view: EditorView) {
    this.syncGutterWidth(view)
  }
  update(update: ViewUpdate) {
    if (update.geometryChanged) {
      this.syncGutterWidth(update.view)
    }
  }
  syncGutterWidth(view: EditorView) {
    const gutters = view.dom.querySelector('.cm-gutters') as HTMLElement | null
    if (gutters) {
      view.scrollDOM.style.setProperty('--cm-gutter-width', `${gutters.offsetWidth}px`)
    }
  }
})

// Custom dark theme to match app
const customDarkTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
    fontSize: '13px',
    lineHeight: '1.6',
    padding: '16px 0',
    maxWidth: '2000px',
  },
  '.cm-gutters': {
    backgroundColor: '#282c34',
    borderRight: '1px solid rgba(255,255,255,0.05)',
    color: '#4a4a4a',
    zIndex: 200,
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.3) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.4) !important',
  },
  '.cm-cursor': {
    borderLeftColor: '#fff',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(255,255,255,0.1)',
    border: 'none',
    color: '#888',
  },
  '.cm-tooltip': {
    backgroundColor: '#1e1e1e',
    border: '1px solid #333',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(59, 130, 246, 0.3)',
    },
  },
  '.cm-scroller::-webkit-scrollbar': {
    height: '6px',
    width: '6px',
  },
  '.cm-scroller::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-track:horizontal': {
    marginLeft: 'var(--cm-gutter-width, 80px)',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: '3px',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  '.cm-scroller::-webkit-scrollbar-corner': {
    background: 'transparent',
  },
}, { dark: true })

// Custom light theme to match app
const customLightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
    fontSize: '13px',
    lineHeight: '1.6',
    padding: '16px 0',
    caretColor: '#000',
    maxWidth: '2000px',
  },
  '.cm-gutters': {
    backgroundColor: '#f8f9fa',
    borderRight: '1px solid #e5e7eb',
    color: '#9ca3af',
    zIndex: 200,
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 16px',
    minWidth: '40px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#f3f4f6',
  },
  '.cm-activeLine': {
    backgroundColor: '#f9fafb',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.2) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.3) !important',
  },
  '.cm-cursor': {
    borderLeftColor: '#000',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#e5e7eb',
    border: 'none',
    color: '#6b7280',
  },
  '.cm-tooltip': {
    backgroundColor: '#ffffff',
    border: '1px solid #e5e7eb',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'rgba(59, 130, 246, 0.15)',
    },
  },
  '.cm-scroller::-webkit-scrollbar': {
    height: '6px',
    width: '6px',
  },
  '.cm-scroller::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '.cm-scroller::-webkit-scrollbar-track:horizontal': {
    marginLeft: 'var(--cm-gutter-width, 80px)',
  },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: '3px',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  '.cm-scroller::-webkit-scrollbar-corner': {
    background: 'transparent',
  },
}, { dark: false })

export function CodeEditor({ value, onChange, fileName, readOnly = false }: CodeEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const theme = useAppStore((state) => state.theme)

  // Create editor
  useEffect(() => {
    if (!editorRef.current) return

    const languageExt = getLanguageExtension(fileName)
    const isDark = theme === 'dark'

    const extensions = [
      // Basic setup
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      foldGutter(),
      history(),
      autocompletion(),

      // Syntax highlighting
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

      // Keymaps
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),

      // Themes - conditionally apply dark or light theme
      ...(isDark ? [oneDark, customDarkTheme] : [customLightTheme]),

      // Update listener
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChange(update.state.doc.toString())
        }
      }),

      // Read-only
      EditorState.readOnly.of(readOnly),

      // Gutter width measurement for scrollbar alignment
      gutterWidthPlugin,
    ]

    // Add language extension if available
    if (languageExt) {
      extensions.push(languageExt)
    }

    const state = EditorState.create({
      doc: value,
      extensions,
    })

    const view = new EditorView({
      state,
      parent: editorRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [fileName, theme]) // Recreate on fileName or theme change

  // Update content when value changes externally
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentContent = view.state.doc.toString()
    if (currentContent !== value) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: value,
        },
      })
    }
  }, [value])

  return (
    <div
      ref={editorRef}
      className="h-full overflow-auto"
    />
  )
}

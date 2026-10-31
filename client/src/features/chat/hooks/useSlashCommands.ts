import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import type { SlashCommandItem } from '../components/SlashCommandDropdown'
import { useLatestRef } from '../../../shared/hooks/useLatestRef'

/** The whole input is `/` plus a partial skill folder name. */
const SLASH_QUERY = /^\/([a-zA-Z0-9_-]*)$/

function filterSlashCommands(commands: SlashCommandItem[] | undefined, query: string | null): SlashCommandItem[] {
  if (query === null || !commands?.length) return []
  if (query === '') return commands
  const q = query.toLowerCase()
  return commands.filter(item => item.command.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
}

/**
 * The 「/」 skill list of the composer. Query and selection are kept in refs
 * as well as state, because the editor's key handler (made once) reads them
 * between renders: Tab right after the list narrowed picks its first row.
 */
export function useSlashCommands(slashCommands: SlashCommandItem[] | undefined, editorViewRef: RefObject<EditorView | null>) {
  const [query, setQueryState] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndexState] = useState(0)
  const queryRef = useRef<string | null>(null)
  const selectedIndexRef = useRef(0)
  const commandsRef = useLatestRef(slashCommands)
  const items = useMemo(() => filterSlashCommands(slashCommands, query), [slashCommands, query])

  const setSelectedIndex = useCallback((index: number) => {
    selectedIndexRef.current = index
    setSelectedIndexState(index)
  }, [])

  // The selection goes back to the first row whenever the list changes length.
  const setQuery = useCallback((next: string | null) => {
    const before = filterSlashCommands(commandsRef.current, queryRef.current).length
    queryRef.current = next
    setQueryState(next)
    if (filterSlashCommands(commandsRef.current, next).length !== before) setSelectedIndex(0)
  }, [commandsRef, setSelectedIndex])

  const close = useCallback(() => setQuery(null), [setQuery])

  const select = useCallback((item: SlashCommandItem) => {
    const view = editorViewRef.current
    if (!view) return
    const replacement = `/${item.command} `
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement } })
    view.dispatch({ selection: { anchor: replacement.length } })
    view.focus()
    setQuery(null)
  }, [editorViewRef, setQuery])

  const onDocChanged = useCallback((text: string) => {
    if (!commandsRef.current?.length) return
    setQuery(SLASH_QUERY.exec(text)?.[1] ?? null)
  }, [commandsRef, setQuery])

  /**
   * Keys while the list shows: true = handled, false = stop here and let the
   * editor have the key (Enter closes the list and is a new line), undefined =
   * not the list's key.
   */
  const handleKey = useCallback((event: KeyboardEvent): boolean | undefined => {
    const shown = filterSlashCommands(commandsRef.current, queryRef.current)
    if (shown.length === 0) return undefined
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setSelectedIndex((selectedIndexRef.current + 1) % shown.length)
        return true
      case 'ArrowUp':
        event.preventDefault()
        setSelectedIndex((selectedIndexRef.current - 1 + shown.length) % shown.length)
        return true
      case 'Tab': {
        event.preventDefault()
        const selected = shown[selectedIndexRef.current]
        if (selected) select(selected)
        return true
      }
      case 'Enter':
        setQuery(null)
        return false
      case 'Escape':
        event.preventDefault()
        setQuery(null)
        return true
      default:
        return undefined
    }
  }, [commandsRef, select, setQuery, setSelectedIndex])

  return { query, items, selectedIndex, select, close, onDocChanged, handleKey }
}

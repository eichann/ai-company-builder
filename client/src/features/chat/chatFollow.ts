import { createContext } from 'react'

/**
 * Something in the conversation grew after its message rendered (a rich reply's frame took its height): the list
 * follows the bottom again if, and only if, it was following (`useChatAutoScroll`'s one rule). Outside a
 * conversation it does nothing.
 */
export const ChatFollowContext = createContext<() => void>(() => {})

import remarkGfm from 'remark-gfm'
import { ChatMarkdownImage } from './components/ChatMarkdownImage'

/**
 * The react-markdown props that keep chat output from loading anything: GFM, raw HTML
 * dropped (`skipHtml`; never add rehype-raw here) and images as placeholders. Shared by
 * MarkdownMessage and its test so the test exercises the configuration that ships.
 */
export const chatMarkdownSafety = {
  remarkPlugins: [remarkGfm],
  skipHtml: true,
  components: { img: ChatMarkdownImage },
} as const

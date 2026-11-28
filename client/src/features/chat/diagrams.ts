// Which code blocks of a reply are diagrams, and what of their text the drawing may use (pure: no DOM).
// The drawing itself and its guards are diagramRenderer.ts and svgCleaning.ts; chat-ui-and-history.md "Diagrams in a reply".

export type DiagramKind = 'mermaid' | 'svg'
export interface Diagram { kind: DiagramKind; source: string }

/** Larger blocks stay code: drawing them would cost more than the picture is worth (mermaid lays out on the page's thread). */
export const DIAGRAM_MAX_CHARS = 60_000
export const MERMAID_MAX_CHARS = 20_000

const WHOLE_SVG = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>][\s\S]*<\/svg>\s*$/i

/**
 * A fenced block drawn as a diagram: ```mermaid, or ```svg / ```xml / an unlabelled block that is one whole
 * `<svg>` element. Anything else (```html with an svg inside included) stays code.
 */
export function diagramOf(language: string | undefined, code: string): Diagram | null {
  if (!code.trim() || code.length > DIAGRAM_MAX_CHARS) return null
  const lang = (language ?? '').toLowerCase()
  if (lang === 'mermaid') return code.length <= MERMAID_MAX_CHARS ? { kind: 'mermaid', source: code } : null
  if ((lang === 'svg' || lang === 'xml' || lang === '') && WHOLE_SVG.test(code)) return { kind: 'svg', source: code }
  return null
}

/**
 * The mermaid text without what could change how mermaid is set up: `%%{init …}%%` directives and a leading
 * `---` front matter (its `config:`). The app's settings (strict security, no HTML labels) are then the only ones.
 */
export function mermaidWithoutConfig(source: string): string {
  let text = source.replace(/^\s*---[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/, '')
  // Again until nothing changes: taking one out must not join its neighbours into a new one (`%%%%{x}%%{init…}%%`).
  for (let before = ''; before !== text;) {
    before = text
    text = text.replace(/%%\{[\s\S]*?\}%%/g, '')
  }
  return text
}

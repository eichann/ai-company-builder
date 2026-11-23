import { splitFrontmatter } from '../../../../shared/core/yaml-lite'
import { parseFrontmatter } from '../../../shared/skill-frontmatter'

export interface PreviewFrontmatter {
  /** What the block says about the file, shown as a small quiet box; null when it says neither. */
  info: { name?: string; description?: string } | null
  /** The Markdown to render: the file without its `---` block. */
  body: string
}

/**
 * The preview of a Markdown file with frontmatter (a SKILL.md's `name` / `description`): the
 * block is data for the AI, not text — rendered as Markdown it became a bold underlined heading.
 * The source view is unchanged; only the preview leaves the block out.
 */
export function previewFrontmatter(content: string): PreviewFrontmatter {
  const split = splitFrontmatter(content)
  if (!split) return { info: null, body: content }
  const fields = parseFrontmatter(`---\n${split.yaml}\n---\n`)
  const name = fields.name?.trim()
  const description = fields.description?.trim()
  const info = name || description ? { ...(name ? { name } : {}), ...(description ? { description } : {}) } : null
  return { info, body: split.body }
}

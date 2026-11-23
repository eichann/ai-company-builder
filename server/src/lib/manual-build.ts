/**
 * Builds the user manual's static site from `manual/` (`src/cli/build-manual.ts`,
 * run when the server image is built; `.claude/rules/server.md` "The user manual"):
 *
 *   manual/pages/<page>.md     → <out>/<page>.html  (manual-render.ts)
 *   manual/images/<name>.png   → <out>/images/<name>.png  (only pictures a page shows)
 *   design tokens               → <out>/manual.css
 *   the list of all of it       → <out>/manifest.json (sha256 and size of each file; written last)
 *
 * The server serves only what the manifest names; the app copies only that.
 * A page that does not render (an unknown link, a picture outside ../images/,
 * a missing picture) stops the build: a broken manual never ships.
 */
import { createHash } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  isManualFilePath, isManualPageId, manualPageFile, MANUAL_INDEX_PAGE, MANUAL_MANIFEST, MANUAL_MANIFEST_FORMAT,
  parseManualManifest, type ManualFile, type ManualManifest, type ManualPage,
} from '../../shared/core/manual'
import { ManualBuildError, renderManualPage } from './manual-render'

/** The page's own look, over the design tokens' variables (light, and dark when the system is). */
const MANUAL_CSS = `
html { color-scheme: light dark; }
body { margin: 0; background: var(--color-bg); color: var(--color-text); font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif; font-size: 15px; line-height: 1.75; }
nav, main { max-width: 760px; margin: 0 auto; padding: 0 var(--space-6); }
nav { padding-top: var(--space-5); font-size: var(--font-size-small); }
main { padding-bottom: var(--space-8); }
h1 { font-size: 26px; line-height: 1.3; margin: var(--space-6) 0 var(--space-5); }
h2 { font-size: 20px; line-height: 1.35; margin: var(--space-8) 0 var(--space-3); padding-bottom: var(--space-1-5); border-bottom: var(--border-width) solid var(--color-border); }
h3 { font-size: 17px; margin: var(--space-6) 0 var(--space-2); }
a { color: var(--color-link); }
a:hover { color: var(--color-link-hover); }
img { max-width: 100%; height: auto; border: var(--border-width) solid var(--color-border); border-radius: var(--radius-control); }
code { font-size: 0.92em; background: var(--color-surface-sunken); padding: 0.1em 0.35em; border-radius: var(--radius-small); }
pre { background: var(--color-surface-sunken); padding: var(--space-3); border-radius: var(--radius-control); overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: var(--space-4) 0; }
th, td { border: var(--border-width) solid var(--color-border); padding: var(--space-1-5) var(--space-3); text-align: left; }
blockquote { margin: var(--space-4) 0; padding: var(--space-2) var(--space-4); border-left: 4px solid var(--color-border); color: var(--color-text-muted); }
`

/**
 * The design tokens' two stylesheets, with the dark theme (`.dark`, set by the apps' own script)
 * moved under `prefers-color-scheme: dark`: the manual runs no script.
 */
export function manualStylesheet(tokensDir: string): string {
  const primitives = readFileSync(join(tokensDir, 'primitives.css'), 'utf8')
  const theme = readFileSync(join(tokensDir, 'theme.css'), 'utf8')
  const start = theme.indexOf('\n.dark {')
  const end = start < 0 ? -1 : theme.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new ManualBuildError('theme.css has no .dark block')
  const dark = `\n@media (prefers-color-scheme: dark) {\n:root {${theme.slice(start + '\n.dark {'.length, end)}\n}\n}`
  return `${primitives}\n${theme.slice(0, start)}${dark}${theme.slice(end + 2)}\n${MANUAL_CSS}`
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

/** Builds the site into `outDir` (made new; a previous build there is replaced) and returns its manifest. */
export function buildManualSite(sourceDir: string, outDir: string, tokensDir: string): ManualManifest {
  const pagesDir = join(sourceDir, 'pages')
  const imagesDir = join(sourceDir, 'images')
  const sources = readdirSync(pagesDir).filter(name => name.endsWith('.md') && !name.startsWith('.')).sort()
  const ids = sources.map(name => name.slice(0, -'.md'.length))
  for (const id of ids) if (!isManualPageId(id)) throw new ManualBuildError(`manual/pages/${id}.md: page names are a-z, 0-9 and -`)
  if (!ids.includes(MANUAL_INDEX_PAGE)) throw new ManualBuildError('manual/pages/index.md is missing')

  if (existsSync(outDir)) {
    // Only a folder this build made before (it holds a manifest) is replaced, never anything else.
    if (!existsSync(join(outDir, MANUAL_MANIFEST))) throw new ManualBuildError(`${outDir} exists and is not a built manual`)
    rmSync(outDir, { recursive: true })
  }
  mkdirSync(join(outDir, 'images'), { recursive: true })

  const known = new Set(ids)
  const files: ManualFile[] = []
  const pages: ManualPage[] = []
  const images = new Set<string>()
  const put = (path: string, bytes: Buffer | string) => {
    if (!isManualFilePath(path)) throw new ManualBuildError(`not a file name the manual may have: ${path}`)
    writeFileSync(join(outDir, path), bytes)
    files.push({ path, sha256: sha256(bytes), size: Buffer.byteLength(bytes) })
  }
  for (const id of ids) {
    const page = renderManualPage(id, readFileSync(join(pagesDir, `${id}.md`), 'utf8'), known)
    put(manualPageFile(id), page.html)
    pages.push({ id, title: page.title })
    for (const image of page.images) images.add(image)
  }
  for (const image of [...images].sort()) {
    const from = join(imagesDir, image.slice('images/'.length))
    // A link in manual/images is not followed: the build copies files, nothing they point to.
    if (!existsSync(from) || !lstatSync(from).isFile()) throw new ManualBuildError(`a page shows ${image}, but manual/${image} is not a file`)
    put(image, readFileSync(from))
  }
  put('manual.css', manualStylesheet(tokensDir))
  // The index first, then the rest by name.
  pages.sort((a, b) => (a.id === MANUAL_INDEX_PAGE ? -1 : b.id === MANUAL_INDEX_PAGE ? 1 : a.id.localeCompare(b.id)))
  const manifest: ManualManifest = { format: MANUAL_MANIFEST_FORMAT, pages, files }
  if (!parseManualManifest(manifest)) throw new ManualBuildError('the manual is larger than the limits allow')
  writeFileSync(join(outDir, MANUAL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

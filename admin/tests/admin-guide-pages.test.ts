// Guards the administrator guide (manual-admin/README.md), as client/tests/manual-pages.test.ts and
// manual-ui-names.test.ts guard the members' manual:
// - every picture a page shows is there, as ../images/<name>.png (the shoot writes them; pages are
//   written by hand, so a renamed or dropped scene would otherwise leave a broken picture — the
//   server image build would stop on it, this says so on the pull request);
// - every ［name］ the guide cites is still one whole piece of text in the screens it describes (the
//   admin console, and the app's screens for the settings an FDE touches), so the pull request that
//   renames a control fails until the guide says the new name. Names on screens this repository
//   does not draw go in manual-admin/ui-names-allowlist.json with their reason.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const GUIDE = path.join(ROOT, 'manual-admin')
const PAGES = path.join(GUIDE, 'pages')
const ALLOWLIST = path.join(GUIDE, 'ui-names-allowlist.json')
// The admin console, and the app's screens and words (the guide's 10・13・15節 show its settings).
const SOURCES = ['admin/src', 'client/src', 'client/shared']

const pages = () => fs.readdirSync(PAGES).filter((name) => name.endsWith('.md')).sort()
const read = (page: string) => fs.readFileSync(path.join(PAGES, page), 'utf8')

/** Local picture references in a Markdown page: ![…](src) and <img src="…">. */
function pictureRefs(markdown: string): string[] {
  const refs = [
    ...[...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]),
  ]
  return refs.filter((ref) => !/^[a-z][a-z0-9+.-]*:/i.test(ref))
}

/** The ［…］ names a page cites (full-width brackets are the guide's convention for controls). */
const citedNames = (markdown: string) => [...markdown.matchAll(/［([^］\n]+)］/g)].map((m) => m[1].trim())

/**
 * Whether `source` holds `name` as one whole piece of text (a string literal, JSX text or a JSON
 * value), not merely inside a longer sentence. The members' manual's twin is
 * client/tests/manual-ui-names.test.ts `holdsName`.
 */
function holdsName(source: string, name: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:['"\`>]|^)\\s*${escape(name)}\\s*(?:['"\`<]|$)`, 'm').test(source)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(tsx?|json)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

describe('the administrator guide', () => {
  it('finds Markdown and HTML pictures, not links or web addresses', () => {
    expect(pictureRefs('![a](../images/x.png)\n[link](other.md)\n<img alt="b" src="../images/y.png">\n![c](https://example.com/z.png)'))
      .toEqual(['../images/x.png', '../images/y.png'])
  })

  it('shows only pictures that are in manual-admin/images, named ../images/<name>.png', () => {
    expect(pages().length).toBeGreaterThan(0)
    const problems: string[] = []
    for (const page of pages()) {
      for (const ref of pictureRefs(read(page))) {
        if (!/^\.\.\/images\/[a-z0-9][a-z0-9-]*\.png$/.test(ref)) problems.push(`${page}: ${ref} is not ../images/<name>.png`)
        else if (!fs.existsSync(path.join(PAGES, ref))) problems.push(`${page}: ${ref} does not exist (run pnpm manual-admin:shoot)`)
      }
    }
    expect(problems).toEqual([])
  })

  it('tells a name on the screen from the same words inside a sentence', () => {
    expect(holdsName('<Button>メンバーを招待</Button>', 'メンバーを招待')).toBe(true)
    expect(holdsName(`label: '定期の仕事を作る',`, '定期の仕事を作る')).toBe(true)
    expect(holdsName(`'［止める］を押してください'`, '止める')).toBe(false)
    expect(holdsName('<Button>止めるのをやめる</Button>', '止める')).toBe(false)
  })

  it('cites only ［names］ the screens still show (or that are allowlisted with a reason)', () => {
    const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Record<string, string>
    for (const [name, reason] of Object.entries(allowlist)) expect(reason.trim(), `allowlist entry ［${name}］ has no reason`).not.toBe('')
    const source = SOURCES.flatMap((dir) => sourceFiles(path.join(ROOT, dir))).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    const missing: string[] = []
    const cited = new Set<string>()
    for (const page of pages()) {
      for (const name of citedNames(read(page))) {
        cited.add(name)
        if (!(name in allowlist) && !holdsName(source, name)) missing.push(`${page}: ［${name}］ is not a name in the screens`)
      }
    }
    expect(missing).toEqual([])
    expect(Object.keys(allowlist).filter((name) => !cited.has(name)), 'allowlist entries no page cites').toEqual([])
  })
})

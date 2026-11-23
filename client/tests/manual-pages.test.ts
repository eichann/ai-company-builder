// Guards the user manual (manual/README.md): every picture a page shows is
// there. The pictures are generated (`pnpm manual:shoot`) and pages are written
// by hand, so a renamed or dropped scene would otherwise leave a broken image
// in the manual members read. Pictures are referred to only as
// ../images/<name>.png, the layout the manual's hosting serves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MANUAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../manual')

/** Local picture references in a Markdown page: ![…](src) and <img src="…">. */
function pictureRefs(markdown: string): string[] {
  const refs = [
    ...[...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(m => m[1]),
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]),
  ]
  return refs.filter(ref => !/^[a-z][a-z0-9+.-]*:/i.test(ref))
}

test('pictureRefs finds Markdown and HTML pictures, not links or web addresses', () => {
  assert.deepEqual(
    pictureRefs('![a](../images/x.png)\n[link](other.md)\n<img alt="b" src="../images/y.png">\n![c](https://example.com/z.png)'),
    ['../images/x.png', '../images/y.png'],
  )
})

test('every picture a manual page shows exists in manual/images', () => {
  const pagesDir = path.join(MANUAL, 'pages')
  const pages = fs.readdirSync(pagesDir).filter(name => name.endsWith('.md'))
  assert.ok(pages.length > 0, 'manual/pages has no pages')
  const problems: string[] = []
  for (const page of pages) {
    for (const ref of pictureRefs(fs.readFileSync(path.join(pagesDir, page), 'utf8'))) {
      if (!/^\.\.\/images\/[a-z0-9][a-z0-9-]*\.png$/.test(ref)) problems.push(`${page}: ${ref} is not ../images/<scene-id>.png`)
      else if (!fs.existsSync(path.join(pagesDir, ref))) problems.push(`${page}: ${ref} does not exist (run pnpm manual:shoot)`)
    }
  }
  assert.deepEqual(problems, [])
})

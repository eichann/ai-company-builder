// Guards the user manual (manual/README.md "Names of buttons"): every button or label name the
// manual's text cites as ［名前］ still exists in the app's screens, so renaming a control in the app
// fails CI instead of leaving members looking for a button that is no longer there.
//
// A name counts as present when the screens' source (client/src, the words the screens take from
// client/shared (thing-words.ts' buttons such as 「引き受ける」「済んだ」, the mail card's 「直す」), the questions
// sync asks in the Mac's own dialogs (client/electron/sync), the admin console's pages for the invitation page,
// the Japanese locale in client/src/i18n) holds it as one whole piece of text: a string literal, JSX
// text or a JSON value — not merely inside a longer sentence. A name the manual shows with a count
// (［選んだ部署をダウンロード（1）］) matches the source's template (`…（${n}）`). Names on screens
// this repository does not draw are listed in manual/ui-names-allowlist.json with their reason.
//
// Why a source check and not the screenshot run: this one runs in CI on every pull request (the
// shoot does not), so the pull request that renames a control is the one that fails; it also
// covers screens no scene opens (the invitation page in the admin console).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PAGES = path.join(ROOT, 'manual/pages')
const ALLOWLIST = path.join(ROOT, 'manual/ui-names-allowlist.json')
// The admin console's invitation page is where a member starts (chapter 2); it is listed in
// .github/scripts/changed-areas.sh's CLIENT, so changing it runs this test.
// Sync's questions (「同期をやめる（おすすめ）」…) are native dialogs the main process draws
// (client/electron/sync/message-box-dialog.ts): the manual's chapter 9 cites their buttons.
// The words module client/shared/thing-words.ts (and the other client/shared modules the screens read their
// labels from) holds the buttons of the 2日目 chapters (17–27): 「引き受ける」「済んだ」「終わりにする」….
const SOURCES = ['client/src', 'client/shared', 'client/electron/sync', 'admin/src/app/invite']

/** The ［…］ names a manual page cites (full-width brackets are the manual's convention for controls). */
export function citedNames(markdown: string): string[] {
  return [...markdown.matchAll(/［([^］\n]+)］/g)].map(m => m[1].trim())
}

/** Whether `source` holds `name` as one whole piece of text (literal, JSX text, JSON value). */
export function holdsName(source: string, name: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const counted = name.match(/^(.*（)\d+(）)$/)
  // `…（${picked.size}）` in the source for a name shown with its count.
  const body = counted ? `${escape(counted[1])}\\$\\{[^}]*\\}${escape(counted[2])}` : escape(name)
  const before = `(?:['"\`>]|^)\\s*`
  const after = `\\s*(?:['"\`<]|$)`
  return new RegExp(`${before}${body}${after}`, 'm').test(source)
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

test('holdsName finds whole pieces of text, counts as templates, and not words inside sentences', () => {
  assert.ok(holdsName(`<button>つなぐ</button>`, 'つなぐ'))
  assert.ok(holdsName(`title="サーバーと同期"`, 'サーバーと同期'))
  assert.ok(holdsName(`  "newFile": "新規ファイル",`, '新規ファイル'))
  assert.ok(holdsName('? `選んだ部署をダウンロード（${picked.size}）`', '選んだ部署をダウンロード（1）'))
  assert.ok(holdsName(`<button>\n  開始\n  <ArrowRight /></button>`, '開始'))
  assert.ok(!holdsName(`'［つなぐ］を押してください'`, 'つなぐ'))
  assert.ok(!holdsName(`<button>つなぎ直す</button>`, 'つなぐ'))
})

test('every ［name］ the manual cites is a name the app still shows (or is allowlisted with a reason)', () => {
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Record<string, string>
  for (const [name, reason] of Object.entries(allowlist)) {
    assert.ok(typeof reason === 'string' && reason.trim().length > 0, `allowlist entry ［${name}］ has no reason`)
  }
  const source = SOURCES.flatMap(dir => sourceFiles(path.join(ROOT, dir))).map(file => fs.readFileSync(file, 'utf8')).join('\n')
  const missing: string[] = []
  const cited = new Set<string>()
  for (const page of fs.readdirSync(PAGES).filter(name => name.endsWith('.md')).sort()) {
    for (const name of citedNames(fs.readFileSync(path.join(PAGES, page), 'utf8'))) {
      cited.add(name)
      if (!(name in allowlist) && !holdsName(source, name)) missing.push(`${page}: ［${name}］ is not a name in the app's screens`)
    }
  }
  assert.deepEqual(missing, [], 'rename the manual\'s text (and re-shoot) or, for a screen outside this repository, add it to manual/ui-names-allowlist.json')
  const stale = Object.keys(allowlist).filter(name => !cited.has(name))
  assert.deepEqual(stale, [], 'allowlist entries no manual page cites any more')
})

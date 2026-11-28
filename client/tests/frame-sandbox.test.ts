// No frame of the app may be sandboxed with both `allow-scripts` and `allow-same-origin`: together they let the
// frame's script remove its own sandbox and reach the app (owner condition for the rich reply's hidden copy,
// chat-ui-and-history.md "Rich replies: the reply's closed frame"). Read from the code's own strings (comments
// do not count), over the whole app: the renderer, main and what they share.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const client = resolve(fileURLToPath(import.meta.url), '../..')
const ROOTS = ['src', 'electron', 'shared', 'connectors', 'connector-maps'].map(dir => join(client, dir))

function sourceFiles(dir: string): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return [] }
  return entries.flatMap(name => {
    const path = join(dir, name)
    if (name === 'node_modules') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Every piece of string the file's code holds (literals and template parts), comments left out. */
function codeStrings(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) found.push(node.text)
    node.forEachChild(visit)
  }
  visit(file)
  return found
}

/** Files whose code says both: a sandbox could be put together from them (one string, or two joined). */
function filesAllowingBoth(files: Array<{ path: string; strings: string[] }>): string[] {
  return files.filter(({ strings }) => strings.some(s => /\ballow-scripts\b/.test(s)) && strings.some(s => /\ballow-same-origin\b/.test(s))).map(f => f.path)
}

test('no frame of the app is sandboxed with both allow-scripts and allow-same-origin', () => {
  const files = ROOTS.flatMap(sourceFiles).map(path => ({ path: relative(client, path), strings: codeStrings(path) }))
  assert.ok(files.length > 500, `read ${files.length} files`)
  assert.deepEqual(filesAllowingBoth(files), [])
})

test('the check sees both in one string, in two strings of one file and in a template', () => {
  assert.deepEqual(filesAllowingBoth([
    { path: 'one', strings: ['allow-same-origin allow-scripts'] },
    { path: 'two', strings: ['allow-scripts', 'x', 'allow-same-origin'] },
    { path: 'apart', strings: ['allow-scripts'] },
    { path: 'other', strings: ['allow-same-origin', 'allow-popups'] },
  ]), ['one', 'two'])
  assert.deepEqual(codeStrings(join(client, 'src/features/chat/richReplyFrame.ts')).filter(s => /allow-/.test(s)).sort(), ['allow-popups', 'allow-same-origin'])
})

test('the rich reply\'s two frames have exactly these sandboxes', () => {
  const source = readFileSync(join(client, 'src/features/chat/richReplyFrame.ts'), 'utf8')
  assert.match(source, /export const SHOWN_FRAME_SANDBOX = 'allow-popups'\n/)
  assert.match(source, /export const MEASURE_FRAME_SANDBOX = 'allow-same-origin'\n/)
})

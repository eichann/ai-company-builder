import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { localFilePathFromUrl, localFileUrl } from '../shared/local-file-url'
import { byteRange, localFileTarget, localVideoTarget } from '../electron/local-file-protocol'
import { isVideoFileName, localVideoPathFromUrl, localVideoUrl } from '../shared/video-files'
import { FileVersionStore } from '../src/shared/lib/fileVersions'

const ROOT = path.resolve('/Users/me/Documents/AI Company Builder/abe-shoten')

test('versioned URLs: ?v=<n> only when there is a version; the path round-trips', () => {
  const p = `${ROOT}/コンテンツ/画像 1.png`
  assert.equal(localFileUrl(p), `local-file://${p}`)
  assert.equal(localFileUrl(p, 0), `local-file://${p}`)
  assert.equal(localFileUrl(p, 3), `local-file://${p}?v=3`)
  assert.equal(localFilePathFromUrl(localFileUrl(p, 3)), p)
  assert.equal(localFilePathFromUrl(localFileUrl(p)), p)
})

test('a name with %, ? or # survives (escaped when building, decoded when serving)', () => {
  for (const name of ['50%off.png', 'what?.png', 'no#1.png', '100%25.png']) {
    const p = `${ROOT}/${name}`
    assert.equal(localFilePathFromUrl(localFileUrl(p, 2)), p, name)
  }
})

test('the protocol strips the query and fragment, decodes what Chromium encoded', () => {
  assert.equal(localFilePathFromUrl('local-file:///a/b.png?v=12'), '/a/b.png')
  assert.equal(localFilePathFromUrl('local-file:///a/b.png#x'), '/a/b.png')
  assert.equal(localFilePathFromUrl('local-file:///a/%E7%94%BB%E5%83%8F.png?v=1'), '/a/画像.png')
  assert.equal(localFilePathFromUrl('local-file:///a/%E0%A4%A.png'), null) // malformed escape
  assert.equal(localFilePathFromUrl('file:///a/b.png'), null)
})

// Serving inside / outside the allowed roots (versioned URL, traversal, a
// sibling with the same prefix, an empty URL) goes through the registered
// protocol handler in ipc-fs.test.ts. The cases only reachable here:
test('serving: a query cannot smuggle an allowed path, no roots serves nothing, other schemes are refused', () => {
  const roots = [ROOT]
  assert.deepEqual(localFileTarget(`local-file:///etc/passwd?${ROOT}/x.png`, roots), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget(`local-file://${ROOT}/x.png`, []), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget('https://example.com/x.png', roots), { ok: false, status: 400 })
})

test('file versions: bumped per path on every event; a removed folder bumps what was inside', () => {
  const store = new FileVersionStore()
  let notified = 0
  store.subscribe(() => notified++)
  const img = `${ROOT}/部署/図.png`
  assert.equal(store.get(img), 0)
  store.bump([{ type: 'change', path: img }])
  assert.equal(store.get(img), 1)
  // replaced: unlink + add (two batches) → two bumps; add alone → one
  store.bump([{ type: 'unlink', path: img }])
  store.bump([{ type: 'add', path: img }])
  assert.equal(store.get(img), 3)
  // Windows separators compare equal
  assert.equal(store.get(img.replace(/\//g, '\\')), 3)
  // the folder went away (reported as unlink when the watcher never saw it as a folder)
  store.bump([{ type: 'unlink', path: `${ROOT}/部署` }])
  assert.equal(store.get(img), 4)
  assert.equal(store.get(`${ROOT}/部署2/x.png`), 0)
  assert.equal(notified, 4)
})

test('acb-media:// URLs: the whole path is one segment, so no name (%, ?, #, .., a space, Japanese) changes what is read', () => {
  for (const name of ['説明 1.mov', '50%off.mp4', 'what?.mp4', 'no#1.MOV', '..%2F..%2Fx.mp4']) {
    const p = `${ROOT}/動画/${name}`
    assert.equal(localVideoPathFromUrl(localVideoUrl(p, 4)), p, name)
    // What Chromium hands the handler for a standard scheme: the URL as parsed.
    assert.equal(localVideoPathFromUrl(new URL(localVideoUrl(p, 4)).href), p, name)
  }
  assert.equal(localVideoUrl(`${ROOT}/a.mp4`, 0).includes('?'), false)
  assert.equal(localVideoPathFromUrl('acb-media://video/a/b.mp4'), null)
  assert.equal(localVideoPathFromUrl('acb-media://other/%2Fa.mp4'), null)
  assert.equal(localVideoPathFromUrl('local-file:///a.mp4'), null)
})

test('acb-media:// reads videos inside the roots only, never another type', () => {
  assert.deepEqual(localVideoTarget(localVideoUrl(`${ROOT}/動画/a.mov`), [ROOT]), { ok: true, path: `${ROOT}/動画/a.mov` })
  assert.deepEqual(localVideoTarget(localVideoUrl(`${ROOT}/../other/a.mp4`), [ROOT]), { ok: false, status: 403 })
  assert.deepEqual(localVideoTarget(localVideoUrl(`${ROOT}/.env`), [ROOT]), { ok: false, status: 403 })
  assert.deepEqual(localVideoTarget(localVideoUrl(`${ROOT}/memo.mp4.txt`), [ROOT]), { ok: false, status: 403 })
  assert.equal(isVideoFileName('.mp4'), false)
  assert.equal(isVideoFileName('a.MOV'), true)
})

test('a byte range: one range, clipped to the file; several ranges or other units read the whole file; past the end is 416', () => {
  assert.deepEqual(byteRange(null, 100), { kind: 'full' })
  assert.deepEqual(byteRange('bytes=0-', 100), { kind: 'part', start: 0, end: 99 })
  assert.deepEqual(byteRange('bytes=10-19', 100), { kind: 'part', start: 10, end: 19 })
  assert.deepEqual(byteRange('bytes=90-500', 100), { kind: 'part', start: 90, end: 99 })
  assert.deepEqual(byteRange('bytes=-30', 100), { kind: 'part', start: 70, end: 99 })
  assert.deepEqual(byteRange('bytes=-300', 100), { kind: 'part', start: 0, end: 99 })
  assert.deepEqual(byteRange('bytes=100-', 100), { kind: 'unsatisfiable' })
  assert.deepEqual(byteRange('bytes=-0', 100), { kind: 'unsatisfiable' })
  assert.deepEqual(byteRange('bytes=0-', 0), { kind: 'unsatisfiable' })
  for (const other of ['bytes=0-1,5-9', 'items=0-1', 'bytes=-', 'bytes=20-10', 'bytes=x-1']) assert.deepEqual(byteRange(other, 100), { kind: 'full' }, other)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { localFilePathFromUrl, localFileUrl } from '../shared/local-file-url'
import { localFileTarget } from '../electron/local-file-protocol'
import { FileVersionStore } from '../src/lib/fileVersions'

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

test('serving keeps the path restrictions: inside an allowed root only, query or not', () => {
  const roots = [ROOT]
  const inside = `${ROOT}/営業部/図.png`
  assert.deepEqual(localFileTarget(localFileUrl(inside, 5), roots), { ok: true, path: path.resolve(inside) })
  assert.deepEqual(localFileTarget(localFileUrl(inside), roots), { ok: true, path: path.resolve(inside) })
  // outside, traversal, a sibling with the same prefix, a query that tries to smuggle a path
  assert.deepEqual(localFileTarget('local-file:///etc/passwd?v=1', roots), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget(`local-file://${ROOT}/../secret.png?v=1`, roots), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget(`local-file://${ROOT}-other/x.png`, roots), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget(`local-file:///etc/passwd?${ROOT}/x.png`, roots), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget(`local-file://${ROOT}/x.png`, []), { ok: false, status: 403 })
  assert.deepEqual(localFileTarget('local-file://', roots), { ok: false, status: 400 })
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

// The 「非公開フォルダについて」 text exists twice: client/shared/private-folder-help.ts
// (desktop app) and admin/src/lib/private-folder-help.ts (admin console). The admin's
// Docker build copies admin/ only, so the admin cannot import the client copy and its
// tests must not reach outside admin/ either — this parity check lives here instead.
// Both files are plain constants; compare their code with the leading comment removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(__dirname, '..', '..')
const code = (rel: string) =>
  readFileSync(join(repo, rel), 'utf8')
    .split('\n')
    .filter((line, i, all) => !(line.startsWith('//') && all.slice(0, i).every((l) => l.startsWith('//'))))
    .join('\n')
    .trim()

test('the admin and the desktop app show the same private-folder help text', () => {
  const client = code('client/shared/private-folder-help.ts')
  assert.match(client, /PRIVATE_FOLDER_HELP/)
  assert.equal(code('admin/src/lib/private-folder-help.ts'), client)
})

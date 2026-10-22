// The 「非公開フォルダについて」 text exists twice: client/shared/private-folder-help.ts
// (desktop app) and admin/src/lib/private-folder-help.ts (admin console). The admin's
// Docker build copies admin/ only, so the admin cannot import the client copy and its
// tests must not reach outside admin/ either — this parity check lives here instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as clientHelp from '../shared/private-folder-help'
import * as adminHelp from '../../admin/src/lib/private-folder-help'

test('the admin and the desktop app show the same private-folder help text', () => {
  assert.deepEqual(adminHelp.PRIVATE_FOLDER_HELP, clientHelp.PRIVATE_FOLDER_HELP)
  assert.equal(adminHelp.PRIVATE_FOLDER_HELP_TITLE, clientHelp.PRIVATE_FOLDER_HELP_TITLE)
  assert.equal(adminHelp.REMOVED_VIEWER_CAVEAT, clientHelp.REMOVED_VIEWER_CAVEAT)
  assert.equal(adminHelp.MANAGERS_MAY_CHANGE_VIEWERS, clientHelp.MANAGERS_MAY_CHANGE_VIEWERS)
})

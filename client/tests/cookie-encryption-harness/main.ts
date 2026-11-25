// The Electron side of tests/cookie-encryption-electron.test.ts: in one `persist:` partition, reads the cookie an
// earlier run left (`COOKIE_TEST_READ`), sets one (`COOKIE_TEST_SET` = value), writes the store to disk and quits,
// writing `{ read }` to `<COOKIE_TEST_DIR>/result.json`. `--use-mock-keychain`: Chromium's own test keychain, so the
// test needs no macOS Keychain item (the encryption itself is the same).
import { app, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.COOKIE_TEST_DIR!
app.commandLine.appendSwitch('use-mock-keychain')
app.setPath('userData', path.join(dir, 'userData'))

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:acb-browser-keep-test')
  const read = (await ses.cookies.get({ name: 'sid' }))[0]?.value ?? null
  const value = process.env.COOKIE_TEST_SET
  if (value) await ses.cookies.set({ url: 'https://op.test/', name: 'sid', value, secure: true, expirationDate: Math.floor(Date.now() / 1000) + 3600 })
  await ses.cookies.flushStore()
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ read }))
  // The store is on disk (flushed above); with no window `quit` would wait.
  app.exit(0)
}).catch(error => {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ error: String(error) }))
  app.exit(1)
})

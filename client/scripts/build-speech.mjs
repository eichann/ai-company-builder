import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
if (process.platform !== 'darwin') process.exit(0)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = path.join(root, 'native/bin')
mkdirSync(out, { recursive: true })
const result = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, path.join(root, 'native/SpeechHelper.swift'), '-o', path.join(out, 'acb-speech'), '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(root, 'native/Info.plist')], { stdio: 'inherit' })
process.exit(result.status ?? 1)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
if (process.platform !== 'darwin') process.exit(0)
const root = fileURLToPath(new URL('..', import.meta.url))
const out = path.join(root, 'native/bin')
mkdirSync(out, { recursive: true })

// The universal app build (`--universal`) packs an x64 and an arm64 app and
// merges them, so the helper must run on both CPUs. Building only for the host
// arch put an arm64-only helper into the x64 half: the merge then refused the
// identical file, and an Intel Mac would have shipped a helper it cannot exec.
// Build both slices and lipo them into one universal binary (package.json lists
// it under mac.x64ArchFiles so the merge keeps it as is).
const work = mkdtempSync(path.join(tmpdir(), 'acb-speech-'))
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    rmSync(work, { recursive: true, force: true })
    process.exit(result.status ?? 1)
  }
}
const slices = ['arm64', 'x86_64'].map(arch => {
  const slice = path.join(work, `acb-speech-${arch}`)
  run('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${arch}-apple-macos14.0`, path.join(root, 'native/SpeechHelper.swift'), path.join(root, 'native/AudioLevel.swift'), path.join(root, 'native/InputRoute.swift'), '-o', slice, '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(root, 'native/Info.plist')])
  return slice
})
run('xcrun', ['lipo', '-create', ...slices, '-output', path.join(out, 'acb-speech')])
rmSync(work, { recursive: true, force: true })

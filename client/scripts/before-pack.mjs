// electron-builder `beforePack` hook (package.json build.beforePack): first the release build's
// plugin trust root check (scripts/check-trust-root.ts, plugin-trust.md "P2"), so even running
// electron-builder directly goes through it — a loud warning while the production root is missing,
// a refusal once RELEASE_REQUIRES_PRODUCTION_ROOT is on; then the universal bundled git
// (scripts/universal-git.mjs, deployment.md).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforePack as universalGit } from './universal-git.mjs'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function beforePack(context) {
  const check = spawnSync('npx', ['tsx', 'scripts/check-trust-root.ts'], { cwd: clientDir, stdio: 'inherit' })
  if (check.status !== 0) throw new Error('the release build must carry the production plugin trust root (scripts/check-trust-root.ts)')
  await universalGit(context)
}

export default beforePack

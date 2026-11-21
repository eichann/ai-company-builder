// electron-builder `beforePack` hook (package.json build.beforePack): first refuse a build without
// the production plugin trust root (scripts/check-trust-root.ts, plugin-trust.md "P2"), so even
// running electron-builder directly cannot pack an app carrying the development root; then the
// universal bundled git (scripts/universal-git.mjs, deployment.md).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforePack as universalGit } from './universal-git.mjs'

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function beforePack(context) {
  const check = spawnSync('npx', ['tsx', 'scripts/check-trust-root.ts'], { cwd: clientDir, stdio: 'inherit' })
  if (check.status !== 0) throw new Error('the production plugin trust root is missing (scripts/check-trust-root.ts)')
  await universalGit(context)
}

export default beforePack

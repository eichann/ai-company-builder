/**
 * Fill the staging kit's plugin shelf from production's plugin lock, through the server's own
 * collector (server/src/adapters/plugin-collect.ts) and the person's `gh` login.
 *
 *   node --import tsx ../staging/shelf.ts --dir <shelf> --lock <plugins.lock>   (run from server/)
 *
 * The lock is the one production collects with (`<repo> <id>@<version> <fingerprint v2>` per
 * line), which staging/bootstrap.mjs read from the private kit config into the kit's home. Each
 * repository is collected on its own, so one the person cannot read does not stop the others;
 * what was skipped is reported by package name only (never a repository or URL).
 *
 * Prints one JSON line (the last line of stdout) for kit.mjs:
 *   { packages: ["hubspot@0.3.0", …], added: [...], skipped: ["corporate-sales@0.4.0", …] }
 */
import { readFile, mkdir } from 'node:fs/promises'
import { collectPlugins, parsePluginsLock } from '../server/src/adapters/plugin-collect'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const dir = arg('--dir')
  const lock = arg('--lock')
  if (!dir || !lock) throw new Error('usage: shelf.ts --dir <shelf> --lock <plugins.lock>')
  await mkdir(dir, { recursive: true })
  const entries = parsePluginsLock(await readFile(lock, 'utf8'))
  const packages: string[] = []
  const added: string[] = []
  const skipped: string[] = []
  for (const repo of [...new Set(entries.map(e => e.repo))]) {
    const mine = entries.filter(e => e.repo === repo)
    try {
      const res = await collectPlugins({ entries: mine, dir })
      added.push(...res.added)
      packages.push(...mine.map(e => e.pkg))
    } catch {
      skipped.push(...mine.map(e => e.pkg))
    }
  }
  console.log(JSON.stringify({ packages, added, skipped }))
}

main().catch(() => {
  // The message could quote a lock line (a private repository's name): say only what failed.
  console.error('[shelf] the plugin lock could not be read')
  process.exitCode = 1
})

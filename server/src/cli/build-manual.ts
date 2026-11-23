/**
 * Builds the user manual's static site (`lib/manual-build.ts`), when the server
 * image is built (server/Dockerfile) or by hand for `pnpm dev:server`:
 *
 *   node --import tsx src/cli/build-manual.ts <manual source folder> <output folder>
 *   pnpm --filter @ai-company-builder/server manual:build   (../manual → ./manual-site)
 *
 * The server serves the output at /manual/ (MANUAL_DIR, default <cwd>/manual-site).
 * Exits 1 naming the page when a page does not render.
 */
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { buildManualSite } from '../lib/manual-build'

function main(argv: string[]): number {
  if (argv.length !== 2 || argv.some(a => a.startsWith('-'))) {
    console.error('Usage: build-manual.ts <manual source folder> <output folder>')
    return 2
  }
  const tokens = fileURLToPath(new URL('../../shared/design-tokens/', import.meta.url))
  try {
    const manifest = buildManualSite(resolve(argv[0]), resolve(argv[1]), tokens)
    console.log(`Built the manual: ${manifest.pages.length} page(s), ${manifest.files.length} file(s) → ${resolve(argv[1])}`)
    return 0
  } catch (err) {
    console.error(`Could not build the manual: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

process.exit(main(process.argv.slice(2)))

/**
 * Builds one of the static manual sites (`lib/manual-build.ts`), when the server image is
 * built (server/Dockerfile) or by hand for `pnpm dev:server`:
 *
 *   node --import tsx src/cli/build-manual.ts <site> <source folder> <output folder>
 *   pnpm --filter @ai-company-builder/server manual:build         (manual ../manual → ./manual-site)
 *   pnpm --filter @ai-company-builder/server manual-admin:build   (manual-admin ../manual-admin → ./manual-admin-site)
 *
 * <site> is `manual` (the members' manual, served at /manual/: MANUAL_DIR, default
 * <cwd>/manual-site) or `manual-admin` (the administrator guide, served at /manual-admin/:
 * MANUAL_ADMIN_DIR, default <cwd>/manual-admin-site). Exits 1 naming the page when a page
 * does not render.
 */
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { buildManualSite, isManualSiteName, MANUAL_SITES } from '../lib/manual-build'

function main(argv: string[]): number {
  if (argv.length !== 3 || argv.some(a => a.startsWith('-')) || !isManualSiteName(argv[0])) {
    console.error(`Usage: build-manual.ts <${Object.keys(MANUAL_SITES).join('|')}> <source folder> <output folder>`)
    return 2
  }
  const [site, source, out] = argv
  const tokens = fileURLToPath(new URL('../../shared/design-tokens/', import.meta.url))
  try {
    const manifest = buildManualSite(resolve(source), resolve(out), tokens, site)
    console.log(`Built ${site}: ${manifest.pages.length} page(s), ${manifest.files.length} file(s) → ${resolve(out)}`)
    return 0
  } catch (err) {
    console.error(`Could not build ${site}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

process.exit(main(process.argv.slice(2)))

/**
 * Put the plugin packages a lock names into a shelf folder (`PLUGINS_DIR`),
 * from their private repositories (adapters/plugin-collect.ts;
 * `.claude/rules/plugins.md` "Where packages come from").
 *
 *   node --import tsx src/cli/collect-plugins.ts --lock <plugins.lock> --dir <PLUGINS_DIR> [--prune]
 *   node --import tsx src/cli/collect-plugins.ts --fingerprint <package folder>
 *
 * Run it where `git` and `gh` (signed in with read access to the plugin
 * repositories) are available — the operator's machine or the server host,
 * not the api container. The lock is the operator's file, one package per line:
 *
 *   eichann/acb-connectors              hubspot@0.3.0          <fingerprint v2>
 *   eichann/acb-plugin-corporate-sales  corporate-sales@0.4.0  <fingerprint v2>
 *
 * Refuses, writing nothing, when a fingerprint differs from the lock or the
 * shelf already holds a listed version with other content. `--prune` also
 * removes `<id>@<version>` folders the lock does not list. `--fingerprint`
 * prints one folder's fingerprint v2 (for a new lock line). The api reads the
 * shelf at startup: restart it afterwards.
 */
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { CollectError, collectPlugins, packageFingerprintV2, parsePluginsLock } from '../adapters/plugin-collect'

const USAGE = 'Usage: collect-plugins.ts --lock <plugins.lock> --dir <PLUGINS_DIR> [--prune]\n       collect-plugins.ts --fingerprint <package folder>'

async function main(argv: string[]): Promise<number> {
  if (argv.length === 2 && argv[0] === '--fingerprint') {
    console.log(await packageFingerprintV2(resolve(argv[1])))
    return 0
  }
  let lock: string | undefined
  let dir: string | undefined
  let prune = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lock' && argv[i + 1]) lock = argv[++i]
    else if (argv[i] === '--dir' && argv[i + 1]) dir = argv[++i]
    else if (argv[i] === '--prune') prune = true
    else { console.error(USAGE); return 2 }
  }
  if (!lock || !dir) { console.error(USAGE); return 2 }
  const entries = parsePluginsLock(await readFile(resolve(lock), 'utf8'))
  const result = await collectPlugins({ entries, dir: resolve(dir), prune })
  for (const p of result.added) console.log(`added      ${p}`)
  for (const p of result.unchanged) console.log(`unchanged  ${p}`)
  for (const p of result.removed) console.log(`removed    ${p}`)
  if (result.added.length > 0 || result.removed.length > 0) console.log('Restart the api so it reads the shelf again.')
  return 0
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
  console.error(err instanceof CollectError ? `Refused: ${err.message}` : err)
  process.exitCode = 1
})

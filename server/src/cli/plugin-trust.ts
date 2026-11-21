/**
 * Plugin trust tools (adapters/plugin-trust-tools.ts; `.claude/rules/plugin-trust.md` "Owner
 * steps"). They hold no key: `--key` is a key file, or a public key file whose key the ssh agent
 * holds (Secretive, 1Password, the Actions job's agent; set SSH_AUTH_SOCK). Never run in the api.
 *
 *   node --import tsx src/cli/plugin-trust.ts check-key --key <key.pub> --role targets|freshness|root
 *   node --import tsx src/cli/plugin-trust.ts sign-root --root <root.json> --key <file> --key-id <id> --out <root/N.json>
 *        [--predecessor <root/N-1.json>]   (a rotation: a key of the version before may sign too)
 *   node --import tsx src/cli/plugin-trust.ts sign-targets --trust <trust repo main> --company <id> --server <PUBLIC_URL>
 *        --lock <plugins.lock> --packages <id@ver,…> [--floor <id>=<ver> …] --key <key.pub> --key-id <id> [--days 90] [--main main]
 *   node --import tsx src/cli/plugin-trust.ts sign-freshness --lists <trust repo main> --out <freshness checkout>
 *        --server <PUBLIC_URL> --key <file> --key-id <id> [--company <id> …] [--days 3]
 *   node --import tsx src/cli/plugin-trust.ts install --main <main checkout> --freshness <freshness checkout>
 *        --dir <PLUGINS_DIR> --server <PUBLIC_URL> [--allow-empty yes]
 *
 * sign-freshness and install exit 1 when a company was refused (the others are done): the timer alerts.
 *
 * Output is names, versions and refusal reasons only — never a key or a signature.
 */
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { parsePluginsLock } from '../adapters/plugin-collect'
import {
  TrustToolError, checkSigningKey, installTrust, reviewedPackage, signFreshness, signRoot, signTargets,
} from '../adapters/plugin-trust-tools'

function options(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]
    const value = argv[i + 1]
    if (!name?.startsWith('--') || value === undefined) throw new TrustToolError(`expected --name value pairs, got ${name ?? '(nothing)'}`)
    out.set(name.slice(2), [...(out.get(name.slice(2)) ?? []), value])
  }
  return out
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const o = options(rest)
  const one = (name: string): string => {
    const v = o.get(name)
    if (!v || v.length !== 1) throw new TrustToolError(`${command}: --${name} is required once`)
    return v[0]
  }
  const maybe = (name: string): string | undefined => o.get(name)?.[0]
  switch (command) {
    case 'check-key': {
      const r = await checkSigningKey({ publicKeyFile: resolve(one('key')), role: one('role') })
      console.log(`good: the agent signed and the app's verification accepts it (${r.type}).`)
      console.log(`root's "keys" entry: "<key id>": "${r.base64}"`)
      return 0
    }
    case 'sign-root': {
      const predecessor = maybe('predecessor')
      const r = await signRoot({ rootFile: resolve(one('root')), keyFile: resolve(one('key')), keyId: one('key-id'), out: resolve(one('out')), predecessor: predecessor ? resolve(predecessor) : undefined })
      console.log(`signed; ${r.signatures} signature(s); its own root threshold ${r.newThreshold ? 'met' : 'not yet met'}` +
        (r.predecessorThreshold === null ? '' : `; the predecessor's ${r.predecessorThreshold ? 'met' : 'not yet met'}`) +
        `; ${r.complete ? 'COMPLETE' : 'not complete yet'}`)
      return 0
    }
    case 'sign-targets': {
      const lock = parsePluginsLock(await readFile(resolve(one('lock')), 'utf8'))
      const wanted = one('packages').split(',').map(s => s.trim()).filter(Boolean)
      const packages = []
      for (const pkg of wanted) {
        const entry = lock.find(e => e.pkg === pkg)
        if (!entry) throw new TrustToolError(`${pkg} is not in the lock`)
        packages.push(await reviewedPackage(entry, { main: maybe('main') }))
        console.log(`reviewed   ${pkg}`)
      }
      const floors = Object.fromEntries((o.get('floor') ?? []).map(f => {
        const [id, version] = f.split('=')
        if (!id || !version) throw new TrustToolError('--floor is <id>=<version>')
        return [id, version]
      }))
      const r = await signTargets({
        trustDir: resolve(one('trust')), companyId: one('company'), server: one('server'), packages, floors,
        keyFile: resolve(one('key')), keyId: one('key-id'), days: maybe('days') ? Number(maybe('days')) : undefined,
      })
      console.log(`signed     company ${one('company')} list v${r.version}`)
      return 0
    }
    case 'sign-freshness': {
      const r = await signFreshness({
        listsDir: resolve(one('lists')), outDir: resolve(one('out')), server: one('server'), companies: o.get('company'),
        keyFile: resolve(one('key')), keyId: one('key-id'), days: maybe('days') ? Number(maybe('days')) : undefined,
      })
      for (const f of r.signed) console.log(`signed     company ${f.companyId} freshness v${f.version}`)
      for (const f of r.refused) console.error(`REFUSED    company ${f.companyId}: ${f.reason}`)
      return r.refused.length > 0 ? 1 : 0
    }
    case 'install': {
      const r = await installTrust({
        mainDir: resolve(one('main')), freshnessDir: resolve(one('freshness')), pluginsDir: resolve(one('dir')), server: one('server'),
        allowEmpty: maybe('allow-empty') === 'yes',
      })
      console.log(`installed  ${r.companies.length} company list(s) (${r.folder}); the api reads them at its next request`)
      for (const c of r.refused) console.error(`REFUSED    company ${c.companyId}${r.kept.includes(c.companyId) ? ' (kept its installed documents)' : ' (left without documents)'}: ${c.reason}`)
      return r.refused.length > 0 ? 1 : 0
    }
    default:
      console.error('Usage: plugin-trust.ts check-key | sign-root | sign-targets | sign-freshness | install … (see the header of src/cli/plugin-trust.ts)')
      return 2
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
  console.error(err instanceof TrustToolError ? `Refused: ${err.message}` : err)
  process.exitCode = 1
})

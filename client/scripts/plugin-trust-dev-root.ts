/**
 * Writes the root a **development** build carries (`electron/features/plugins/trust-roots/development.json`,
 * `.claude/rules/plugin-trust.md` "P2", design v3 decision 8):
 *
 *   cd client && npx tsx scripts/plugin-trust-dev-root.ts [--keep <folder>]
 *
 * - **Not the production root**: its keys are made fresh here (ed25519 × 3 for root, P-256 for
 *   targets, ed25519 for freshness, as v3.1 §1 assigns them) and are never the owner's. A release
 *   build refuses to be made with this root, or with any root sharing a key with it
 *   (`scripts/check-trust-root.ts`).
 * - Without `--keep`, the private keys are deleted at the end (nothing can sign for this root:
 *   enough while nothing is enforced). With `--keep <folder>` (outside the repository) they stay
 *   there, so a developer can sign test lists against a local server with `cli/plugin-trust.ts`.
 * - No private key is ever written into the repository.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../electron/features/plugins/trust-roots/development.json')
const keepAt = process.argv[2] === '--keep' && process.argv[3] ? resolve(process.argv[3]) : null
if (keepAt && keepAt.startsWith(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))) throw new Error('--keep must be outside the repository')
const work = keepAt ?? mkdtempSync(join(tmpdir(), 'acb-trust-dev-root-'))
mkdirSync(work, { recursive: true, mode: 0o700 })

const ED = ['dev-root-1', 'dev-root-2', 'dev-root-3', 'dev-fresh-1']
const P256 = ['dev-targets-1']
try {
  for (const n of ED) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${n} (ACB DEVELOPMENT KEY)`, '-f', join(work, n)])
  for (const n of P256) execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-C', `${n} (ACB DEVELOPMENT KEY)`, '-f', join(work, n)])
  const pub = (n: string) => readFileSync(join(work, `${n}.pub`), 'utf8').trim().split(/\s+/)[1]
  const doc = {
    _type: 'acb-root', version: 1, expires: '2036-01-01T00:00:00Z',
    keys: Object.fromEntries([...ED, ...P256].map(n => [n, pub(n)])),
    roles: {
      root: { keys: ['dev-root-1', 'dev-root-2', 'dev-root-3'], threshold: 2 },
      targets: { keys: ['dev-targets-1'], threshold: 1 },
      freshness: { keys: ['dev-fresh-1'], threshold: 1 },
    },
  }
  const text = JSON.stringify(doc, null, 1)
  const sign = (key: string) => execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(work, key), '-n', 'acb-root-v1'], { input: text }).toString()
  const envelope = { signed: text, signatures: [{ key_id: 'dev-root-1', sig: sign('dev-root-1') }, { key_id: 'dev-root-2', sig: sign('dev-root-2') }] }
  writeFileSync(OUT, `${JSON.stringify(envelope, null, 1)}\n`)
  console.log(`wrote ${OUT}${keepAt ? `; private keys kept in ${keepAt}` : ''}`)
} finally {
  if (!keepAt) rmSync(work, { recursive: true, force: true })
}

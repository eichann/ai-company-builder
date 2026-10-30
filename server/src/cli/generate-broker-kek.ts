/**
 * Writes a new key-encryption key (KEK) for the key broker: 32 random bytes as
 * base64, to a NEW file created owner-only (0600). Prints only the path and
 * the key's one-way id — never the key.
 *
 *   node --import tsx src/cli/generate-broker-kek.ts /etc/acb/broker-kek
 *
 * In the production image (read-only filesystem), mount the target folder:
 *
 *   sudo install -d -m 700 /etc/acb
 *   docker compose run --rm --no-deps -v /etc/acb:/kek api \
 *     node --import tsx src/cli/generate-broker-kek.ts /kek/broker-kek
 *
 * Refuses to overwrite an existing file (a lost KEK makes every stored key
 * unreadable) and a path inside DATA_DIR (database backups would contain it).
 * Then: copy the file's contents into the password manager (outside the
 * server), set BROKER_KEK_HOST_FILE in .env and restart the api service.
 */
import { closeSync, fsyncSync, openSync, writeSync } from 'fs'
import { randomBytes } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { kekFingerprint } from '../adapters/local-secret-cipher'

function main(argv: string[]): number {
  const target = argv[0]
  if (!target || argv.length !== 1 || target.startsWith('-')) {
    console.error('Usage: generate-broker-kek.ts <path of the new key file>')
    return 2
  }
  const path = resolve(target)
  const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : null
  if (dataDir) {
    const rel = relative(dataDir, path)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      console.error('Refusing: the path is inside DATA_DIR, so database backups would contain the key. Choose a path outside it.')
      return 1
    }
  }
  const kek = randomBytes(32)
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    console.error(code === 'EEXIST'
      ? 'Refusing: the file already exists. A key-encryption key is never overwritten (stored keys would become unreadable).'
      : `Cannot create the file (${code ?? 'error'}).`)
    return 1
  }
  try {
    writeSync(fd, `${kek.toString('base64')}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  console.log(`Wrote a new key-encryption key to ${path} (mode 600, id local:${kekFingerprint(kek)}).`)
  console.log('Next: store a copy of the file\'s contents in the password manager (not on this server), then mount it (BROKER_KEK_HOST_FILE) and restart the api service.')
  kek.fill(0)
  return 0
}

process.exitCode = main(process.argv.slice(2))

/**
 * The holding place's contents on disk (ports/holding.ts `HoldingBlobStore`;
 * private-folders.md "Holding: the member's upload"):
 * `<root>/<companyId>/<itemId>/<sha256>`, directories 0700, files 0600. A content streams into a
 * temporary file of its own (`.tmp-<random>`, one per request), hashed as it arrives (never held in
 * memory), and is renamed to its sha256 only when the service says so: a request that loses never
 * removes anything but its own temporary file. Same model as the private-folder archives
 * (lib/private-folders.ts): never served by any route.
 */
import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'fs/promises'
import { join } from 'path'
import type { HoldingBlobStore } from '../ports/holding'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const SHA = /^[0-9a-f]{64}$/
const TEMP = /^\.tmp-[0-9a-f]{16}$/

function part(value: string, shape: RegExp): string {
  // Ids come from the server's own rows; anything else would name another place on disk.
  if (!shape.test(value)) throw new Error('holding blob store: unexpected name')
  return value
}

export function diskHoldingBlobStore(root: string): HoldingBlobStore {
  const companyDir = (companyId: string) => join(root, part(companyId, ID))
  const itemDir = (companyId: string, itemId: string) => join(companyDir(companyId), part(itemId, ID))

  async function privateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
  }

  return {
    async receive(companyId, itemId, chunks, maxBytes) {
      await privateDir(root)
      await privateDir(companyDir(companyId))
      const dir = itemDir(companyId, itemId)
      await privateDir(dir)
      const temp = `.tmp-${randomBytes(8).toString('hex')}`
      const path = join(dir, temp)
      const file = await open(path, 'wx', 0o600)
      const hash = createHash('sha256')
      let bytes = 0
      let kept = false
      try {
        for await (const chunk of chunks) {
          bytes += chunk.byteLength
          if (bytes > maxBytes) return null
          hash.update(chunk)
          await file.write(chunk)
        }
        await file.chmod(0o600)
        kept = true
        return { temp, bytes, sha256: hash.digest('hex') }
      } finally {
        await file.close()
        if (!kept) await rm(path, { force: true })
      }
    },

    async commit(companyId, itemId, temp, sha256) {
      const dir = itemDir(companyId, itemId)
      await rename(join(dir, part(temp, TEMP)), join(dir, part(sha256, SHA)))
    },

    async discard(companyId, itemId, temp) {
      await rm(join(itemDir(companyId, itemId), part(temp, TEMP)), { force: true })
    },

    async has(companyId, itemId, sha256) {
      return existsSync(join(itemDir(companyId, itemId), part(sha256, SHA)))
    },

    async remove(companyId, itemId, sha256) {
      await rm(join(itemDir(companyId, itemId), part(sha256, SHA)), { force: true })
    },

    async entries(companyId, itemId) {
      const dir = itemDir(companyId, itemId)
      if (!existsSync(dir)) return []
      const out: Array<{ name: string; temp: boolean; mtimeMs: number }> = []
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (!e.isFile() || !(SHA.test(e.name) || TEMP.test(e.name))) continue
        out.push({ name: e.name, temp: TEMP.test(e.name), mtimeMs: (await stat(join(dir, e.name))).mtimeMs })
      }
      return out
    },

    async removeItem(companyId, itemId) {
      await rm(itemDir(companyId, itemId), { recursive: true, force: true })
    },

    async itemIds(companyId) {
      const dir = companyDir(companyId)
      if (!existsSync(dir)) return []
      return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && ID.test(e.name)).map(e => e.name)
    },

    companyDir,
  }
}

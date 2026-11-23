/**
 * The holding place's contents on disk (ports/holding.ts `HoldingBlobStore`;
 * private-folders.md "Holding: the member's upload"):
 * `<root>/<companyId>/<itemId>/<sha256>`, directories 0700, files 0600, each written to a
 * temporary name and renamed into place (a half-written file never has the final name). Same
 * model as the private-folder archives (lib/private-folders.ts): never served by any route.
 */
import { randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { chmod, mkdir, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import type { HoldingBlobStore } from '../ports/holding'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const SHA = /^[0-9a-f]{64}$/

function part(value: string, shape: RegExp): string {
  // Ids come from the server's own rows; anything else would name another place on disk.
  if (!shape.test(value)) throw new Error('holding blob store: unexpected id')
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
    async put(companyId, itemId, sha256, bytes) {
      await privateDir(root)
      await privateDir(companyDir(companyId))
      const dir = itemDir(companyId, itemId)
      await privateDir(dir)
      const target = join(dir, part(sha256, SHA))
      const temp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`)
      try {
        await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
        await chmod(temp, 0o600)
        await rename(temp, target)
      } catch (error) {
        await rm(temp, { force: true })
        throw error
      }
    },

    async remove(companyId, itemId, sha256) {
      await rm(join(itemDir(companyId, itemId), part(sha256, SHA)), { force: true })
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

// The sites whose login a browser window kept on disk (agent-browser.md "The app's window"):
// <userData>/browser-logins.json lists each persisted partition with whose and which site it is,
// so a login can be cleared later — after a restart, a sign-out, another account, the site removed,
// the sandbox no longer 「囲う」 — even when no window was opened this run.
import fs from 'node:fs'
import path from 'node:path'

export interface KeptLogin {
  partition: string
  userId: string
  companyId: string
  host: string
}

/** Only the app's own persisted browser partitions: an edited file never names another session to clear. */
export const KEPT_PARTITION_RE = /^persist:acb-browser-[0-9a-f]{32}$/

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300

function readEntries(file: string): KeptLogin[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { logins?: unknown }
    if (!Array.isArray(raw.logins)) return []
    return raw.logins.filter((e): e is KeptLogin => {
      const v = e as Partial<KeptLogin> | null
      return !!v && str(v.partition) && KEPT_PARTITION_RE.test(v.partition) && str(v.userId) && str(v.companyId) && str(v.host)
    })
  } catch {
    return []
  }
}

export interface KeptLogins {
  all(): KeptLogin[]
  record(login: KeptLogin): void
  remove(partition: string): void
}

export function createKeptLogins(file: () => string, log: Pick<Console, 'warn'> = console): KeptLogins {
  const write = (entries: KeptLogin[]) => {
    const target = file()
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ logins: entries }), { mode: 0o600 })
      fs.renameSync(tmp, target)
    } catch (error) {
      log.warn(`[browser] the list of kept logins could not be written (${error instanceof Error ? error.message : 'unknown'})`)
    }
  }
  return {
    all: () => readEntries(file()),
    record(login) {
      const entries = readEntries(file())
      if (entries.some(e => e.partition === login.partition)) return
      write([...entries, login])
    },
    remove(partition) {
      const entries = readEntries(file())
      const left = entries.filter(e => e.partition !== partition)
      if (left.length !== entries.length) write(left)
    },
  }
}

// The notice ids this PC already showed as a Mac notification (notifications.md "The app"):
// a restart in the morning must not greet the member with 「今日のあなたの番」 twice. Only
// ids (no text, no record); a missing or broken file reads as none (shown again at worst).

import fs from 'node:fs'

export function fileShownStore(file: string): { load(): string[]; save(ids: string[]): void } {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.length <= 100) : []
      } catch {
        return []
      }
    },
    save(ids) {
      fs.writeFileSync(file, JSON.stringify(ids), { mode: 0o600 })
    },
  }
}

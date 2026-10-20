import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateHandoff } from './contract'

/** Sandbox-only stage-A store. Production scope/range validation belongs to stage B. */
export class HandoffTrialStore {
  private generation = 0
  private active = new Set<AbortController>()
  private readonly memoFile: string
  private readonly backupFile: string
  private readonly deletedFile: string
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.memoFile = path.join(directory, 'handoff.json')
    this.backupFile = path.join(directory, 'handoff.backup.json')
    this.deletedFile = path.join(directory, 'deleted.json')
    // Finish an interrupted delete before allowing any read or new job.
    if (fs.existsSync(this.deletedFile)) this.removeMemos()
  }
  read(): string | undefined {
    if (fs.existsSync(this.deletedFile)) return undefined
    if (!fs.existsSync(this.memoFile)) return undefined
    return validateHandoff(JSON.parse(fs.readFileSync(this.memoFile, 'utf8')).markdown)
  }
  begin() {
    if (fs.existsSync(this.deletedFile)) throw new Error('削除済みの相談です')
    const generation = this.generation
    const controller = new AbortController()
    this.active.add(controller)
    let saved = false
    let closed = false
    return {
      signal: controller.signal,
      save: (markdown: string) => {
        if (closed || controller.signal.aborted || generation !== this.generation || fs.existsSync(this.deletedFile)) throw new Error('削除または中止された保存要求です')
        if (saved) throw new Error('同じジョブからの二重保存です')
        const body = JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), markdown: validateHandoff(markdown) })
        if (fs.existsSync(this.memoFile)) this.atomicWrite(this.backupFile, fs.readFileSync(this.memoFile, 'utf8'))
        this.atomicWrite(this.memoFile, body)
        saved = true
      },
      close: () => { closed = true; controller.abort(); this.active.delete(controller) },
    }
  }
  delete() {
    // Tombstone first: even a process crash cannot restore the backup on restart.
    this.atomicWrite(this.deletedFile, JSON.stringify({ deletedAt: new Date().toISOString() }))
    this.generation++
    for (const controller of this.active) controller.abort()
    this.active.clear()
    this.removeMemos()
  }
  private removeMemos() {
    for (const file of [this.memoFile, this.backupFile]) fs.rmSync(file, { force: true })
    for (const file of fs.readdirSync(this.directory)) if (/^\.handoff-.*\.tmp$/u.test(file)) fs.rmSync(path.join(this.directory, file), { force: true })
  }
  private atomicWrite(file: string, body: string) {
    const temporary = path.join(this.directory, `.handoff-${randomUUID()}.tmp`)
    try { fs.writeFileSync(temporary, body, { mode: 0o600 }); fs.renameSync(temporary, file) }
    finally { fs.rmSync(temporary, { force: true }) }
  }
}

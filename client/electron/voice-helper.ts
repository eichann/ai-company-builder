import { createInterface } from 'node:readline'
import { spawnVoiceProcess } from './voice-process'
import type { RecognitionEvent } from './voice-session'

type Helper = { child: ReturnType<typeof spawnVoiceProcess>; emit?: (event: RecognitionEvent) => void; finished: boolean; startedAt: number; ready: boolean }

// One idle executable, with no microphone or audio engine open. A fresh helper
// owns each recording so cancellation still terminates all capture immediately.
export class VoiceHelperPool {
  private idle?: Helper
  private helpers = new Set<Helper>()
  private disposed = false
  constructor(private readonly binary: string) {}

  warmUp() {
    if (this.disposed || this.idle) return
    this.idle = this.create()
  }
  private create(): Helper {
    const child = spawnVoiceProcess(this.binary, ['--standby'])
    const helper: Helper = { child, finished: false, startedAt: 0, ready: false }
    this.helpers.add(helper)
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const data = JSON.parse(line)
        if (data.type === 'standby-ready') { helper.ready = true; clearTimeout(timer); return }
        if (helper.finished || !helper.emit) return
        if (data.type === 'timing') {
          if (['locale-ready', 'permission-ready', 'device-ready', 'microphone-started', 'analyzer-ready', 'microphone-stopped'].includes(data.stage) && Number.isFinite(data.elapsedMs)) {
            console.info('[voice] startup timing', { stage: data.stage, helperMs: data.elapsedMs, totalMs: Date.now() - helper.startedAt })
          }
          return
        }
        if (data.type === 'result' || data.type === 'error') helper.finished = true
        helper.emit(data)
      } catch { /* Never log transcript data. */ }
    })
    child.stderr.resume()
    const fail = () => {
      if (!helper.finished) {
        helper.finished = true
        helper.emit?.({ type: 'error', message: '音声認識が終了しました。もう一度お試しください' })
      }
    }
    child.stdin.on('error', fail)
    child.on('error', fail)
    child.on('close', () => {
      clearTimeout(timer)
      this.helpers.delete(helper)
      if (this.idle === helper) this.idle = undefined
      fail()
      // No retry loop for an idle helper that fails to launch.
      if (helper.emit) this.warmUp()
    })
    return helper
  }
  start(emit: (event: RecognitionEvent) => void, deviceId?: string) {
    if (this.disposed) throw new Error('音声入力は終了しています')
    const helper = this.idle && !this.idle.finished ? this.idle : this.create()
    this.idle = undefined
    helper.emit = emit
    helper.startedAt = Date.now()
    console.info('[voice] helper start', { prestarted: helper.ready })
    helper.child.stdin.write(JSON.stringify({ command: 'start', deviceId }) + '\n')
    return {
      stop: () => helper.child.stdin.end(),
      cancel: () => { helper.finished = true; helper.child.kill('SIGKILL'); this.warmUp() },
    }
  }
  dispose() {
    this.disposed = true
    for (const helper of this.helpers) { helper.finished = true; helper.child.kill('SIGKILL') }
    this.idle = undefined
  }
}

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { spawnVoiceProcess } from './voice-process'
import type { VoiceCapabilities, VoiceDevice, VoiceDeviceList } from '../shared/voice-input'

// How long a one-shot helper run (`--probe`, `--devices`) may take before it is
// killed. It used to be 10 s, which a loaded Mac exceeds before the helper's
// own code even runs: on 2026-10-21 (load average 18-21 on 8 cores) the kernel
// held each exec of the helper for 6-10 s in its system-policy check
// (AppleSystemPolicy -> syspolicyd, `log-executable mig callout failed`), and
// one `--devices` run took 17 s end to end. The CoreAudio enumeration itself
// takes ~0.1 s. 30 s is roughly twice the worst observed run, and still bounds
// a helper that is genuinely stuck. The UI does not wait on these calls: it
// shows 「確認中…」 and offers 「もう一度確認」 if one fails or times out.
export const HELPER_TIMEOUT_MS = 30_000

// Helper error codes (SpeechHelper.swift) that will not change while the app
// runs. Everything else the helper reports (Speech service unavailable, the
// Japanese model not installed yet, …) depends on system services and assets
// that can change, so it is offered a retry.
const PERMANENT_HELPER_ERRORS = new Set([10 /* macOS < 26 */])

export const PROBE_MESSAGES = {
  missing: '音声認識ヘルパーがありません。Mac用ビルドが必要です',
  timeout: `日本語の音声認識の確認が${HELPER_TIMEOUT_MS / 1000}秒以内に終わりませんでした。Macの負荷が高いと時間がかかることがあります`,
  failed: '日本語の音声認識を確認できませんでした',
}

type Outcome = { kind: 'exited'; code: number | null; launchMs?: number } | { kind: 'timeout' } | { kind: 'spawn-error' }

function runHelper(binary: string, args: string[], timeoutMs: number, onMessage: (data: Record<string, unknown>) => void): Promise<Outcome> {
  return new Promise(resolve => {
    const startedAt = Date.now()
    let launchMs: number | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const totalMs = Date.now() - startedAt
      // Only slow runs are logged; this is how a field report says whether the
      // time went before main() (system policy) or inside the helper.
      if (totalMs > 3000 || outcome.kind !== 'exited') console.info('[voice] helper run', { mode: args[0], outcome: outcome.kind, totalMs, execToMainMs: launchMs })
      resolve(outcome)
    }
    const child = spawnVoiceProcess(binary, args)
    timer = setTimeout(() => { child.kill('SIGKILL'); finish({ kind: 'timeout' }) }, timeoutMs)
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const data = JSON.parse(line)
        if (data?.type === 'launch' && Number.isFinite(data.execToMainMs)) launchMs = data.execToMainMs
        else if (data && typeof data === 'object') onMessage(data)
      } catch { /* invalid protocol */ }
    })
    child.stderr.resume()
    child.on('error', () => finish({ kind: 'spawn-error' }))
    child.on('close', code => finish({ kind: 'exited', code, launchMs }))
  })
}

export async function probeCapabilities(binary: string, timeoutMs = HELPER_TIMEOUT_MS): Promise<VoiceCapabilities> {
  if (!existsSync(binary)) return { available: false, reason: PROBE_MESSAGES.missing }
  let available = false
  let error: { message: string; code?: number } | undefined
  const outcome = await runHelper(binary, ['--probe'], timeoutMs, data => {
    if (data.type === 'available') available = true
    if (data.type === 'error' && typeof data.message === 'string') error = { message: data.message, code: typeof data.code === 'number' ? data.code : undefined }
  })
  if (outcome.kind === 'timeout') return { available: false, reason: PROBE_MESSAGES.timeout, retryable: true }
  if (outcome.kind === 'exited' && available) return { available: true }
  if (error) return { available: false, reason: error.message, retryable: !PERMANENT_HELPER_ERRORS.has(error.code ?? -1) }
  return { available: false, reason: PROBE_MESSAGES.failed, retryable: true }
}

export async function listDevices(binary: string, timeoutMs = HELPER_TIMEOUT_MS): Promise<VoiceDeviceList> {
  let devices: VoiceDevice[] | undefined
  const outcome = await runHelper(binary, ['--devices'], timeoutMs, data => {
    if (data.type === 'devices' && Array.isArray(data.devices)) {
      devices = data.devices.filter((d: VoiceDevice) => typeof d?.id === 'string' && typeof d.name === 'string' && typeof d.isDefault === 'boolean')
    }
  })
  if (outcome.kind === 'timeout') return { ok: false, error: 'timeout' }
  if (outcome.kind === 'exited' && outcome.code === 0 && devices) return { ok: true, devices }
  return { ok: false, error: 'failed' }
}

import { createInterface } from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnAgentProcess } from './process'

// Only the JSON-RPC envelope is shared here; provider payloads stay in codex.ts.
export type RpcMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string; code?: number } }
export function findCodex(env: Record<string, string>): string {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
  for (const dir of dirs.filter(Boolean)) for (const name of names) {
    const file = path.join(dir, name)
    try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file } catch { /* next candidate */ }
  }
  throw new Error('Codex CLIが見つかりません。npm install -g @openai/codex でインストールしてください。')
}

export class CodexRpc {
  private child
  private lines
  private nextId = 1
  private closed = false
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  onMessage: (message: RpcMessage) => void = () => {}
  onFailure: (error: Error) => void = () => {}
  constructor(env: Record<string, string>) {
    const cleanEnv = { ...env }
    delete cleanEnv.OPENAI_API_KEY
    delete cleanEnv.CODEX_API_KEY
    this.child = spawnAgentProcess({ command: findCodex(env), args: ['app-server', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"'], env: cleanEnv })
    this.lines = createInterface({ input: this.child.stdout! })
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line) as RpcMessage
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error.message))
          else pending.resolve(message.result)
        } else this.onMessage(message)
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', () => this.fail(new Error('Codexとの接続が終了しました。')))
    this.child.stdin!.on('error', error => this.fail(error))
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'ai_company_builder', title: 'AI Company Builder', version: '0.0.1' } })
    this.send({ method: 'initialized' })
  }
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex接続は閉じています。'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex応答待ちがタイムアウトしました: ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.send({ id, method, params })
    })
  }
  send(message: RpcMessage) {
    if (!this.closed) this.child.stdin!.write(JSON.stringify(message) + '\n')
  }
  private fail(error: Error) {
    if (this.closed) return
    this.onFailure(error)
    this.close()
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex接続を終了しました。')) }
    this.pending.clear()
    this.lines.close()
    this.child.stdin!.end()
    const child = this.child
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }
}

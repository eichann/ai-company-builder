// The company folder's .env file (API keys for skills): report what is set and
// change it, and keep it out of sync whatever the .gitignore says. Values never
// go back to the renderer, only per name set / last four characters.
//   env:status, env:update

import fs from 'fs'
import path from 'path'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'
import { applyEnvChanges, envChangeRefusal, envStatus } from '../../../shared/env-file'

export interface EnvDeps {
  paths: PathGuard
}

export function registerEnvIpc(ipc: IpcRegistrar, { paths }: EnvDeps): void {
  ipc.handle('env:status', async (_, rootPath: string) => {
    try {
      const safePath = paths.validate(rootPath)
      const envPath = paths.validate(path.join(safePath, '.env'))
      if (!fs.existsSync(envPath)) return { success: true, vars: {} }
      return { success: true, vars: envStatus(await fs.promises.readFile(envPath, 'utf-8')) }
    } catch (error) {
      console.error('Failed to read .env:', error instanceof Error ? error.message : 'Unknown error')
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('env:update', async (_, rootPath: string, changes: Record<string, string | null>) => {
    try {
      const safePath = paths.validate(rootPath)
      const envPath = paths.validate(path.join(safePath, '.env'))
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { success: false, error: '変更内容を読み取れませんでした。' }
      const refusal = envChangeRefusal(changes)
      if (refusal) return { success: false, error: refusal }
      const current = fs.existsSync(envPath) ? await fs.promises.readFile(envPath, 'utf-8') : ''
      await fs.promises.writeFile(envPath, applyEnvChanges(current, changes), { encoding: 'utf-8', mode: 0o600 })

      // Self-heal: ensure secrets are never synced, even for older folders whose
      // .gitignore predates the seed (or had the entries removed). The .env file
      // holds API keys, so it must stay local-only.
      const gitignorePath = paths.validate(path.join(safePath, '.gitignore'))
      let gitignoreContent = ''
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8')
      }
      const existingLines = gitignoreContent.split('\n').map((line) => line.trim())
      const missing = ['.env', '.env.*', '!.env.example', '!.env.sample'].filter((p) => !existingLines.includes(p))
      if (missing.length > 0) {
        const prefix = gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n') ? '\n' : ''
        const header = existingLines.includes('# Secrets — never sync (local only)')
          ? ''
          : '# Secrets — never sync (local only)\n'
        fs.appendFileSync(gitignorePath, prefix + header + missing.join('\n') + '\n')
      }

      return { success: true }
    } catch (error) {
      console.error('Failed to write .env:', error instanceof Error ? error.message : 'Unknown error')
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}

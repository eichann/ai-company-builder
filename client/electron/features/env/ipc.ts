// The company folder's .env file (API keys for skills): read and write it,
// and keep it out of sync whatever the .gitignore says.
//   env:read, env:write

import fs from 'fs'
import path from 'path'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { PathGuard } from '../ports'

// .env file management
export interface EnvVars {
  [key: string]: string
}

export function parseEnvFile(content: string): EnvVars {
  const result: EnvVars = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim()
      let value = trimmed.slice(eqIndex + 1).trim()
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  }
  return result
}

export function stringifyEnvFile(vars: EnvVars): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(vars)) {
    // Quote values that contain spaces or special characters
    const needsQuotes = /[\s#=]/.test(value)
    const quotedValue = needsQuotes ? `"${value}"` : value
    lines.push(`${key}=${quotedValue}`)
  }
  return lines.join('\n') + '\n'
}

export interface EnvDeps {
  paths: PathGuard
}

export function registerEnvIpc(ipc: IpcRegistrar, { paths }: EnvDeps): void {
  ipc.handle('env:read', async (_, rootPath: string) => {
    try {
      const safePath = paths.validate(rootPath)
      const envPath = paths.validate(path.join(safePath, '.env'))
      if (!fs.existsSync(envPath)) {
        return { success: true, vars: {} }
      }
      const content = await fs.promises.readFile(envPath, 'utf-8')
      const vars = parseEnvFile(content)
      return { success: true, vars }
    } catch (error) {
      console.error('Failed to read .env:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipc.handle('env:write', async (_, rootPath: string, vars: EnvVars) => {
    try {
      const safePath = paths.validate(rootPath)
      const envPath = paths.validate(path.join(safePath, '.env'))
      const content = stringifyEnvFile(vars)
      await fs.promises.writeFile(envPath, content, 'utf-8')

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
      console.error('Failed to write .env:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}

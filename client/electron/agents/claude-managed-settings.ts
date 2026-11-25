// Claude Code's managed settings on this PC (MDM / Jamf, an administrator's file): they sit above the settings the app
// passes, so a `sandbox` there can switch the company sandbox off without an error (agent-sandbox.md "Not covered").
// The CLI reports nothing a turn could check, so this reads the sources the CLI reads and says whether any names
// `sandbox` (`managedSettingsTouchSandbox`, conservative). Server-managed settings (Claude's admin console) are not
// on disk here: a stated limit (agent-browser.md "Keeping a login on disk").
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { managedSettingsTouchSandbox } from '../../shared/agents/sandbox-policy'

/** Where Claude Code reads managed settings, per platform (the file, its drop-in folder, macOS managed preferences). */
export function claudeManagedSources(platform: string, user = os.userInfo().username): Array<{ kind: 'json' | 'plist'; path: string; folder?: boolean }> {
  if (platform === 'darwin') {
    return [
      { kind: 'json', path: '/Library/Application Support/ClaudeCode/managed-settings.json' },
      { kind: 'json', path: '/Library/Application Support/ClaudeCode/managed-settings.d', folder: true },
      { kind: 'plist', path: '/Library/Managed Preferences/com.anthropic.claudecode.plist' },
      { kind: 'plist', path: path.join('/Library/Managed Preferences', user, 'com.anthropic.claudecode.plist') },
    ]
  }
  if (platform === 'linux') {
    return [
      { kind: 'json', path: '/etc/claude-code/managed-settings.json' },
      { kind: 'json', path: '/etc/claude-code/managed-settings.d', folder: true },
    ]
  }
  return []
}

/** Does any managed source on this PC name `sandbox`? A source that exists but cannot be read counts. */
export function claudeManagedSandboxPresent(sources = claudeManagedSources(process.platform)): boolean {
  const read = (file: string): string | null => {
    try { return fs.readFileSync(file, 'latin1') } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : '\u0000unreadable sandbox'
    }
  }
  for (const source of sources) {
    const files: string[] = []
    if (source.folder) {
      try { for (const name of fs.readdirSync(source.path)) if (name.endsWith('.json')) files.push(path.join(source.path, name)) } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return true
      }
    } else files.push(source.path)
    for (const file of files) {
      const text = read(file)
      if (text !== null && managedSettingsTouchSandbox({ kind: source.kind, text })) return true
    }
  }
  return false
}

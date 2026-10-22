import fs from 'node:fs'
import path from 'node:path'
import { composeVoicePrompt, DEFAULT_VOICE_INSTRUCTIONS, validateVoiceInstructions, VOICE_INSTRUCTIONS_MAX_LENGTH, type VoicePromptSettings } from '../shared/voice-prompt'

// The member's 「整え方の指示」 for voice polishing, kept in this PC's userData
// (never in the company folder, so it is not synced). Only an edited value is
// stored: a member who never edits — or resets — follows future changes to
// the default.
interface StoredVoicePrompt { version: 1; instructions: string }

export function createVoicePromptStore(file: string) {
  const read = (): string | null => {
    let raw: string
    try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredVoicePrompt>
      if (typeof parsed?.instructions !== 'string' || parsed.instructions.length > VOICE_INSTRUCTIONS_MAX_LENGTH || parsed.instructions.includes('\0')) throw new Error('invalid')
      return parsed.instructions
    } catch {
      console.warn('[voice] ignoring an unreadable voice prompt setting; using the default')
      return null
    }
  }
  const remove = () => { try { fs.rmSync(file, { force: true }) } catch { /* nothing to remove */ } }
  return {
    get(): VoicePromptSettings {
      const stored = read()
      return stored === null ? { instructions: DEFAULT_VOICE_INSTRUCTIONS, isDefault: true } : { instructions: stored, isDefault: false }
    },
    /** Saves edited instructions (validated: string, at most 8,000 characters). Returns what is now in effect. */
    set(value: unknown): VoicePromptSettings {
      const instructions = validateVoiceInstructions(value)
      if (instructions === DEFAULT_VOICE_INSTRUCTIONS) { remove(); return this.get() }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, instructions } satisfies StoredVoicePrompt), 'utf8')
      fs.renameSync(tmp, file)
      return this.get()
    },
    reset(): VoicePromptSettings {
      remove()
      return this.get()
    },
    /** The full system prompt for the next voice input. */
    systemPrompt(): string {
      return composeVoicePrompt(this.get().instructions)
    },
  }
}

export type VoicePromptStore = ReturnType<typeof createVoicePromptStore>

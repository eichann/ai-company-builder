// Preview of Settings → 音声入力 → 整え方の指示 with the preload API mocked.
// Open /tests/voice-prompt-ui.html?theme=light|dark&state=default|edited|empty
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { Card, SectionHeader } from '../src/shared/ui/primitives'
import { VoiceShortcutSettings } from '../src/features/voice/components/VoiceShortcutSettings'
import { VoicePromptSettings } from '../src/features/voice/components/VoicePromptSettings'
import { DEFAULT_VOICE_INSTRUCTIONS, validateVoiceInstructions } from '../shared/voice-prompt'

const params = new URLSearchParams(location.search)
if (params.get('theme') === 'dark') document.documentElement.classList.add('dark')
const state = params.get('state') ?? 'default'
let saved: string | null = state === 'edited' ? '「えー」「あの」は消してください。\n箇条書きにはせず、文章のまま整えてください。' : state === 'empty' ? '' : null
const current = () => ({ instructions: saved ?? DEFAULT_VOICE_INSTRUCTIONS, isDefault: saved === null })
Object.assign(window, {
  electronAPI: {
    voiceInput: {
      getPrompt: async () => current(),
      setPrompt: async (value: string) => { validateVoiceInstructions(value); saved = value === DEFAULT_VOICE_INSTRUCTIONS ? null : value; return current() },
      resetPrompt: async () => { saved = null; return current() },
    },
  },
})

export function Preview() {
  return (
    <main className="min-h-screen bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <div className="bg-amber-50 px-4 py-2 text-xs text-amber-900">表示確認用の人工データです。</div>
      <div className="mx-auto max-w-[780px] space-y-5 px-8 pb-8 pt-7">
        <SectionHeader title="音声入力" description="相談画面で使う音声入力の設定です。" />
        <Card className="p-5"><VoiceShortcutSettings /></Card>
        <Card className="p-5"><VoicePromptSettings /></Card>
      </div>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)

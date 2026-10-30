/**
 * Words and draft helpers for the 「AI の囲い」 page (the company's AI sandbox
 * setting). Validation is shared/core/agent-sandbox.ts, the server's own copy.
 */
import {
  normalizeDeniedReadPath,
  normalizeSandboxDomain,
  type AgentSandboxMode,
  type AgentSandboxSettings,
  type AgentSandboxUnavailable,
} from '../../../shared/core/agent-sandbox'

export const SANDBOX_MODES: AgentSandboxMode[] = ['off', 'observe', 'enforce']

export const SANDBOX_MODE_LABELS: Record<AgentSandboxMode, string> = {
  off: '使わない',
  observe: '記録だけ',
  enforce: '囲う',
}

export const SANDBOX_MODE_HELP: Record<AgentSandboxMode, string> = {
  off: 'これまでどおり動きます。',
  observe:
    '何も止めません。「囲う」にしたら止まる操作（一覧にない宛先への接続、秘密の置き場所の読み取り）を「AI の操作の記録」に残します。一覧を整えるために、まずこちらで様子を見てください。',
  enforce:
    'AI が実行するコマンドは、下の一覧の宛先にしか接続できず、秘密の置き場所（SSH・クラウドの鍵、キーチェーン、ブラウザのデータ、パスワード管理アプリなど）を読めなくなります。',
}

export const UNAVAILABLE_LABELS: Record<AgentSandboxUnavailable, string> = {
  'record-only': '記録だけで続ける',
  stop: 'AI を使えなくする',
}

export const UNAVAILABLE_HELP: Record<AgentSandboxUnavailable, string> = {
  'record-only': '囲いを開始できない PC（Windows、古い Claude Code / Codex など）では「記録だけ」として動きます。最初はこちらをおすすめします。',
  stop: '囲いを開始できない PC では、AI への相談を始められません。全員の PC で囲いが動くことを確かめてから選んでください。',
}

/** Text area lines → entries (blank lines and `#` comments dropped). */
export function linesOf(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

/** The lines that would be refused, for the inline error. */
export function invalidDomains(text: string): string[] {
  return linesOf(text).filter((l) => !normalizeSandboxDomain(l))
}

export function invalidPaths(text: string): string[] {
  return linesOf(text).filter((l) => !normalizeDeniedReadPath(l))
}

/** What the draft would save (already normalized and de-duplicated). */
export function draftSettings(d: {
  mode: AgentSandboxMode
  onUnavailable: AgentSandboxUnavailable
  domains: string
  paths: string
}): AgentSandboxSettings {
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))]
  return {
    mode: d.mode,
    onUnavailable: d.onUnavailable,
    allowedDomains: unique(linesOf(d.domains).map(normalizeSandboxDomain)),
    deniedReadPaths: unique(linesOf(d.paths).map(normalizeDeniedReadPath)),
  }
}

/** 「動作: 使わない → 記録だけ」 lines for what changes. */
export function sandboxChangeLines(before: AgentSandboxSettings, after: AgentSandboxSettings): string[] {
  const lines: string[] = []
  if (before.mode !== after.mode) lines.push(`動作: ${SANDBOX_MODE_LABELS[before.mode]} → ${SANDBOX_MODE_LABELS[after.mode]}`)
  if (before.onUnavailable !== after.onUnavailable) {
    lines.push(`開始できない PC: ${UNAVAILABLE_LABELS[before.onUnavailable]} → ${UNAVAILABLE_LABELS[after.onUnavailable]}`)
  }
  const diff = (label: string, a: string[], b: string[]) => {
    const added = b.filter((x) => !a.includes(x))
    const removed = a.filter((x) => !b.includes(x))
    if (added.length) lines.push(`${label}に追加: ${added.join('、')}`)
    if (removed.length) lines.push(`${label}から削除: ${removed.join('、')}`)
  }
  diff('接続してよい宛先', before.allowedDomains, after.allowedDomains)
  diff('読ませない場所', before.deniedReadPaths, after.deniedReadPaths)
  return lines
}

/**
 * The version floor for an agent's CLI (registry `minCliVersion`): reading
 * `<cli> --version` and the member-facing notice when it is too old (pure).
 */

export type CliVersion = readonly [number, number, number]

/** The first `x.y.z` in a `--version` output (`codex-cli 0.153.4`, `2.1.314 (Claude Code)`). */
export function parseCliVersion(output: string): CliVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function compareCliVersions(a: CliVersion, b: CliVersion): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function formatCliVersion(version: CliVersion): string {
  return version.join('.')
}

export type CliVersionCheck =
  | { ok: true; version?: CliVersion }
  | { ok: false; version?: CliVersion; message: string }

/**
 * Is this `--version` output at or above the floor? An output without a
 * version is refused too: the app cannot tell what it would be starting.
 */
export function checkCodexVersion(output: string, floor: string): CliVersionCheck {
  const minimum = parseCliVersion(floor)
  if (!minimum) return { ok: true }
  const version = parseCliVersion(output)
  if (!version) return { ok: false, message: codexVersionMessage(undefined, floor) }
  if (compareCliVersions(version, minimum) < 0) return { ok: false, version, message: codexVersionMessage(formatCliVersion(version), floor) }
  return { ok: true, version }
}

/** For the chat and the settings card; plain Japanese, one action. */
export function codexVersionMessage(found: string | undefined, floor: string): string {
  const what = found ? `お使いの Codex（${found}）は古いため` : 'お使いの Codex の版を確認できなかったため'
  return `${what}、このアプリでは使えません。ターミナルで npm install -g @openai/codex@latest を実行して Codex を更新してから、もう一度お試しください（${floor} 以上が必要です）。`
}

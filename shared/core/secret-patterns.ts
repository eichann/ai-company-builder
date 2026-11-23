/**
 * Secrets nobody may share (the push checker's [SECRET_DETECTED], `.claude/rules/push-check.md`
 * "Secrets"): one list for the push checker (`server/src/lib/push-check/rules.ts`, which applies
 * it to git's raw bytes — the patterns are ASCII, so bytewise and text matching agree), the
 * server's Skill shelf (a file of a Skill, an instruction text or a rule file) and the holding
 * place of private folders (private-folders.md "Holding: the member's upload"), which never keeps
 * a secret's content.
 *
 * Pure: imports nothing.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key', re: /-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/ },
  { name: 'GitHub Personal Access Token', re: /ghp_[0-9a-zA-Z]{36}/ },
  { name: 'GitHub OAuth Token', re: /gho_[0-9a-zA-Z]{36}/ },
  { name: 'GitHub Fine-grained PAT', re: /github_pat_[0-9a-zA-Z_]{22,}/ },
  { name: 'OpenAI/Anthropic API Key', re: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'Slack Token', re: /xox[bpsa]-[0-9a-zA-Z-]{10,}/ },
  { name: 'Google API Key', re: /AIza[0-9A-Za-z_-]{35}/ },
]

/** The first secret pattern found anywhere in `text` (its name), or null. */
export function secretIn(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.name
  return null
}

/**
 * A settings file that holds secrets by its name: `.env` and `.env.<anything>` (A–Z folded),
 * except the shared templates `.env.example` / `.env.sample` — the same names the company
 * folder's `.gitignore` keeps local (client/electron/sync/git-sync.ts). `path` is '/'-separated;
 * only its last segment counts.
 */
export function isSecretFileName(path: string): boolean {
  const name = (path.split('/').pop() ?? '').replace(/[A-Z]+/g, m => m.toLowerCase())
  if (name === '.env.example' || name === '.env.sample') return false
  return name === '.env' || name.startsWith('.env.')
}

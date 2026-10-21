/**
 * Git server boundary: everything the API does *as a git server* for the
 * company bare repositories goes through here.
 *
 *   initBareRepo / configureBareRepo / configureAllBareRepos
 *                       create and configure repositories (force-push and
 *                       branch-deletion protection, HTTP push, partial
 *                       clone — ./repo-config.ts — and the hook)
 *   installPreReceiveHook / renderPreReceiveHook   (./hook.ts)
 *                       the hook, a thin caller of lib/push-check
 *   preparePushCheck    the environment one git-http receive-pack request
 *                       hands the hook: pusher + permission snapshot
 *   internalGitEnv      the marker for the server's own pushes
 *
 * Who is pushing reaches the checker only through environment variables set
 * here (and by git-http, from the authenticated session):
 *   ACB_PUSHER_ROLE / ACB_PUSHER_ID / ACB_PUSHER_EMAIL / ACB_NODE  (as before)
 *   ACB_PUSH_POLICY    path of the request's permission snapshot (0600 file
 *                      in a private temp dir, removed when the request ends)
 *   ACB_INTERNAL_PUSH  "1" on the server's own git invocations only
 * A client cannot set any of them: git-http passes request headers to the CGI
 * only as CONTENT_TYPE / HTTP_CONTENT_ENCODING, and strips ACB_* it would
 * otherwise inherit (scrubPushCheckEnv).
 */
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { installPreReceiveHook } from './hook'
import { BARE_REPO_CONFIG } from './repo-config'
import { PUSH_POLICY_VERSION, type PushPolicy } from '../push-check/policy'
import type { ScopeWithRules } from '../permissions'

export { installPreReceiveHook, renderPreReceiveHook, PUSH_CHECK_ENTRY, HOOK_TEMPLATE_PATH } from './hook'
export { BARE_REPO_CONFIG } from './repo-config'
export type { PushPolicy } from '../push-check/policy'

/** Create a bare repository (branch pinned to main: the client hardcodes origin/main) and configure it. */
export function initBareRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init', '--bare', '--initial-branch=main', repoPath], { stdio: 'pipe' })
  configureBareRepo(repoPath)
}

/**
 * Standard configuration for a company bare repository. Idempotent — applied
 * on creation and again at startup, so config and hook upgrades reach
 * repositories created by older server versions.
 */
export function configureBareRepo(repoPath: string): void {
  // HTTP push, force-push / branch-deletion protection, partial clone —
  // ./repo-config.ts says why each one is set.
  for (const [key, value] of BARE_REPO_CONFIG) {
    execFileSync('git', ['-C', repoPath, 'config', key, value], { stdio: 'pipe' })
  }
  // Pre-receive hook → lib/push-check (secrets, gitlinks, Windows paths,
  // owner/admin-only agent config, .personal, write permission)
  installPreReceiveHook(repoPath)
}

/** Bring every repository under `reposDir` up to the current standard configuration. */
export function configureAllBareRepos(reposDir: string): { total: number; failed: number } {
  let total = 0
  let failed = 0
  if (!existsSync(reposDir)) return { total, failed }
  for (const name of readdirSync(reposDir)) {
    if (!name.endsWith('.git')) continue
    total++
    try {
      configureBareRepo(join(reposDir, name))
    } catch (error) {
      failed++
      console.error(`Failed to configure repository ${name}:`, error)
    }
  }
  return { total, failed }
}

/** Variables only the server may set for the hook. */
const SERVER_ONLY_VARS = ['ACB_PUSH_POLICY', 'ACB_INTERNAL_PUSH'] as const

/**
 * Environment for the server's own git invocations that may push (department
 * folder create/rename/delete, company creation). The checker skips the
 * write-permission check for them; every content rule still applies.
 */
export function internalGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ACB_INTERNAL_PUSH: '1' }
}

/** Remove the server-only hook variables from an inherited environment (git-http's CGI env). */
export function scrubPushCheckEnv(env: Record<string, string | undefined>): void {
  for (const key of SERVER_ONLY_VARS) delete env[key]
}

export interface PushCheckRequest {
  companyId: string
  /** null when the pusher could not be resolved (the checker then fails closed unless writing is open). */
  pusher: { id: string; role: string | null } | null
  scopes: ScopeWithRules[]
}

export interface PreparedPushCheck {
  /** Variables to add to the receive-pack CGI environment. */
  env: Record<string, string>
  /** Remove the snapshot (call when the request has finished). Idempotent. */
  cleanup: () => void
}

/**
 * Write the request's permission snapshot and return the hook environment
 * that points at it. If the snapshot cannot be written, ACB_PUSH_POLICY is
 * still set (empty) so the checker rejects the push instead of skipping the
 * write check.
 */
export function preparePushCheck(req: PushCheckRequest): PreparedPushCheck {
  const policy: PushPolicy = {
    version: PUSH_POLICY_VERSION,
    companyId: req.companyId,
    pusher: req.pusher,
    scopes: req.scopes,
  }
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'acb-push-policy-'))
    chmodSync(dir, 0o700)
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify(policy), { mode: 0o600 })
    const created = dir
    let done = false
    return {
      env: { ACB_PUSH_POLICY: file },
      cleanup: () => {
        if (done) return
        done = true
        rmSync(created, { recursive: true, force: true })
      },
    }
  } catch (err) {
    console.error('[git-server] cannot write the push policy snapshot:', err)
    if (dir) rmSync(dir, { recursive: true, force: true })
    return { env: { ACB_PUSH_POLICY: '' }, cleanup: () => {} }
  }
}

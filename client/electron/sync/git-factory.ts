// The one place that decides how the desktop app invokes git. main.ts's
// createGit and the sync test harness both build their SimpleGit through
// here, so the harness exercises exactly the configuration members run with —
// every option below is a guard in .claude/rules/sync-guards.md.

import fs from 'node:fs'
import path from 'node:path'
import simpleGit, { type SimpleGit } from 'simple-git'

export interface GitFactoryOptions {
  /** Git binary (bundled dugite git, or the system git fallback). */
  binary: string
  /** GIT_ASKPASS helper that prints $GIT_TOKEN. */
  askPassPath: string
  /** Session token handed to the askpass helper. */
  token: string
  /**
   * Directory the app owns for its git setup (main.ts: `<userData>/git`).
   * Holds `hooks/` (core.hooksPath) and `templates/` (GIT_TEMPLATE_DIR),
   * both created empty — see appGitDirs.
   */
  appGitDir: string
  /**
   * Applied after the guard variables (dugite's GIT_EXEC_PATH in the app;
   * the harness adds its identity and the pusher role here). Cannot
   * override GIT_TEMPLATE_DIR, which is always the app's empty template dir.
   */
  envOverrides?: Record<string, string>
  /** Inherited environment. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv
  /** Additional `-c` settings, appended after the guarded ones. */
  extraConfig?: string[]
}

const preparedDirs = new Map<string, { hooksDir: string; templateDir: string }>()

/**
 * The app-owned hooks and template directories under `appGitDir`, created on
 * first use. Both start empty:
 *
 *  - `hooks/` is core.hooksPath for every git the app runs, so neither the
 *    repository's own `.git/hooks/` nor a `core.hooksPath` from the member's
 *    global config runs. On a developer machine a global `init.templateDir`
 *    (git-secrets) had installed a pre-commit hook into the repository; in a
 *    partial clone that hook fetched thousands of missing blobs one by one
 *    and a commit hung for 10+ minutes (2026-10-22) — the watchdog would
 *    have killed sync. A real directory instead of `/dev/null`, which is not
 *    a path on Windows. The app owns it, so hooks the app itself needs later
 *    (e.g. git-lfs's pre-push) can be installed here deliberately.
 *  - `templates/` is GIT_TEMPLATE_DIR, so `git init` / clone copy nothing —
 *    not the member's `init.templateDir` (that git-secrets hook), not the
 *    sample hooks of the bundled git.
 */
export function appGitDirs(appGitDir: string): { hooksDir: string; templateDir: string } {
  const base = path.resolve(appGitDir)
  let dirs = preparedDirs.get(base)
  if (!dirs) {
    // Forward slashes: git accepts them on every platform.
    const toGitPath = (p: string) => p.split(path.sep).join('/')
    const hooksDir = path.join(base, 'hooks')
    const templateDir = path.join(base, 'templates')
    fs.mkdirSync(hooksDir, { recursive: true })
    fs.mkdirSync(templateDir, { recursive: true })
    dirs = { hooksDir: toGitPath(hooksDir), templateDir: toGitPath(templateDir) }
    preparedDirs.set(base, dirs)
  }
  return dirs
}

/** Build a SimpleGit for `repoPath` with the app's git configuration. */
export function createConfiguredGit(repoPath: string, options: GitFactoryOptions): SimpleGit {
  const { hooksDir, templateDir } = appGitDirs(options.appGitDir)
  return simpleGit(repoPath, {
    binary: options.binary,
    unsafe: { allowUnsafeCustomBinary: true },
    // Kill any git process that produces no output for 5 minutes. Without
    // this, a git process waiting on input that will never come (there is no
    // terminal) hangs `await` forever and freezes sync with it. Network
    // transfers stay alive because sync passes --progress to fetch/pull/push.
    timeout: { block: 5 * 60 * 1000 },
    config: configEntries(options, hooksDir),
    // Force fork+exec instead of posix_spawn to avoid EBADF in Electron
    // (Electron's main process inherits Chromium FDs that lack FD_CLOEXEC)
    ...(process.getuid ? { spawnOptions: { uid: process.getuid() } } : {}),
  })
    .env(configuredEnv(options, templateDir))
}

/**
 * The same configuration for a git process the caller spawns itself — to
 * stream its output and stop it early (the content search in
 * ../git-search.ts): the binary, the `-c` arguments that go before the
 * command, and the environment.
 */
export function configuredGitCommand(options: GitFactoryOptions): { binary: string; configArgs: string[]; env: NodeJS.ProcessEnv } {
  const { hooksDir, templateDir } = appGitDirs(options.appGitDir)
  return {
    binary: options.binary,
    configArgs: configEntries(options, hooksDir).flatMap(c => ['-c', c]),
    env: configuredEnv(options, templateDir),
  }
}

/** The `-c` settings every git the app runs carries. */
function configEntries(options: GitFactoryOptions, hooksDir: string): string[] {
  return [
    // The member's own hooks never run (appGitDirs): only the app-owned,
    // empty hooks directory is consulted.
    `core.hooksPath=${hooksDir}`,
    'credential.helper=',
    'core.quotePath=false',
    // Old clients (e.g. Apple Git 2.39, still reachable via the system git
    // fallback) have a broken chunked HTTP push — it fails even against
    // github.com over HTTP/1.1. Buffer pushes up to 500MB so git never
    // switches to chunked transfer above the 1MiB default, regardless of
    // which binary was resolved.
    'http.postBuffer=524288000',
    // A pull that fast-forwards prints a diffstat, which reads the content
    // of every file the teammates changed. In a partial clone (first setup
    // with departments picked) those are blobs the member never downloaded:
    // every sync silently fetched the teammates' changes in departments the
    // member did not pick. Nothing reads the diffstat.
    'merge.stat=false',
    ...(options.extraConfig ?? []),
  ]
}

/** The environment every git the app runs gets. */
function configuredEnv(options: GitFactoryOptions, templateDir: string): NodeJS.ProcessEnv {
  return {
    ...(options.baseEnv ?? process.env),
    GIT_ASKPASS: options.askPassPath,
    GIT_TOKEN: options.token,
    GIT_TERMINAL_PROMPT: '0',
    // Continuing a rebase after a conflicted pick opens an editor to
    // confirm the commit message. In a GUI-launched app that editor is vi
    // with no terminal attached — it blocks forever (the 2026-07-29 sync
    // freeze). `true` accepts the recorded message non-interactively; git
    // always invokes editors via its own sh, so this works on Windows too.
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    ...options.envOverrides,
    // After the overrides: init / clone copy no templates (appGitDirs).
    // The variable outranks the member's init.templateDir.
    GIT_TEMPLATE_DIR: templateDir,
  }
}

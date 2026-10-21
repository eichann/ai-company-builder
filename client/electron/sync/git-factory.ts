// The one place that decides how the desktop app invokes git. main.ts's
// createGit and the sync test harness both build their SimpleGit through
// here, so the harness exercises exactly the configuration members run with —
// every option below is a row of the "Non-Negotiable Guards" table in
// CLAUDE.md.

import simpleGit, { type SimpleGit } from 'simple-git'

export interface GitFactoryOptions {
  /** Git binary (bundled dugite git, or the system git fallback). */
  binary: string
  /** GIT_ASKPASS helper that prints $GIT_TOKEN. */
  askPassPath: string
  /** Session token handed to the askpass helper. */
  token: string
  /**
   * Applied last, after the guard variables (dugite's GIT_EXEC_PATH /
   * GIT_TEMPLATE_DIR in the app; the harness adds its identity and the
   * pusher role here).
   */
  envOverrides?: Record<string, string>
  /** Inherited environment. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv
  /** Additional `-c` settings, appended after the guarded ones. */
  extraConfig?: string[]
}

/** Build a SimpleGit for `repoPath` with the app's git configuration. */
export function createConfiguredGit(repoPath: string, options: GitFactoryOptions): SimpleGit {
  return simpleGit(repoPath, {
    binary: options.binary,
    unsafe: { allowUnsafeCustomBinary: true },
    // Kill any git process that produces no output for 5 minutes. Without
    // this, a git process waiting on input that will never come (there is no
    // terminal) hangs `await` forever and freezes sync with it. Network
    // transfers stay alive because sync passes --progress to fetch/pull/push.
    timeout: { block: 5 * 60 * 1000 },
    config: [
      'core.hooksPath=/dev/null',
      'credential.helper=',
      'core.quotePath=false',
      // Old clients (e.g. Apple Git 2.39, still reachable via the system git
      // fallback) have a broken chunked HTTP push — it fails even against
      // github.com over HTTP/1.1. Buffer pushes up to 500MB so git never
      // switches to chunked transfer above the 1MiB default, regardless of
      // which binary was resolved.
      'http.postBuffer=524288000',
      ...(options.extraConfig ?? []),
    ],
    // Force fork+exec instead of posix_spawn to avoid EBADF in Electron
    // (Electron's main process inherits Chromium FDs that lack FD_CLOEXEC)
    ...(process.getuid ? { spawnOptions: { uid: process.getuid() } } : {}),
  })
    .env({
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
    })
}

#!/usr/bin/env node
// The staging kit's one entry point (staging/README.md). Keeps the kit's own checkout
// (~/acb-staging-kit/app) at the version to test, then runs that checkout's staging/kit.mjs.
// The person's own working copy is never touched, and the kit (its scripts too) is always the
// version it follows:
//   - with the private setting (ACB_KIT_PRIVATE, see staging/lib/kit.mjs privateSpecFrom):
//     the commit production runs and production's plugin lock, from the private kit config
//     (moved by staging/mark-production.mjs after each production deploy);
//   - without it: the public repository's latest main, no private plugins.
//
//   node staging/bootstrap.mjs <setup|up|down|reset|app|status|remove> [options]
//   (pnpm staging:<command> from any checkout; ~/acb-staging-kit/acb-staging <command> after setup)
//
// setup / up / app / reset look first. Moved → stop the kit's containers, back up its
// databases, check the new commit out; kit.mjs then rebuilds what changed (images, app) and
// starts with the kept data. Offline / no access → start the version already there, and say so.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger, decideUpdate, kitPaths, settingsFrom, shortJapaneseDate, writePrivateFile } from './lib/kit.mjs'
import { loadPrivateConfig } from './lib/private.mjs'

const FOLLOW = new Set(['setup', 'up', 'app', 'reset'])

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: opts.timeout ?? 300_000,
  }).trim()
}

function localHead(app) {
  if (!fs.existsSync(path.join(app, '.git'))) return null
  try { return git(['-C', app, 'rev-parse', 'HEAD']) } catch { return null }
}

/**
 * The commit to run. private: 'ok' (production's commit and lock), 'unreadable' (the setting is
 * there but the config could not be read: offline or no access), 'none' (no setting: public main).
 */
export function resolveTarget(s) {
  if (s.private) {
    const cfg = loadPrivateConfig(s.private)
    if (!cfg.ok) return { private: 'unreadable', error: '本番の設定を読めませんでした（ネットワークか gh auth login を確かめてください）' }
    if (!cfg.production) return { private: 'unreadable', error: '本番の版がまだ設定に書かれていません' }
    return { private: 'ok', sha: cfg.production, lockText: cfg.lockText }
  }
  try {
    const sha = git(['ls-remote', '--', s.remote, `refs/heads/${s.branch}`], { timeout: 30_000 }).split(/\s+/)[0]
    return sha ? { private: 'none', sha } : { private: 'none', error: `公開版の ${s.branch} が見つかりませんでした` }
  } catch {
    return { private: 'none', error: '公開版を確かめられませんでした（ネットワークを確かめてください）' }
  }
}

function fetchCommit(app, branch, sha) {
  git(['-C', app, 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  try { git(['-C', app, 'cat-file', '-e', `${sha}^{commit}`]) } catch {
    git(['-C', app, 'fetch', '--quiet', 'origin', sha])
  }
}

function hasKit(app, sha) {
  try { git(['-C', app, 'cat-file', '-e', `${sha}:staging/kit.mjs`]); return true } catch { return false }
}

/** True when `older` is an ancestor of `newer` (and not the same commit). */
function isAncestor(app, older, newer) {
  if (older === newer) return false
  try { git(['-C', app, 'merge-base', '--is-ancestor', older, newer]); return true } catch { return false }
}

/** Copy the kit's databases aside before the code under them changes. Returns the folder. */
export function backupDatabases(paths, fromSha) {
  if (!fs.existsSync(paths.data)) return null
  const files = fs.readdirSync(paths.data).filter(n => /\.sqlite(-wal|-shm)?$/.test(n))
  if (files.length === 0) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(paths.backups, `${stamp}-${fromSha.slice(0, 12)}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const f of files) fs.copyFileSync(path.join(paths.data, f), path.join(dir, f))
  return dir
}

function stopContainers(project) {
  // By project name: works whatever compose file the old version had. Nothing running → no-op.
  spawnSync('docker', ['compose', '-p', project, 'stop'], { stdio: 'ignore' })
}

/**
 * Bring the kit checkout to the version to run. Returns { note, private } — `note` is a line
 * for the person (or null). Writes production's plugin lock to <home>/plugins.lock (0600).
 */
export function followProduction(s, paths, logger, { stop = stopContainers } = {}) {
  const local = localHead(paths.app)
  const target = resolveTarget(s)
  if (target.private === 'ok') writePrivateFile(paths.lock, target.lockText)
  const what = target.private === 'ok' ? '本番と同じ版' : `公開版の最新（${s.branch}）`
  const d = decideUpdate({ localSha: local, remoteSha: target.sha ?? null, error: target.error })
  const done = note => ({ note, private: target.private })
  if (d.action === 'none') return done(null)
  if (d.action === 'offline') return done(`${d.detail}。いまの版のまま起動します。`)
  if (d.action === 'cannot-start') throw new Error(`検証キットを用意できませんでした: ${d.detail}。`)
  if (d.action === 'clone') {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 })
    logger.log('検証キット用の作業コピーを作っています（初回だけ・数分かかります）…')
    git(['clone', '--quiet', '--no-checkout', '--', s.remote, paths.app], { timeout: 1_800_000 })
  } else {
    const dirty = git(['-C', paths.app, 'status', '--porcelain', '--untracked-files=no'])
    if (dirty) return done(`検証キットの作業コピー（${paths.app}）に変更があるため、更新しませんでした。いまの版のまま起動します。`)
    // Look before touching anything: the target must carry the kit, or the update would leave
    // nothing to start (the containers already stopped).
    try { fetchCommit(paths.app, s.branch, d.to) } catch {
      return done('新しい版を取ってこられませんでした。いまの版のまま起動します。')
    }
    if (!hasKit(paths.app, d.to)) return done(`${what}には検証キットが入っていないため、更新しませんでした。いまの版のまま起動します。`)
    if (isAncestor(paths.app, d.to, d.from)) logger.log(`注意: ${what}はいまの版より古いため、古い版に戻します。`)
    stop(s.project)
    const backup = backupDatabases(paths, d.from)
    if (backup) logger.log(`データベースを ${backup} に控えました。`)
  }
  if (d.action === 'clone') fetchCommit(paths.app, s.branch, d.to)
  git(['-C', paths.app, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', d.to])
  const date = shortJapaneseDate(git(['-C', paths.app, 'show', '-s', '--format=%cI', 'HEAD']))
  return done(d.action === 'clone' ? `検証キットを${what}（${date}）で用意しました。` : `検証環境を${what}（${date}）に更新しました。`)
}

/** ~/acb-staging-kit/acb-staging: the one command after setup (always the checkout's bootstrap). */
function writeLauncher(paths) {
  const file = path.join(paths.home, 'acb-staging')
  const text = `#!/bin/sh\n# The staging kit's command (staging/README.md in the repository).\nexec node "${path.join(paths.app, 'staging', 'bootstrap.mjs')}" "$@"\n`
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, { mode: 0o755 })
}

export function main(argv, env = process.env) {
  const logger = createLogger()
  const cmd = argv[0] ?? 'help'
  const s = settingsFrom(env)
  const paths = kitPaths(s.home)
  let privateState = s.private ? 'kept' : 'none'
  if (FOLLOW.has(cmd) && !argv.includes('--no-update')) {
    const res = followProduction(s, paths, logger)
    if (res.note) logger.log(res.note)
    privateState = res.private
  }
  const entry = path.join(paths.app, 'staging', 'kit.mjs')
  if (!fs.existsSync(entry)) {
    logger.log(fs.existsSync(paths.app)
      ? 'この版にはまだ検証キットが入っていません。キットが入った版が出てから使えます。'
      : '検証キットはまだ用意されていません。まず setup を実行してください（pnpm staging:setup）。')
    return 1
  }
  writeLauncher(paths)
  const res = spawnSync(process.execPath, [entry, ...argv.filter(a => a !== '--no-update')], {
    stdio: 'inherit',
    env: { ...env, ACB_STAGING_HOME: paths.home, ACB_STAGING_PRIVATE_STATE: privateState },
  })
  return res.status ?? 1
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

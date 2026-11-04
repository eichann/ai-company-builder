#!/usr/bin/env node
// The staging kit's commands (staging/README.md). Runs from the kit's own checkout
// (~/acb-staging-kit/app), which staging/bootstrap.mjs keeps at the production commit — run
// the kit through bootstrap.mjs (pnpm staging:<command>), not this file directly.
//
//   setup   secrets, build, plugin shelf, start, seed 検証A社 (idempotent)
//   up      start (rebuilding what the production version changed); data kept
//   down    stop (data kept)
//   reset   wipe the data and seed again (asks first; --yes skips the question)
//   app     the desktop app against this staging, with its own user-data folder (--smoke: start,
//           check it stays up for 20 s, quit)
//   status  what runs, which version
//   remove  stop and delete everything the kit made (asks first; --yes skips the question)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createLogger, kitPaths, loadAccounts, prepareSecrets, publicUrl, settingsFrom, shortJapaneseDate } from './lib/kit.mjs'
import { seedStaging } from './seed.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const s = settingsFrom()
const p = kitPaths(s.home)
const logger = createLogger()
const say = (...a) => logger.log(...a)
const base = publicUrl(s)

// ------------------------------------------------------------------ helpers

function run(cmd, args, { cwd = root, quiet = false, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: env ?? process.env, encoding: 'utf8' })
  if (r.error) throw new Error(`${cmd} を実行できませんでした（${r.error.code ?? r.error.message}）`)
  if (r.status !== 0) {
    if (quiet) process.stderr.write(logger.redact(r.stderr ?? ''))
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} … が失敗しました（終了コード ${r.status}）`)
  }
  return r.stdout ?? ''
}

const compose = (args, opts) => run('docker', ['compose', '-p', s.project, '--env-file', p.env, '-f', path.join(here, 'compose.yml'), ...args], opts)

const head = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }

async function confirm(word, message) {
  if (process.argv.includes('--yes')) return true
  if (!process.stdin.isTTY) { say(`${message}\n確認できないため止めました（続けるなら --yes をつけてください）。`); return false }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${message}\nよろしければ「${word}」と入力してください: `)
  rl.close()
  return answer.trim() === word
}

function portOpen(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false) })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ------------------------------------------------------------------ checks

function preflight({ app = false } = {}) {
  const problems = []
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) problems.push('Docker が動いていません。OrbStack か Docker Desktop を起動してください。')
  const [maj, min] = process.versions.node.split('.').map(Number)
  if (maj < 22 || (maj === 22 && min < 12)) {
    const line = `Node ${process.versions.node} です。Node 22.12 以上を入れてください（アプリの起動に必要です）。`
    if (app) problems.push(line); else say(`注意: ${line}`)
  }
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status !== 0) problems.push('pnpm がありません（npm install -g pnpm@9）。')
  if (problems.length) throw new Error(problems.join('\n'))
}

// ------------------------------------------------------------------ build

function ensureBuilt({ images = false, app = false } = {}) {
  const h = head()
  const built = readJson(p.built, {})
  const save = () => fs.writeFileSync(p.built, JSON.stringify(built, null, 2) + '\n')
  if (built.deps !== h) {
    say('依存パッケージを入れています…')
    run('pnpm', ['install', '--frozen-lockfile'])
    built.deps = h; save()
  }
  if (images && built.images !== h) {
    say('サーバーと管理画面を組み立てています（数分かかります）…')
    compose(['build'])
    built.images = h; save()
  }
  if (app && built.app !== h) {
    say('アプリを組み立てています…')
    run('npx', ['vite', 'build'], { cwd: path.join(root, 'client') })
    built.app = h; save()
  }
}

function electronBinary() {
  const clientRequire = createRequire(path.join(root, 'client', 'package.json'))
  const pkgDir = path.dirname(clientRequire.resolve('electron/package.json'))
  const bin = path.join(pkgDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!fs.existsSync(bin)) {
    say('Electron を取ってきています（初回だけ）…')
    run('npx', ['install-electron'], { cwd: path.join(root, 'client') })
  }
  if (!fs.existsSync(bin)) throw new Error('Electron を用意できませんでした（Mac 用のキットです）。')
  return bin
}

// ------------------------------------------------------------------ plugin shelf

/**
 * The plugin shelf follows production's lock (bootstrap.mjs wrote it to <home>/plugins.lock from
 * the private kit config). Without the private setting there are no plugins; when the config
 * could not be read this time, the shelf stays as it was. Re-collected only when the lock changed.
 */
function refreshShelf() {
  const state = process.env.ACB_STAGING_PRIVATE_STATE ?? 'none'
  if (state === 'none') {
    say('追加の部品（非公開）は読み込んでいません。')
    return { changed: false }
  }
  if (state !== 'ok') {
    say('プラグインの棚はいまのままです（本番の設定を確かめられなかったため）。')
    return { changed: false }
  }
  const lockText = fs.existsSync(p.lock) ? fs.readFileSync(p.lock, 'utf8') : ''
  const built = readJson(p.built, {})
  if (built.shelfLock === lockText) return { changed: false }
  if (!lockText.trim()) {
    say('本番の設定にプラグインがないため、プラグインなしで動かします。')
    built.shelfLock = lockText
    fs.writeFileSync(p.built, JSON.stringify(built, null, 2) + '\n')
    return { changed: false }
  }
  say('プラグインの棚を本番に合わせています…')
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(here, 'shelf.ts'), '--dir', p.plugins, '--lock', p.lock],
    { cwd: path.join(root, 'server'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let res
  try { res = JSON.parse((r.stdout ?? '').trim().split('\n').at(-1)) } catch {
    say('プラグインの棚を用意できませんでした。プラグインなしで続けます。')
    return { changed: false }
  }
  if (res.packages.length) say(`プラグインは本番と同じ版です: ${res.packages.join(', ')}`)
  if (res.skipped.length) say(`読む権限がないため、次のプラグインなしで続けます: ${res.skipped.join(', ')}（gh auth login と、読む権限を確かめてください）。`)
  if (!res.skipped.length) {
    built.shelfLock = lockText
    fs.writeFileSync(p.built, JSON.stringify(built, null, 2) + '\n')
  }
  return { changed: res.added.length > 0 }
}

// ------------------------------------------------------------------ practice services

const fakesPidFile = () => path.join(p.run, 'fakes.pid')

function fakesPid() {
  const pid = Number(fs.existsSync(fakesPidFile()) ? fs.readFileSync(fakesPidFile(), 'utf8') : NaN)
  if (!Number.isInteger(pid) || pid <= 0) return null
  // Only our process: the pid file could be stale and the number reused.
  const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout.trim()
  return cmd.includes(path.join('staging', 'fakes.ts')) ? pid : null
}

async function startFakes() {
  if (fakesPid()) return
  for (const port of [s.fakeHubspotPort, s.fakeGooglePort, s.fakeSlackPort]) {
    if (await portOpen(port)) throw new Error(`ポート ${port} はほかのプログラムが使っています。ACB_STAGING_FAKE_*_PORT で別の番号にしてください。`)
  }
  const out = fs.openSync(path.join(p.logs, 'fakes.log'), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fakes.ts')], {
    cwd: path.join(root, 'server'),
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      FAKE_HUBSPOT_PORT: String(s.fakeHubspotPort),
      FAKE_GOOGLE_PORT: String(s.fakeGooglePort),
      FAKE_SLACK_PORT: String(s.fakeSlackPort),
      FAKE_HUBSPOT_KEY_FILE: p.fakeHubspotKey,
      ACB_PUBLIC_URL: base,
    },
  })
  child.unref()
  fs.writeFileSync(fakesPidFile(), String(child.pid))
  for (let i = 0; i < 60; i++) {
    if ((await Promise.all([s.fakeHubspotPort, s.fakeGooglePort, s.fakeSlackPort].map(portOpen))).every(Boolean)) {
      say(`練習用の HubSpot・Google・Slack を起動しました（${p.logs}/fakes.log）`)
      return
    }
    await sleep(500)
  }
  throw new Error(`練習用のサービスが起動しませんでした（${path.join(p.logs, 'fakes.log')} を見てください）`)
}

function stopFakes() {
  const pid = fakesPid()
  if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  fs.rmSync(fakesPidFile(), { force: true })
}

// ------------------------------------------------------------------ server

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) return } catch { /* starting */ }
    await sleep(2000)
  }
  throw new Error(`検証環境のサーバーが ${base} で応えません（docker compose -p ${s.project} logs api で確かめられます）`)
}

async function healthy() {
  try { return (await fetch(`${base}/api/config`)).ok } catch { return false }
}

async function start({ shelfChanged }) {
  await startFakes()
  const wasUp = await healthy()
  compose(['up', '-d'])
  if (wasUp && shelfChanged) compose(['restart', 'api']) // the api reads the shelf at startup
  await waitHealthy()
}

function versionLine() {
  const date = shortJapaneseDate(execFileSync('git', ['-C', root, 'show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf8' }).trim())
  return `版: ${head().slice(0, 12)}（${date}）`
}

async function seed(opts = {}) {
  const hubspotKey = fs.readFileSync(p.fakeHubspotKey, 'utf8').trim()
  logger.addSecret(hubspotKey)
  const res = await seedStaging({ base, paths: p, logger, hubspotKey, ...opts })
  for (const n of res.notes) say(`メモ: ${n}`)
  return res
}

/** The only place a password is shown: right after setup created it, to the person running it. */
function showNewAccounts(created) {
  if (!created.length) return
  const accounts = loadAccounts(p.accounts)
  process.stdout.write('\n新しく作ったアカウント（この画面でだけ表示します。あとは ' + p.accounts + ' を見てください）:\n')
  for (const email of created) {
    const a = accounts.get(email)
    process.stdout.write(`  ${email}\t${a.password}\t${a.role}\n`)
  }
}

function summary() {
  say('')
  say(`検証環境: ${base}/ （管理画面。アプリのサーバーにもこの URL）`)
  say(`アカウント: ${p.accounts}`)
  say(`アプリ: pnpm staging:app（または ${path.join(p.home, 'acb-staging')} app）`)
  say(versionLine())
}

// ------------------------------------------------------------------ commands

async function setup() {
  preflight()
  prepareSecrets(s, p, logger)
  ensureBuilt({ images: true })
  const shelf = refreshShelf()
  await start({ shelfChanged: shelf.changed })
  const res = await seed({ runImport: false })
  showNewAccounts(res.created)
  summary()
}

async function up() {
  if (!fs.existsSync(p.env)) throw new Error('まだ setup をしていません。pnpm staging:setup を実行してください。')
  preflight()
  prepareSecrets(s, p, logger)
  ensureBuilt({ images: true })
  const shelf = refreshShelf()
  await start({ shelfChanged: shelf.changed })
  const res = await seed()
  showNewAccounts(res.created)
  summary()
}

function down() {
  if (fs.existsSync(p.env)) compose(['down'])
  stopFakes()
  say('検証環境を止めました（データは残っています）。')
}

function wipeData() {
  if (fs.existsSync(p.env)) compose(['down', '-v'])
  stopFakes()
  for (const x of [p.data, p.accounts, p.state, p.userdata, p.folders, p.secrets]) fs.rmSync(x, { recursive: true, force: true })
}

async function reset() {
  if (!(await confirm('reset', `検証環境のデータ（会社・アカウント・やること・アプリの設定）をすべて消して作り直します（${p.home}）。`))) return 1
  wipeData()
  say('データを消しました。作り直します…')
  await setup()
  return 0
}

async function app() {
  preflight({ app: true })
  if (!(await healthy())) await up()
  ensureBuilt({ app: true })
  const bin = electronBinary()
  fs.mkdirSync(p.userdata, { recursive: true })
  fs.mkdirSync(p.folders, { recursive: true })
  const configFile = path.join(p.userdata, 'config.json')
  const config = readJson(configFile, {})
  if (config.serverUrl !== base) fs.writeFileSync(configFile, JSON.stringify({ ...config, serverUrl: base }, null, 2) + '\n')
  const log = fs.openSync(path.join(p.logs, 'app.log'), 'a')
  const child = spawn(bin, ['.', `--user-data-dir=${p.userdata}`], {
    cwd: path.join(root, 'client'),
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, API_URL: base, NODE_ENV: 'production' },
  })
  child.unref()
  say(`検証用アプリを起動しました（サーバー ${base}、設定は ${p.userdata}）。`)
  say(`会社のフォルダの場所を聞かれたら ${p.folders} を選んでください（普段の会社のフォルダとは別にします）。`)
  if (process.argv.includes('--smoke')) {
    await sleep(20_000)
    let alive = true
    try { process.kill(child.pid, 0) } catch { alive = false }
    if (alive) {
      // Only the app this command started (its own process group).
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 20; i++) {
        try { process.kill(child.pid, 0) } catch { break }
        await sleep(500)
      }
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
    say(alive ? 'smoke: アプリは 20 秒動き続けました（終了させました）。' : `smoke: アプリが途中で終わりました（${p.logs}/app.log）。`)
    return alive ? 0 : 1
  }
  return 0
}

async function status() {
  say(`キットの場所: ${p.home}`)
  if (fs.existsSync(path.join(root, '.git'))) say(versionLine())
  say(`サーバー（${base}）: ${(await healthy()) ? '動いています' : '止まっています'}`)
  say(`練習用サービス: ${fakesPid() ? '動いています' : '止まっています'}`)
  if (fs.existsSync(p.env)) compose(['ps'])
}

async function remove() {
  if (!(await confirm('remove', `検証キットが作ったもの（コンテナ・イメージ・${p.home} のすべて）を消します。`))) return 1
  if (fs.existsSync(p.env)) compose(['down', '-v', '--rmi', 'all'])
  stopFakes()
  fs.rmSync(p.home, { recursive: true, force: true })
  say('検証キットを消しました。')
  return 0
}

const commands = { setup, up, down, reset, app, status, remove }
const cmd = process.argv[2]
if (!commands[cmd]) {
  say('使い方: pnpm staging:<setup|up|down|reset|app|status|remove>（staging/README.md）')
  process.exitCode = 2
} else {
  try {
    const code = await commands[cmd]()
    process.exitCode = typeof code === 'number' ? code : 0
  } catch (err) {
    console.error(logger.redact(err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  }
}

// The staging kit's test data, through the API exactly as people would make it (no SQL):
// 検証A社 with 営業部・サポート部, owner / admin / member / 営業部 manager accounts, sample files and a
// private folder, records on, sample やること, the practice Google and HubSpot, and the business
// plugins from the shelf (法人営業 with the practice HubSpot, importing its deals = 案件).
//
// Each step runs once (state.json `done`), so setup / up / an update may run this again without
// undoing anything the person changed afterwards; a step that failed is tried again. Passwords
// are new random values written to <home>/accounts.txt (0600) before the sign-up that uses them;
// they are never logged (the logger redacts them) and printed only once, by kit.mjs, right
// after setup created them.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAccounts, newPassword, saveAccounts, writePrivateFile } from './lib/kit.mjs'

export const COMPANY = '検証A社'
export const PEOPLE = [
  { key: 'owner', email: 'a-owner@example.invalid', name: '検証A社 オーナー', role: 'オーナー' },
  { key: 'admin', email: 'a-admin@example.invalid', name: '検証A社 管理者', role: '管理者', invite: 'admin' },
  { key: 'member', email: 'a-member@example.invalid', name: '検証A社 メンバー', role: 'メンバー', invite: 'member' },
  { key: 'manager', email: 'a-manager@example.invalid', name: '検証A社 営業部マネージャー', role: 'メンバー＋営業部の部署マネージャー', invite: 'member' },
]
const KEEP_DEPARTMENTS = ['営業部', 'サポート部']
const PRIVATE_FOLDER = { parent: '営業部', name: '極秘案件' }
const GOOGLE = { clientId: '000000000000-acb-staging-kit.apps.googleusercontent.com', clientSecret: 'fake-google-secret-acb-staging-kit-0001', domain: 'example.invalid' }
// The practice HubSpot's owners (server/tests/fakes/hubspot/seed.ts SEED_OWNER_IDS) → 検証A社's people.
const HUBSPOT_OWNERS = { '75123001': 'member', '75123002': 'manager', '75123003': 'admin' }

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function seedStaging({ base, paths, logger, hubspotKey }) {
  const say = (...a) => logger.log(...a)
  if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error(`refusing to seed ${base}: the kit seeds only a server on this Mac`)
  const accounts = loadAccounts(paths.accounts)
  for (const a of accounts.values()) logger.addSecret(a.password)
  const state = fs.existsSync(paths.state) ? JSON.parse(fs.readFileSync(paths.state, 'utf8')) : {}
  const saveState = () => writePrivateFile(paths.state, JSON.stringify(state, null, 2) + '\n')
  const created = []
  const notes = []

  // ------------------------------------------------------------ http
  async function req(method, p, { session, body, headers = {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(base + p, {
        method,
        headers: {
          origin: base,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(session ? { cookie: session.cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (res.status === 429 && attempt < 6) { await sleep(3000 * (attempt + 1)); continue }
      let json = null
      try { json = await res.clone().json() } catch { /* not json */ }
      return { status: res.status, json, data: json?.data ?? json, res }
    }
  }
  const must = (r, what) => {
    if (r.status >= 400) throw new Error(`${what}: HTTP ${r.status} ${logger.redact(JSON.stringify(r.json)).slice(0, 300)}`)
    return r.data
  }
  const sessionFrom = (res, json) => ({ cookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), token: json.token, user: json.user })
  async function signIn(email) {
    const pw = accounts.get(email)?.password
    if (!pw) return null
    const r = await req('POST', '/api/auth/sign-in/email', { body: { email, password: pw } })
    return r.status === 200 ? sessionFrom(r.res, r.json) : null
  }
  function newAccount(person) {
    const password = newPassword()
    logger.addSecret(password)
    accounts.set(person.email, { password, role: person.role })
    saveAccounts(paths.accounts, accounts) // before the sign-up, so a password is never lost
    created.push(person.email)
    return password
  }
  async function signUp(person, invitationToken) {
    const password = newAccount(person)
    const r = await req('POST', '/api/auth/sign-up/email', {
      body: { email: person.email, password, name: person.name },
      headers: invitationToken ? { 'X-Invitation-Token': invitationToken } : {},
    })
    must(r, `sign-up ${person.email}`)
    return sessionFrom(r.res, r.json)
  }

  // ------------------------------------------------------------ owner and company
  const ownerP = PEOPLE[0]
  let owner = await signIn(ownerP.email)
  if (!owner) {
    const config = must(await req('GET', '/api/config'), 'config')
    if (config.setupComplete) {
      throw new Error(`この検証環境にはすでにアカウントがありますが、${paths.accounts} の ${ownerP.email} ではサインインできません。作り直すには staging:reset を実行してください。`)
    }
    owner = await signUp(ownerP, null) // the first account of a fresh server
    say(`アカウントを作りました: ${ownerP.email}`)
  }
  let company = must(await req('GET', '/api/companies', { session: owner }), 'list companies').find(c => c.name === COMPANY)
  if (!company) {
    company = must(await req('POST', '/api/companies', { session: owner, body: { name: COMPANY } }), `create ${COMPANY}`)
    say(`会社を作りました: ${COMPANY}`)
  }
  const cid = company.id
  const api = `/api/companies/${cid}`
  state.companyId = cid
  saveState()

  // Each set-up step runs once (recorded in state.done) and never again: later runs (up, an update)
  // must not undo what the person changed in the admin console or the app — a department they
  // added, a manager they changed, a switch they turned off, a plugin version they chose.
  state.done ??= {}
  async function once(key, fn) {
    if (state.done[key]) return
    await fn()
    state.done[key] = true
    saveState()
  }

  // ------------------------------------------------------------ people
  const sessions = { owner }
  state.users ??= {}
  state.users.owner = owner.user.id
  await once('people', async () => {
    const members = async () => must(await req('GET', `${api}/members`, { session: owner }), 'list members')
    for (const person of PEOPLE.slice(1)) {
      let session = await signIn(person.email)
      const isMember = (await members()).some(m => m.email === person.email)
      if (isMember && session) { sessions[person.key] = session; continue }
      if (isMember) throw new Error(`${person.email} はメンバーですが、${paths.accounts} のパスワードでサインインできません（staging:reset で作り直せます）`)
      const inv = must(await req('POST', `${api}/invitations`, { session: owner, body: { role: person.invite, expiresInDays: 7 } }), `invite ${person.email}`)
      if (!session) session = await signUp(person, inv.token)
      must(await req('POST', `/api/invitations/${inv.token}/accept`, { session }), `accept invitation ${person.email}`)
      sessions[person.key] = session
      say(`アカウントを作りました: ${person.email}（${person.role}）`)
    }
    for (const person of PEOPLE) state.users[person.key] = sessions[person.key].user.id
  })
  const userId = key => state.users[key]

  // ------------------------------------------------------------ departments (once, at creation)
  const deptBase = `${api}/departments`
  await once('departments', async () => {
    const depts = must(await req('GET', deptBase, { session: owner }), 'list departments')
    if (!depts.some(d => d.folder === '営業部')) must(await req('POST', deptBase, { session: owner, body: { name: '営業部', nameEn: 'Sales', folder: '営業部' } }), 'create 営業部')
    if (!depts.some(d => d.folder === 'サポート部')) must(await req('POST', deptBase, { session: owner, body: { name: 'サポート部', nameEn: 'Support', folder: 'サポート部', icon: 'Headset', color: '#0ea5e9', description: '問い合わせ対応、FAQ管理' } }), 'create サポート部')
    // The new company's default departments (empty folders) — never anything made later.
    for (const d of depts) {
      if (KEEP_DEPARTMENTS.includes(d.folder)) continue
      must(await req('DELETE', `${deptBase}/${d.id}`, { session: owner }), `delete ${d.folder}`)
      say(`既定の部署を外しました: ${d.folder}`)
    }
    const now = must(await req('GET', deptBase, { session: owner }), 'list departments')
    state.departments = Object.fromEntries(now.filter(d => KEEP_DEPARTMENTS.includes(d.folder)).map(d => [d.folder, d.id]))
  })
  const salesId = state.departments['営業部']
  await once('managers', async () => {
    must(await req('PUT', `${deptBase}/${salesId}/managers`, { session: owner, body: { userIds: [userId('manager')] } }), 'set 営業部 managers')
  })

  // ------------------------------------------------------------ files (git smart-HTTP as the owner)
  await once('files', async () => {
    const pushed = pushFiles(`${base}/api/git-http/${cid}.git`, owner.token, {
      '営業部/顧客リスト.md': '# 顧客リスト（検証A社）\n\n| 顧客 | 担当 |\n|---|---|\n| 株式会社サンプル | メンバー |\n',
      '営業部/提案テンプレート.md': '# 提案テンプレート\n\n1. 課題\n2. 提案\n3. 費用\n',
      'サポート部/よくある質問.md': '# よくある質問\n\nQ. ログインできません\nA. パスワードを再設定してください。\n',
    })
    if (pushed) say(`サンプルのファイルを ${pushed} 個置きました`)
  })

  // ------------------------------------------------------------ private folder
  await once('privateFolder', async () => {
    const pfPath = `${PRIVATE_FOLDER.parent}/${PRIVATE_FOLDER.name}`
    const pfs = must(await req('GET', `${api}/private-folders`, { session: owner }), 'list private folders')
    if (!pfs.some(f => f.path === pfPath)) {
      must(await req('POST', `${api}/private-folders`, {
        session: owner,
        body: { parentPath: PRIVATE_FOLDER.parent, name: PRIVATE_FOLDER.name, viewers: [userId('manager')], editors: [userId('manager')], force: true },
      }), 'create private folder')
      say(`非公開フォルダを作りました: ${pfPath}（オーナー・管理者・営業部マネージャーだけ）`)
    }
    const scope = must(await req('GET', `${api}/me/scopes`, { session: owner }), 'my scopes').scopes.find(x => x.path === pfPath)
    if (scope) pushFiles(base + scope.clonePath, owner.token, { '見積メモ.md': '# 見積メモ（非公開）\n\nオーナー・管理者と営業部マネージャーだけが読めます。\n' })
  })

  // ------------------------------------------------------------ records + sample やること
  await once('records', async () => {
    must(await req('PUT', `${api}/records/settings`, { session: owner, body: { enabled: true } }), 'turn records on')
  })
  await once('samples', async () => {
    const task = async (title, assignee) => must(await req('POST', `${api}/records/item`, {
      session: owner, body: { type: 'task', title, fields: { assignee, requested_by: userId('owner') } },
    }), `create task ${title}`)
    await task('株式会社サンプル 見積書を150万円で作り直す', userId('member'))
    await task('株式会社サンプル 導入スケジュール案を送る', userId('member'))
    await task('サポート部 よくある質問を3つ足す', userId('admin'))
    const meeting = await req('POST', `${api}/records/item`, {
      session: owner,
      body: { type: 'meeting', title: '株式会社サンプル 定例', fields: { meeting_at: new Date(Date.now() - 2 * 3600_000).toISOString(), assignee: userId('member'), attendees: 'メンバー', external_count: 2 } },
    })
    if (meeting.status >= 400) notes.push('会議の見本は作れませんでした（会議は練習用 Google の「議事録を確かめる」から入ります）')
    say('見本のやることを作りました')
  })

  // ------------------------------------------------------------ key broker: the practice HubSpot key
  await once('hubspotKey', async () => {
    const broker = must(await req('GET', `${api}/broker`, { session: owner }), 'key page')
    if ((broker.keys ?? []).some(k => k.service === 'hubspot' && k.scope === 'company')) return
    logger.addSecret(hubspotKey)
    must(await req('POST', `${api}/broker/keys`, {
      session: owner,
      body: { service: 'hubspot', displayName: 'HubSpot（練習用）', secret: hubspotKey, audience: { allDepartments: true, departmentIds: [], everyone: true, addUserIds: [], removeUserIds: [] } },
    }), 'register the practice HubSpot key')
    say('練習用 HubSpot の鍵を「API キー」に登録しました')
  })

  // ------------------------------------------------------------ the practice Google
  await once('google', async () => {
    const google = must(await req('GET', `${api}/google`, { session: owner }), 'google page')
    if (!google.configured) {
      must(await req('PUT', `${api}/google/client`, { session: owner, body: GOOGLE }), 'register the practice Google client')
      say('練習用 Google を登録しました')
    }
    if (!google.enabled) must(await req('PUT', `${api}/google/enabled`, { session: owner, body: { enabled: true } }), 'turn Google on')
  })

  // ------------------------------------------------------------ plugins
  const pluginReport = await setUpPlugins({ req, must, say, notes, api, owner, salesId, userId, state, once })

  saveAccounts(paths.accounts, accounts)
  saveState()
  return { companyId: cid, created, notes, plugins: pluginReport }
}

/**
 * The first time the shelf has the plugins: HubSpot (practice key, readable by 営業部, on),
 * 法人営業 (on, mapping with HubSpot's owners → our people), one import. After that the person's
 * choices stand; a newer version on the shelf is only mentioned (the admin console switches).
 */
async function setUpPlugins({ req, must, say, notes, api, owner, salesId, userId, state, once }) {
  const listed = must(await req('GET', `${api}/plugins`, { session: owner }), 'plugin shelf')
  const items = Array.isArray(listed) ? listed : (listed.plugins ?? [])
  const newest = id => items.find(p => p.id === id)?.versions?.at(-1)?.version ?? null
  const installed = id => items.find(p => p.id === id)?.install ?? null
  const report = { hubspot: newest('hubspot'), corporateSales: newest('corporate-sales'), imported: null }
  if (!report.hubspot && !report.corporateSales) {
    if (!state.done.plugins) notes.push('棚にプラグインがないため、法人営業と HubSpot は入れていません')
    return report
  }
  if (state.done.plugins) {
    for (const [id, label] of [['hubspot', 'HubSpot'], ['corporate-sales', '法人営業']]) {
      const cur = installed(id)
      const top = newest(id)
      if (cur && top && cur.version !== top) say(`${label} の新しい版 ${top} が棚にあります（いまは ${cur.version}。管理画面の「つなぎ先」で切り替えられます）`)
    }
    return report
  }

  await once('plugins', async () => {
    const broker = must(await req('GET', `${api}/broker`, { session: owner }), 'key page')
    const hubKey = (broker.keys ?? []).find(k => k.service === 'hubspot' && k.scope === 'company')
    // 1. The connector (HubSpot) with the practice key.
    if (report.hubspot && hubKey && !installed('hubspot')) {
      const r = await req('PUT', `${api}/plugins/hubspot`, { session: owner, body: { version: report.hubspot, keyId: hubKey.id } })
      if (r.status < 300) say(`HubSpot ${report.hubspot} を入れました（練習用の鍵）`)
      else notes.push(`HubSpot ${report.hubspot} を入れられませんでした（${r.json?.error ?? r.status}）`)
    }
    // 2. The business plugin (法人営業): its first install turns it on and sets the starting values.
    if (report.corporateSales && !installed('corporate-sales')) {
      const r = await req('PUT', `${api}/plugins/corporate-sales`, { session: owner, body: { version: report.corporateSales, keyId: null } })
      if (r.status < 300) say(`法人営業 ${report.corporateSales} を入れました`)
      else notes.push(`法人営業 ${report.corporateSales} を入れられませんでした（${r.json?.error ?? r.status}）`)
    }
    // 3. HubSpot readable by 営業部, and on.
    if (report.hubspot && hubKey) {
      must(await req('PUT', `${api}/plugins/hubspot/read-scope`, { session: owner, body: { departmentIds: [salesId], userIds: [] } }), 'HubSpot read scope = 営業部')
      const r = await req('PUT', `${api}/plugins/hubspot/enabled`, { session: owner, body: { enabled: true } })
      if (r.status >= 300) notes.push(`HubSpot をオンにできませんでした（${r.json?.error ?? r.status}）`)
    }
    if (!report.corporateSales) return

    // 4. 法人営業's mapping: HubSpot's owners → our people, automatic fields acknowledged.
    const detail = must(await req('GET', `${api}/plugins/corporate-sales`, { session: owner }), 'corporate-sales detail')
    if (report.hubspot && detail.mapping && !/^people:/m.test(detail.mapping.text)) {
      const acknowledgeAuto = [...new Set((detail.policies ?? []).filter(p => p.policy === 'auto').map(p => p.field))]
      let r = await req('PUT', `${api}/plugins/corporate-sales/mapping`, { session: owner, body: { text: addPeople(detail.mapping.text, userId), acknowledgeAuto } })
      if (r.status >= 300) r = await req('PUT', `${api}/plugins/corporate-sales/mapping`, { session: owner, body: { text: detail.mapping.text, acknowledgeAuto } })
      if (r.status < 300) say('法人営業の読み替え表を保存しました（HubSpot の担当者 → 検証A社の人）')
      else notes.push(`法人営業の読み替え表を保存できませんでした（${(r.json?.errors ?? [r.json?.error]).join(' / ')}）`)
    }
    const on = await req('PUT', `${api}/plugins/corporate-sales/enabled`, { session: owner, body: { enabled: true } })
    if (on.status >= 300) notes.push(`法人営業をオンにできませんでした（${on.json?.error ?? on.status}）`)

    // 5. Bring the practice HubSpot's deals in as 案件, once.
    if (report.hubspot && hubKey) {
      const r = await req('POST', `${api}/plugins/corporate-sales/import`, { session: owner })
      if (r.status < 300) {
        const deal = r.data?.objects?.deal ?? r.data?.report?.objects?.deal ?? null
        report.imported = deal ? `${deal.seen ?? '?'} 件を読み、${deal.created ?? 0} 件を作成` : (r.data?.status ?? 'ok')
        say(`練習用 HubSpot から案件を取り込みました（${report.imported}）`)
      } else {
        notes.push(`練習用 HubSpot からの取り込みができませんでした（${r.json?.error ?? r.status}${r.json?.problem ? ': ' + r.json.problem : ''}）`)
      }
    }
  })
  return report
}


/** The recommended mapping + `assignee` from HubSpot's owner and the people table. */
function addPeople(text, userId) {
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^\s{4}closed:/.test(l))
  if (at >= 0 && !/^\s{4}assignee:/m.test(text)) lines.splice(at + 1, 0, '    assignee:   { from: hubspot_owner_id, write: false, people: owners }')
  const people = ['people:', '  owners:', ...Object.entries(HUBSPOT_OWNERS).map(([id, key]) => `    "${id}": ${userId(key)}`)]
  return lines.join('\n').replace(/\n*$/, '\n') + people.join('\n') + '\n'
}

// ------------------------------------------------------------ git
function git(args, cwd, token) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x:' + token).toString('base64'),
    },
  })
}

/** Write the files that are missing, commit and push. Returns how many were added. */
function pushFiles(url, token, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acb-staging-seed-'))
  try {
    git(['clone', '-q', url, 'repo'], dir, token)
    const repo = path.join(dir, 'repo')
    let changed = 0
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repo, rel)
      if (fs.existsSync(abs)) continue
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      changed++
    }
    if (!changed) return 0
    git(['add', '-A'], repo, token)
    git(['-c', 'user.name=検証A社 オーナー', '-c', 'user.email=a-owner@example.invalid', 'commit', '-q', '-m', 'Add sample files'], repo, token)
    git(['push', '-q', 'origin', 'HEAD'], repo, token)
    return changed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

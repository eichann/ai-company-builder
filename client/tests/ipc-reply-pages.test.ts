// replyPage:save (features/reply-pages/ipc.ts, chat-ui-and-history.md "Rich replies: ［大きく見る］［ページとして残す］
// ［コードとして見る］"), through the real main.ts with a fake Electron. The chat hands over the page and which
// consultation it is from; main alone decides where it goes — the member's 今日のフォルダ's ページ/ — and never
// replaces, never writes outside it (a today folder of another shape, a link out of the company folder, a department
// not here), and never at the company folder's top level.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadMain, writeFiles, type MainHarness } from './ipc-harness/main-harness.ts'
import { replyPageBaseName } from '../shared/reply-pages'

let h: MainHarness
let root: string
let outside: string
const TODAY = '営業部/.personal/inbox/日付別/2026/20261128'
const WHO = { companyId: 'acme', sessionId: 'conv-page-0001' }
const HTML = '<!doctype html><h1>比べ表</h1><script>document.title = "動いてよい"</script>'

before(async () => {
  h = await loadMain()
  root = h.companyDir('reply-pages')
  outside = h.companyDir('reply-pages-outside')
  writeFiles(root, { '営業部/提案.md': 'p', '人事/x.md': 'x' })
  h.fake.openDialogResults.push({ canceled: false, filePaths: [root] })
  assert.equal(await h.invoke('dialog:selectDirectory'), root)
  const now = new Date().toISOString()
  await h.invoke('chatHistory:saveSession', 'acme', { id: WHO.sessionId, companyId: 'acme', title: 'A社とB社: 比べ/まとめ', messages: [], createdAt: now, updatedAt: now })
})
after(() => h.shutdown())

const save = (args: { rootPath?: string; todayFolder?: string; who?: unknown; html?: unknown } = {}) =>
  h.invoke<{ success: boolean; path?: string; name?: string; error?: string }>('replyPage:save',
    args.rootPath ?? root, args.todayFolder ?? TODAY, args.who ?? WHO, 'html' in args ? args.html : HTML)
const pageFolderOf = () => path.join(root, TODAY, 'ページ')

test('a page goes to the today folder\'s ページ/, named after the consultation, the AI\'s HTML as written', async () => {
  const saved = await save()
  assert.equal(saved.success, true, saved.error)
  assert.equal(saved.name, 'A社とB社 比べ まとめ.html')
  assert.equal(saved.path, path.join(pageFolderOf(), 'A社とB社 比べ まとめ.html'))
  assert.equal(fs.readFileSync(saved.path!, 'utf-8'), HTML)
})

test('a name already taken gets 「(2)」, 「(3)」: nothing is replaced', async () => {
  const name = 'AI の返事'
  writeFiles(pageFolderOf(), { [`${name}.html`]: 'the member\'s own' })
  const other = { companyId: 'acme', sessionId: 'conv-not-stored-01' }
  const second = await save({ who: other, html: '<p>2</p>' })
  const third = await save({ who: other, html: '<p>3</p>' })
  assert.equal(second.name, `${name} (2).html`)
  assert.equal(third.name, `${name} (3).html`)
  assert.equal(fs.readFileSync(path.join(pageFolderOf(), `${name}.html`), 'utf-8'), 'the member\'s own')
  assert.equal(fs.readFileSync(path.join(pageFolderOf(), `${name} (3).html`), 'utf-8'), '<p>3</p>')
})

test('never outside the today folder: another root, another shape, a climb, the top level, a department not here, a link out', async () => {
  const before = fs.readdirSync(outside)
  const refused = [
    { rootPath: outside },
    { rootPath: path.join(root, '..', 'reply-pages-outside') },
    { todayFolder: '営業部/共有' },
    { todayFolder: '' },
    { todayFolder: '../reply-pages-outside/.personal/inbox/日付別/2026/20261128' },
    { todayFolder: '営業部/.personal/inbox/日付別/2026/20261128/../../../../共有' },
    { todayFolder: '.personal/inbox/日付別/2026/20261128' },
    { todayFolder: 'ない部署/.personal/inbox/日付別/2026/20261128' },
  ]
  for (const args of refused) {
    const result = await save(args)
    assert.equal(result.success, false, JSON.stringify(args))
  }
  assert.equal(fs.existsSync(path.join(root, 'ない部署')), false)
  // A teammate's link on the way out of the company folder: refused by real location, nothing made outside.
  fs.mkdirSync(path.join(root, '人事', '.personal'), { recursive: true })
  fs.symlinkSync(outside, path.join(root, '人事', '.personal', 'inbox'))
  const linked = await save({ todayFolder: '人事/.personal/inbox/日付別/2026/20261128' })
  assert.equal(linked.success, false)
  assert.deepEqual(fs.readdirSync(outside), before)
  // Nothing landed at the company folder's top level either.
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.html')), [])
})

test('what is not a page is refused: no text, too long, not a string', async () => {
  for (const html of ['', '   ', 'x'.repeat(5_000_001), 42, null]) assert.equal((await save({ html })).success, false)
})

test('the page\'s name is the title made safe for a file, else 「AI の返事」', () => {
  assert.equal(replyPageBaseName('経費の精算について'), '経費の精算について')
  assert.equal(replyPageBaseName('新しい相談'), 'AI の返事')
  assert.equal(replyPageBaseName(null), 'AI の返事')
  assert.equal(replyPageBaseName('..'), 'AI の返事')
  assert.equal(replyPageBaseName('.env'), 'env')
  assert.equal(replyPageBaseName('a‮gnp.exe'), 'a gnp.exe')
  assert.equal(replyPageBaseName('CON'), 'AI の返事')
  assert.equal(replyPageBaseName('あ'.repeat(60)).length, 40)
})

// The settings reordered by what the member wants to do (UX stage 3, item 19) still reach every setting
// they had: each former item has a section, each section one place, and only the company's or member's
// situation hides one (no shared folder → nothing about syncing; no browser site → no ブラウザ操作).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SETTINGS_GROUPS, sectionToOpen, settingsGroupsFor, shownSectionIds, type SettingsSectionId } from './sections'

const ALL = { sharedFolder: true, browserSites: true }

// The left list before the reordering (2026-11-28) and where each item is now.
const BEFORE: Record<string, SettingsSectionId> = {
  自分の設定: 'mine',
  ダウンロードするフォルダ: 'sync',
  自動同期: 'autosync',
  同期しないファイル: 'gitignore',
  仕事の道具をつなぐ: 'tools',
  自分の鍵: 'ownkeys',
  Google: 'google',
  Slack: 'slack',
  ブラウザ操作: 'browser',
  'APIキー（このPC）': 'envkeys',
  '環境変数（.env）': 'envkeys',
  AIに渡す環境変数: 'aienv',
  不在と代わりの人: 'absences',
  定期の仕事: 'jobs',
  音声入力: 'input',
  入力候補: 'input',
}

test('every former settings item has a section the member reaches (nothing dropped)', () => {
  const shown = shownSectionIds(ALL)
  for (const [before, now] of Object.entries(BEFORE)) assert.ok(shown.includes(now), `${before} → ${now}`)
})

test('each section is in exactly one group, and every section is listed', () => {
  const ids = SETTINGS_GROUPS.flatMap(group => group.items.map(item => item.id))
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual([...new Set(Object.values(BEFORE))].sort(), [...ids].sort())
})

test('grouped by what the member wants to do, with 詳しい設定 (the .env keys and AI environment) folded last', () => {
  assert.deepEqual(settingsGroupsFor(ALL).map(group => group.label), ['AI', 'つないでいるサービス', '知らせ', 'ファイルと同期', '詳しい設定'])
  const advanced = settingsGroupsFor(ALL).at(-1)!
  assert.equal(advanced.folded, true)
  assert.deepEqual(advanced.items.map(item => item.id), ['gitignore', 'envkeys', 'aienv'])
})

test('a company without the shared folder shows nothing about syncing; everything else stays', () => {
  const shown = shownSectionIds({ sharedFolder: false, browserSites: true })
  for (const id of ['sync', 'autosync', 'gitignore'] as const) assert.ok(!shown.includes(id), id)
  assert.equal(shown.length, shownSectionIds(ALL).length - 3)
  assert.ok(!settingsGroupsFor({ sharedFolder: false, browserSites: true }).some(group => group.id === 'files'))
})

test('ブラウザ操作 only while the member has a site to operate', () => {
  assert.ok(!shownSectionIds({ sharedFolder: true, browserSites: false }).includes('browser'))
  assert.ok(shownSectionIds(ALL).includes('browser'))
})

test('a section asked for that this member does not see opens 「AI に任せること」 instead', () => {
  assert.equal(sectionToOpen('sync', { sharedFolder: false, browserSites: false }), 'mine')
  assert.equal(sectionToOpen('ownkeys', ALL), 'ownkeys')
  assert.equal(sectionToOpen(undefined, ALL), 'mine')
})

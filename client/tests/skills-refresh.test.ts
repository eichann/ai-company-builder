import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SkillsCache, scanAffected, skillsCacheKey, skillsScopesAffected } from '../shared/skills-refresh'

const ROOT = '/Users/me/Documents/AI Company Builder/abe-shoten'
const ev = (type: string, rel: string) => ({ type, path: `${ROOT}/${rel}` })

test('cache keys: one per scanned root + department, separators / NFC / trailing slash do not matter', () => {
  assert.equal(skillsCacheKey(ROOT, '営業部'), skillsCacheKey(`${ROOT}/`, '営業部/'))
  assert.equal(skillsCacheKey(ROOT, '営業部'.normalize('NFD')), skillsCacheKey(ROOT, '営業部'))
  assert.equal(skillsCacheKey('C:\\acb\\co', 'x'), skillsCacheKey('C:/acb/co', 'x'))
  assert.notEqual(skillsCacheKey(ROOT, ''), skillsCacheKey(ROOT, '営業部'))
})

test('root .claude/skills → company-wide scan only', () => {
  const s = skillsScopesAffected(ROOT, [ev('add', '.claude/skills/new-skill/SKILL.md')])
  assert.ok(s)
  assert.equal(scanAffected(s, ''), true)
  assert.equal(scanAffected(s, '営業部'), false)
})

test('a department skill at any depth → that department only', () => {
  for (const rel of ['営業部/.claude/skills/a/SKILL.md', '営業部/案件/2026/.claude/skills/b/rules/x.md', '営業部/.claude/skills']) {
    const s = skillsScopesAffected(ROOT, [ev('change', rel)])
    assert.equal(scanAffected(s, '営業部'), true, rel)
    assert.equal(scanAffected(s, 'コンテンツ'), false, rel)
    assert.equal(scanAffected(s, ''), false, rel)
  }
})

test('a .claude folder removed or added as a whole counts', () => {
  assert.equal(scanAffected(skillsScopesAffected(ROOT, [ev('unlinkDir', '.claude')]), ''), true)
  assert.equal(scanAffected(skillsScopesAffected(ROOT, [ev('unlink', '営業部/sub/.claude')]), '営業部'), true)
})

test('root .gitignore (private marks) → every scan', () => {
  const s = skillsScopesAffected(ROOT, [ev('change', '.gitignore')])
  assert.equal(scanAffected(s, ''), true)
  assert.equal(scanAffected(s, '営業部'), true)
})

test('folders moving in or out of a department may carry skills; plain file edits do not', () => {
  assert.equal(scanAffected(skillsScopesAffected(ROOT, [ev('addDir', '営業部/moved-in')]), '営業部'), true)
  assert.equal(scanAffected(skillsScopesAffected(ROOT, [ev('unlinkDir', '営業部/x/y')]), '営業部'), true)
  assert.equal(skillsScopesAffected(ROOT, [ev('change', '営業部/提案書.md')]), null)
  assert.equal(skillsScopesAffected(ROOT, [ev('add', '営業部/提案書.md')]), null)
  // .claude/commands and .claude/agents are not in the list
  assert.equal(skillsScopesAffected(ROOT, [ev('change', '.claude/commands/x.md')]), null)
  assert.equal(skillsScopesAffected(ROOT, [ev('change', '.claude/settings.json')]), null)
  // outside the company, or another company with a common prefix
  assert.equal(skillsScopesAffected(ROOT, [{ type: 'add', path: `${ROOT}-2/.claude/skills/a/SKILL.md` }]), null)
})

test('Windows separators and NFD event paths are understood', () => {
  const win = skillsScopesAffected('C:\\co', [{ type: 'add', path: 'C:\\co\\営業部\\.claude\\skills\\a\\SKILL.md' }])
  assert.equal(scanAffected(win, '営業部'), true)
  const nfd = skillsScopesAffected(ROOT, [{ type: 'add', path: `${ROOT}/${'営業部'.normalize('NFD')}/.claude/skills/a/SKILL.md` }])
  assert.equal(scanAffected(nfd, '営業部'), true)
})

test('SkillsCache: reused within the TTL, dropped by a relevant event, kept by an unrelated one', () => {
  let now = 0
  const cache = new SkillsCache<string[]>(5000, () => now)
  cache.set(ROOT, '', ['company'])
  cache.set(ROOT, '営業部', ['sales'])
  cache.set(ROOT, 'コンテンツ', ['content'])
  assert.deepEqual(cache.get(ROOT, '営業部'), ['sales'])

  assert.equal(cache.invalidateForChanges([ev('change', '営業部/提案書.md')]), 0)
  assert.equal(cache.invalidateForChanges([ev('add', '営業部/.claude/skills/new/SKILL.md')]), 1)
  assert.equal(cache.get(ROOT, '営業部'), undefined)
  assert.deepEqual(cache.get(ROOT, 'コンテンツ'), ['content'])
  assert.deepEqual(cache.get(ROOT, ''), ['company'])

  assert.equal(cache.invalidateForChanges([ev('unlink', '.claude/skills/old')]), 1)
  assert.equal(cache.get(ROOT, ''), undefined)

  now = 5000
  assert.equal(cache.get(ROOT, 'コンテンツ'), undefined, 'expired')
})

test('SkillsCache.invalidate: one department (the old key mismatch), or the whole root', () => {
  const cache = new SkillsCache<number>(5000, () => 0)
  cache.set(ROOT, '営業部', 1)
  cache.set(ROOT, 'コンテンツ', 2)
  cache.set('/other', '営業部', 3)
  cache.invalidate(ROOT, '営業部/')
  assert.equal(cache.get(ROOT, '営業部'), undefined)
  assert.equal(cache.get(ROOT, 'コンテンツ'), 2)
  cache.invalidate(ROOT)
  assert.equal(cache.get(ROOT, 'コンテンツ'), undefined)
  assert.equal(cache.get('/other', '営業部'), 3)
})

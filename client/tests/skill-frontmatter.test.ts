// A new or copied skill's SKILL.md frontmatter is valid YAML whatever the
// member typed (client/shared/skill-frontmatter.ts): a description with a line
// break, `---`, `: ` or `#` broke the block, and the AI (which reads it as
// YAML) no longer saw the skill's name and description. Checked with a real
// YAML parser, the way the AI's tools read it, and with the app's own reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
import { parseFrontmatter, setFrontmatterField } from '../shared/skill-frontmatter'
import { newSkillMarkdown, renameSkillMarkdown } from '../src/features/skills/model'

const NASTY = [
  '提案書: 作成',
  '1行目\n2行目\n---\nname: 乗っ取り',
  '# 見出しではない',
  '"引用" と \'単引用\' と \\ バックスラッシュ',
  '  前後に空白  ',
  '- リストのような',
  'タブ\tと\r改行',
  'true',
  '',
]

/** What a YAML parser sees in the frontmatter of `content`. */
function yamlOf(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'the frontmatter block is still closed by its own ---')
  return yaml.load(match[1]) as Record<string, unknown>
}

test('a new skill\'s name and description reach a YAML reader exactly as typed, and nothing else is added', () => {
  for (const name of NASTY) {
    for (const description of NASTY) {
      const md = newSkillMarkdown({ name, description, prompt: '', folderName: 'x' })
      assert.deepEqual(yamlOf(md), { name, description }, JSON.stringify({ name, description }))
      const own = parseFrontmatter(md)
      assert.equal(own.name, name)
      assert.equal(own.description, description)
    }
  }
})

test('copying renames the skill in place, whatever form the old name had, and keeps the other entries', () => {
  const forms = [
    '---\nname: 古い名前\ndescription: 説明\nstatus: nurturing\n---\n\n# 本文\nname: 本文の行\n',
    '---\nname: "古い: 名前"\ndescription: 説明\nstatus: nurturing\n---\n\n# 本文\nname: 本文の行\n',
    '---\nname: |\n  古い\n  名前\ndescription: 説明\nstatus: nurturing\n---\n\n# 本文\nname: 本文の行\n',
  ]
  for (const original of forms) {
    for (const name of NASTY) {
      const md = renameSkillMarkdown(original, name)
      assert.deepEqual(yamlOf(md), { name, description: '説明', status: 'nurturing' })
      assert.ok(md.endsWith('\n\n# 本文\nname: 本文の行\n'), 'the body is untouched')
    }
  }
  // No frontmatter yet: one is added.
  assert.deepEqual(yamlOf(setFrontmatterField('# 本文\n', 'name', 'a: b')), { name: 'a: b' })
})

test('the app reads SKILL.md files people and the AI wrote by hand the way YAML does', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['---\nname: 週報\ndescription: 週報をまとめる # コメント\n---\n', { name: '週報', description: '週報をまとめる' }],
    ["---\nname: 'it''s'\ndescription: \"a\\nb\"\n---\n", { name: "it's", description: 'a\nb' }],
    ['---\nname: x\ndescription: >-\n  一行目\n  続き\n\n  次の段落\n---\n', { name: 'x', description: '一行目 続き\n次の段落' }],
    ['---\nname: x\ndescription: |\n  一行目\n  二行目\n---\n', { name: 'x', description: '一行目\n二行目\n' }],
    ['---\r\nname: x\r\ndescription: CRLF\r\n---\r\n', { name: 'x', description: 'CRLF' }],
    ['---\nname: x\ndescription: 長い説明が\n  次の行に続く\n---\n', { name: 'x', description: '長い説明が 次の行に続く' }],
  ]
  for (const [md, expected] of cases) {
    const own = parseFrontmatter(md)
    const theirs = yaml.load(md.replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---/)![1]) as Record<string, string>
    for (const key of Object.keys(expected)) {
      assert.equal(own[key], expected[key], `${key} of ${JSON.stringify(md)}`)
      assert.equal(own[key], theirs[key], `same as YAML: ${key} of ${JSON.stringify(md)}`)
    }
  }
  assert.deepEqual(parseFrontmatter('# no frontmatter'), {})
})

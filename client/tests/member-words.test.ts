// Members read one word for one thing (owner 2026-11-23: ordinary members never see developer
// words). The member UI spells a skill 「Skill」 — as CLAUDE.md and the manual do — never 「スキル」
// or 「SKILL」 (file names such as SKILL.md aside); a new consultation is a 「相談」.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { THING_NAMES } from '../shared/thing-words'
import { builtinToolDisplay } from '../shared/tool-display'

const ja = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/i18n/locales/ja.json'), 'utf8')) as Record<string, Record<string, string>>

const OTHER_SPELLING = /スキル|SKILL(?!\.md)/

test('the Japanese screen texts spell a skill 「Skill」', () => {
  const found = Object.entries(ja).flatMap(([group, texts]) => Object.entries(texts)
    .filter(([, text]) => typeof text === 'string' && OTHER_SPELLING.test(text)).map(([key, text]) => `${group}.${key}: ${text}`))
  assert.deepEqual(found, [])
  assert.equal(ja.tabs.skills, 'Skill')
  assert.equal(ja.skillDetail.executeButton, 'この Skill を実行')
})

test('the words the app shows for a skill elsewhere say 「Skill」 too', () => {
  assert.equal(THING_NAMES.skill, 'Skill')
  for (const tool of ['Skill', 'SlashCommand', 'readSkillFile']) {
    const display = builtinToolDisplay(tool)!
    assert.doesNotMatch(`${display.label} ${display.running} ${display.many}`, OTHER_SPELLING, tool)
  }
})

test('a new consultation is named 「新しい相談」, and the approval banner\'s title has no developer word', () => {
  assert.equal(ja.chat.newChat, '新しい相談')
  assert.doesNotMatch(ja.chat.toolApprovalTitle, /ツール|Tool/)
})

// Members read one word for one thing (owner 2026-11-23: ordinary members never see developer
// words). The member UI spells a skill 「Skill」 — as CLAUDE.md and the manual do — never 「スキル」
// or 「SKILL」 (file names such as SKILL.md aside); a new consultation is a 「相談」; a task is a
// 「やること」 (thing-words.ts), never 「タスク」; a switch is named as 自分の設定 names it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileURLToPath } from 'node:url'
import { THING_NAMES } from '../shared/thing-words'
import { builtinToolDisplay, toolLineOf } from '../shared/tool-display'
import { taskWaitOver } from '../shared/ai-turn-steps/task-wait-over'
import { WORK_SWITCH_NAMES } from '../shared/work-switches'
import { JOB_CANDIDATE_NOTES } from '../shared/job-proposals'
import { OriginLine } from '../src/features/tasks/components/TaskHead'

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ja = JSON.parse(fs.readFileSync(path.join(CLIENT, 'src/i18n/locales/ja.json'), 'utf8')) as Record<string, Record<string, string>>

/** The app's own code under client/src and client/shared, without tests: `file: line` for each code line (comments left out). */
function codeLines(): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(CLIENT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        for (const line of fs.readFileSync(path.join(CLIENT, rel), 'utf8').split('\n')) {
          const t = line.trim()
          if (!t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) out.push({ file: rel, line: t })
        }
      }
    }
  }
  walk('src'); walk('shared')
  return out
}

/** Where 「タスク」 may stay in code, and why. */
const TASK_WORD_ALLOWED: Record<string, string> = {
  'shared/acb-tool-displays.ts': 'CORE_TYPE_LABELS mirror the type definitions (tool-display.test.ts); members read them through thingName',
  'shared/link-drop.ts': 'turns a link label\'s 「タスク」 into 「やること」',
  'src/features/records/components/linkRows.tsx': 'turns a link label\'s 「タスク」 into 「やること」',
  'shared/minutes-app.ts': 'a prompt the AI alone reads',
  'shared/ai-turn-steps/inbox-triage.ts': 'a prompt the AI alone reads',
  'shared/ai-turn-steps/reply-check.ts': 'a prompt the AI alone reads',
  'shared/ai-turn-steps/task-wait-over.ts': 'its first message is a prompt the AI alone reads (the consultation\'s title is checked below)',
}

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

test('no code line under client/src or client/shared spells a skill 「スキル」', () => {
  assert.deepEqual(codeLines().filter(l => /スキル/.test(l.line)).map(l => `${l.file}: ${l.line}`), [])
})

test('no code line a member may read says 「タスク」: a task is 「やること」', () => {
  assert.deepEqual(codeLines().filter(l => /タスク/.test(l.line) && !(l.file in TASK_WORD_ALLOWED)).map(l => `${l.file}: ${l.line}`), [])
  assert.equal(taskWaitOver.consultationTitle({ id: 'task-1', title: '見積の返事' } as never), 'やること「見積の返事」の追いかけ')
  assert.equal(toolLineOf('mcp__acb_records__records_create', { type: 'task', title: '修正見積を送る' }).detail, 'やること「修正見積を送る」')
})

test('the scheduled-job card names the switch as 自分の設定 does, 「AI が自動で進める」', () => {
  assert.equal(WORK_SWITCH_NAMES.autoRun, 'AI が自動で進める')
  assert.ok(JOB_CANDIDATE_NOTES.some(n => n.includes('「AI が自動で進める」')))
  assert.deepEqual(codeLines().filter(l => /AI に任せる/.test(l.line)).map(l => `${l.file}: ${l.line}`), [])
})

test('a task made by the AI reads 「…から AI が作りました」, with the space before 「AI」', () => {
  const text = (byAi: boolean, addedBy: string | null) => renderToStaticMarkup(React.createElement(OriginLine, {
    origin: { kind: 'meeting', recordId: 'meeting-1', title: '週次', at: '2026-11-05T10:00:00', byAi, addedBy, basis: null },
  })).replace(/<[^>]+>/g, '')
  assert.equal(text(true, null), '会議「週次」（11/5）から AI が作りました')
  assert.equal(text(false, '佐藤'), '会議「週次」（11/5）から佐藤さんが作りました')
})

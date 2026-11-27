// 「返事の下書きを、わたしの書き方に合わせる」: the core knows no tool (owner decision 2026-11-28 — LINE or Microsoft Teams
// may join later). Its parts — the summary's shape and rules, the server's port, service and route, the app's words and
// its store / summarizer / IPC — neither name a tool nor import a connector's module: a connector is an id the role
// resolver answered, and each connector's reader lives in its own module (server/src/services/<connector>-*.ts),
// registered by the composition root. Same idea as 「ブラウザ操作」's "the browser core knows no site".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CORE_FILES = [
  'shared/core/writing-style.ts',
  'shared/types/writing-style.ts',
  'server/src/ports/sent-samples.ts',
  'server/src/services/writing-samples.ts',
  'server/src/routes/writing-samples.ts',
  'client/shared/writing-style.ts',
  ...readdirSync(join(ROOT, 'client/electron/features/writing-style')).map(f => `client/electron/features/writing-style/${f}`),
]

/** A tool's name in code or words (whole words, any case), or an import of a connector's own module. */
const TOOL_WORDS = /\b(?:google|gmail|g-?suite|workspace|slack|microsoft|outlook|teams|exchange|line[-_ ]?works|chatwork|hubspot)\b|グーグル|スラック|チームズ|ライン/i
const CONNECTOR_IMPORT = /from\s+['"][^'"]*(?:google|slack|gmail)[^'"]*['"]/i

function toolMentions(source: string): string[] {
  const out: string[] = []
  source.split('\n').forEach((line, i) => {
    if (TOOL_WORDS.test(line) || CONNECTOR_IMPORT.test(line)) out.push(`${i + 1}: ${line.trim().slice(0, 120)}`)
  })
  return out
}

test('the writing-style core names no tool and imports no connector', () => {
  const found: string[] = []
  for (const file of CORE_FILES) {
    for (const hit of toolMentions(readFileSync(join(ROOT, file), 'utf8'))) found.push(`${relative(ROOT, join(ROOT, file))}:${hit}`)
  }
  assert.deepEqual(found, [], 'a tool\'s words belong in its connector\'s own module (google-writing.ts, …), never in the core')
  // Self-tests: the check sees a tool's name and an import of a connector's module.
  assert.equal(toolMentions('const x = gmail.read()').length, 1)
  assert.equal(toolMentions("import { a } from '../services/slack-chat'").length, 1)
  assert.equal(toolMentions('Microsoft Teams のチャット').length, 1)
  assert.equal(toolMentions('the online summary').length, 0)
})

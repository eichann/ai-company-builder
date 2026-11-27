/**
 * What the operator of a write task works from, guaranteed by the app rather than by its prompt (agent-browser.md "The
 * operator works from the approved steps", "The stopped card shows the screen"; owner 2026-11-28: 「AI に守らせたいことは
 * 説明文ではなく仕組みで保証する」, after a trial on 2026-11-27 stopped four times on the prompt's own words). Against fakes of
 * the server's routes, the operator and the window; a fictional site only.
 *
 * Guards (each test fails when its guard is removed or inverted):
 * - with a Skill, the operator gets the person's words (`said`, `values`) and the Skill's steps — never the consultation
 *   AI's own request text, so steps or stop conditions it adds cannot reach the operator; without one, its request;
 * - the person's words come first in the material, before the steps; the prompts rank them so;
 * - a Skill's steps are handed only when they are exactly the text the server sealed for the folder version the frames come
 *   from: a different, missing or too-large copy, or no seal at all, starts nothing (no operator run, no permit) and the
 *   card says why in fixed words;
 * - the plan the person approved on the preview's card is the work's material; a pre-approved Skill's work says there was
 *   no preview (`plan: null`);
 * - a stopped card carries the screen the operator stopped on, only beside what it asks, in memory only: never the
 *   consultation AI's words, the server, the site or after sign-out; the renderer takes it only in its exact shape;
 * - the tool takes the person's words only in their shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createBrowserContext } from '../electron/features/browser/context'
import { wireBrowserWork } from '../electron/features/browser/work'
import { createBrowserWorkTool, workPersonOf } from '../electron/browser-request/inspect-tool'
import type { BrowserLinesAnswer } from '../electron/features/browser/lines-api'
import type { PreviewOperator } from '../electron/features/browser/preview'
import { readBrowserPageSnapshot, type BrowserBrowseSurface, type BrowserPageSnapshot } from '../shared/browser-browse'
import {
  BROWSER_OPERATOR_WORK_PREVIEW_PROMPT, BROWSER_OPERATOR_WORK_PROMPT, BROWSER_WORK_WORDS as WW, workWordsForAi, type BrowserWorkHooks,
} from '../shared/browser-frame-writes'
import { readBrowserCard, readBrowserInspectionView } from '../shared/browser-inspection'
import { readBrowserWriteView } from '../shared/browser-line-writes'
import { BROWSER_STOP_SCREEN_MAX, browserStopScreen, readBrowserStopScreen } from '../shared/browser-operator-trail'
import { BROWSER_SKILL_STEPS_LIMITS, browserSkillStepsCheck, browserSkillStepsSeal, browserSkillStepsText, readBrowserSkillStepsSeal } from '../../shared/core/browser-skill-steps'

const HOST = 'shop.example.test'
const COMPANY = 'company-1'
const RUN = `bo_${'a'.repeat(32)}`
const FRAME_RUN = `bf_${'b'.repeat(32)}`
const TOKEN = 'f'.repeat(64)
const PLAN_HASH = `sha256:${'c'.repeat(64)}`
const STEPS = '# SKILL.md\n1. 一覧で元の行を開く\n2. 名前を【回】の名前にして登録する'
/** Words only the consultation AI wrote (a stop condition of its own): must never reach the operator with a Skill. */
const AI_ADDED = '同じ名前があったら必ず止めて確認すること'
const SCREEN = 'ACB-STOP-SCREEN-77'
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex')
const sealOf = (text: string) => ({ state: 'sealed', hash: `sha256:${sha(text)}` })

const page = (): BrowserPageSnapshot => readBrowserPageSnapshot(JSON.stringify({
  address: `https://${HOST}/items`, title: '一覧', text: '一覧', truncated: false,
  elements: [{ ref: 1, role: 'button', name: '登録', logLabel: '登録' }],
}), HOST)!

interface Opts {
  answers: string[]
  skill?: string | null
  /** The frames run's start: pre-approved (no card, no preview) or waiting for the card. */
  needsApproval?: boolean
  /** The seal the server answers (undefined: none — an older server). */
  seal?: unknown
  /** The steps on this PC (null: the path is no Skill place; 'none': no step file). */
  local?: string | 'none' | 'too-large' | null
  said?: string[]
  values?: Array<{ label: string; value: string }>
}

function world(o: Opts) {
  let hooks: BrowserWorkHooks | null = null
  const calls: string[] = []
  const materials: Array<Record<string, unknown>> = []
  const surface: BrowserBrowseSurface = {
    async enter(_stopped, h) { hooks = h ?? null; calls.push('enter'); return true }, async leave() {}, async snapshot() { return page() },
    async screenshot() { return { mediaType: 'image/jpeg', data: new TextEncoder().encode(`${SCREEN}-${materials.length + 1}`) } },
    async act(a) {
      if (a.do === 'click' && hooks) await hooks.holdWrite({ method: 'POST', url: `https://${HOST}/items`, contentType: 'application/json', body: { kind: 'text', text: '{"name":"x"}' }, send: async () => ({ kind: 'answered', status: 201, body: '{}', headers: [] }) as never })
      return { outcome: 'ok' }
    },
    pageClean: () => true, closed: () => false,
  }
  let n = 0
  const operator: PreviewOperator = {
    model: 'm',
    async resolve() { return { ok: true, cli: { path: '/bin/claude', pathDirs: [] } } },
    async step(job) { calls.push(`step ${job.prompt}`); materials.push(job.material as Record<string, unknown>); return { ok: true, text: o.answers[n++] ?? '{"do":"stop","why":"blocked","unread":[]}' } },
  }
  const skill = o.skill === undefined ? 'items' : o.skill
  const api = {
    async runStart() { calls.push('runStart'); return { kind: 'ok', value: { runId: RUN, leaseMs: 120_000 } } as BrowserLinesAnswer },
    async runContinue() { return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async runFinish(_c: string, _r: string, body: unknown) { calls.push(`runFinish ${JSON.stringify(body)}`); return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async frameStart(_c: string, body: unknown) {
      calls.push(`frameStart ${JSON.stringify(body)}`)
      const adhoc = 'plan' in (body as object)
      const waiting = adhoc || o.needsApproval !== false
      return {
        kind: 'ok', value: {
          runId: FRAME_RUN, state: waiting ? 'waiting' : 'open', endReason: null, host: HOST, source: adhoc ? 'adhoc' : 'skill', skill: adhoc ? null : `.claude/skills/${skill}`, planHash: PLAN_HASH,
          needsApproval: waiting, approval: waiting ? null : 'pre_approved', createdAt: '', expiresAt: '', endedAt: null, frames: [{ frame: 1, method: 'POST', path: '/items', fields: {}, max: 1, used: 0, left: 1 }],
          writes: [], approvalToken: waiting ? TOKEN : null, afterRead: [], neverRead: [],
          ...(!adhoc && o.seal !== undefined ? { steps: o.seal } : {}),
        },
      } as BrowserLinesAnswer
    },
    async frameApprove() { calls.push('frameApprove'); return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async framePermit(_c: string, _r: string, body: { frame: number }) { calls.push('framePermit'); return { kind: 'ok', value: { write: 1, frame: body.frame, permittedAt: new Date().toISOString(), validMs: 5000 } } as BrowserLinesAnswer },
    async frameGet() { return { kind: 'no-answer' } as BrowserLinesAnswer },
    async frameConfirm() { return { kind: 'no-answer' } as BrowserLinesAnswer },
    async frameReport(_c: string, _r: string, body: unknown) { calls.push(`frameReport ${JSON.stringify(body)}`); return { kind: 'ok', value: {} } as BrowserLinesAnswer },
    async frameEnd() { calls.push('frameEnd'); return { kind: 'ok', value: {} } as BrowserLinesAnswer },
  }
  let user: string | null = 'u-1'
  const local = o.local === undefined ? STEPS : o.local
  const wiring = wireBrowserWork({
    aiSwitch: () => true, userId: () => user, context: createBrowserContext({ userId: () => user, aiSwitch: () => true }), stopped: () => false,
    window: () => surface, registered: () => true, reader: () => ({ async read() { return { status: 404, body: '' } }, closed: () => false }),
    api: api as never, operator: () => operator, cliPath: () => '/bin/claude', parentEnv: () => ({}),
    skillSteps: async () => (local === null ? null : local === 'none' ? { kind: 'none' } : local === 'too-large' ? { kind: 'too-large' } : { kind: 'text', text: local }),
  })
  const cards: string[] = []
  const tool = createBrowserWorkTool(input => wiring.work({
    companyId: COMPANY, conversationId: 'conv-1', companyRoot: '/company', site: input.site, task: input.task, skill: input.skill, said: input.said, values: input.values, items: input.items,
    signal: new AbortController().signal, onCard: id => cards.push(id),
  }), [HOST])
  const run = () => tool.execute({
    site: HOST, task: `一覧の行をコピーして登録する。${AI_ADDED}`, ...(skill !== null ? { skill } : {}),
    ...(o.said ? { said: o.said } : {}), ...(o.values ? { values: o.values } : {}),
  })
  /** Until the card's ［任せる］ can be pressed, then presses it. */
  const approveWhenReady = async () => {
    for (let i = 0; i < 200; i++) {
      const c = wiring.card(COMPANY, FRAME_RUN)
      if (c?.ok && c.view.phase === 'ready') return wiring.approve(COMPANY, FRAME_RUN, PLAN_HASH)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('the card never became ready')
  }
  return { wiring, calls, materials, cards, run, approveWhenReady, signOut: () => { user = null; wiring.clear() } }
}

const CLICK = '{"do":"click","ref":1}'
const DONE = '{"do":"done","result":"登録しました","unread":[]}'
const PLAN = JSON.stringify({ do: 'plan', summary: '元の行をコピーして【回】の名前で登録します', affects: 'なし', values: [{ label: 'コピー元', value: '【秋の回】' }], unread: [] })

test('with a Skill the operator works from the person\'s words and the sealed steps — never the consultation AI\'s own request', async () => {
  const w = world({ answers: [CLICK, DONE], needsApproval: false, seal: sealOf(STEPS), said: ['既存の行は変えない'], values: [{ label: '回', value: '【冬の回】' }] })
  const words = await w.run()
  assert.equal(words.startsWith(WW.done), true, words)
  for (const m of w.materials) {
    assert.equal(JSON.stringify(m).includes(AI_ADDED), false, 'the consultation AI\'s added stop condition never reaches the operator')
    assert.equal(m.request, null)
    assert.equal(m.steps, STEPS)
    assert.deepEqual(m.person, { said: ['既存の行は変えない'], values: [{ label: '回', value: '【冬の回】' }] })
    // The person's words come first, before the Skill's steps.
    const keys = Object.keys(m)
    assert.ok(keys.indexOf('person') < keys.indexOf('steps'), keys.join(','))
  }
  // The prompts rank the person's prohibitions over the steps, and name no AI-added source to follow.
  for (const p of [BROWSER_OPERATOR_WORK_PROMPT, BROWSER_OPERATOR_WORK_PREVIEW_PROMPT]) assert.match(p, /person\.said の禁止・制約は steps より先に守る/)
  // Without a Skill the request is all the operator has of the task.
  const adhoc = world({ answers: [PLAN.replace('"unread"', '"writes":[{"method":"POST","path":"/items","max":1}],"unread"'), CLICK, DONE], skill: null })
  const done = adhoc.run()
  await adhoc.approveWhenReady()
  await done
  assert.ok(String(adhoc.materials[0].request).includes(AI_ADDED))
  assert.equal(adhoc.materials[0].steps, null)
})

test('a Skill\'s steps that are not exactly the sealed text start nothing: changed, missing, too large, or no seal', async () => {
  const cases: Array<[Opts, keyof typeof WW.stoppedBy]> = [
    [{ answers: [], seal: sealOf(STEPS), local: `${STEPS}\n3. 手元で足した手順` }, 'steps-changed'],
    [{ answers: [], seal: sealOf(STEPS), local: 'none' }, 'steps-missing'],
    [{ answers: [], seal: sealOf(STEPS), local: null }, 'steps-missing'],
    [{ answers: [], seal: { state: 'too-large' }, local: STEPS }, 'steps-too-large'],
    [{ answers: [], seal: sealOf(STEPS), local: 'too-large' }, 'steps-too-large'],
    [{ answers: [], seal: undefined, local: STEPS }, 'steps-unsealed'],
    [{ answers: [], seal: { state: 'sealed', hash: 'sha256:short' }, local: STEPS }, 'steps-unsealed'],
    [{ answers: [], seal: { state: 'none' }, local: STEPS }, 'steps-changed'],
  ]
  for (const [o, why] of cases) {
    for (const needsApproval of [false, true]) {
      const w = world({ ...o, needsApproval })
      const words = await w.run()
      assert.equal(words, workWordsForAi({ kind: 'stopped', why }, [], []), `${why}: ${words}`)
      assert.equal(w.calls.some(c => c === 'runStart' || c.startsWith('step') || c === 'framePermit' || c === 'enter'), false, `${why}: nothing operated\n${w.calls.join('\n')}`)
      assert.ok(w.calls.includes('frameEnd'), 'the frames run is ended')
      // The card says why, in the fixed words.
      const card = w.wiring.card(COMPANY, FRAME_RUN)
      assert.ok(card?.ok && card.view.result?.headline === WW.stoppedBy[why], JSON.stringify(card))
      assert.deepEqual(w.cards, [FRAME_RUN])
    }
  }
  // The same text on both sides, or no steps on either: it starts.
  const same = world({ answers: [CLICK, DONE], needsApproval: false, seal: sealOf(STEPS) })
  assert.equal((await same.run()).startsWith(WW.done), true)
  const none = world({ answers: [CLICK, DONE], needsApproval: false, seal: { state: 'none' }, local: 'none' })
  assert.equal((await none.run()).startsWith(WW.done), true)
  assert.equal(none.materials[0].steps, null)
})

test('the core\'s seal: the text joined in one order, never cut; only the very same text passes', () => {
  const text = browserSkillStepsText([{ name: 'site-notes.md', text: 'B' }, { name: 'SKILL.md', text: 'A' }])
  assert.deepEqual(text, { kind: 'text', text: '# SKILL.md\nA\n\n# site-notes.md\nB' })
  assert.deepEqual(browserSkillStepsText([]), { kind: 'none' })
  assert.deepEqual(browserSkillStepsText([{ name: 'SKILL.md', tooLarge: true }]), { kind: 'too-large' })
  assert.deepEqual(browserSkillStepsText([{ name: 'SKILL.md', text: 'x'.repeat(BROWSER_SKILL_STEPS_LIMITS.chars) }]), { kind: 'too-large' })
  assert.deepEqual(browserSkillStepsText([{ name: 'SKILL.md', text: 'A' }, { name: 'SKILL.md', text: 'A' }]), { kind: 'too-large' })
  const seal = browserSkillStepsSeal(text, sha)
  assert.deepEqual(browserSkillStepsCheck(seal, text, sha), { ok: true, steps: '# SKILL.md\nA\n\n# site-notes.md\nB' })
  assert.deepEqual(browserSkillStepsCheck(seal, { kind: 'text', text: '# SKILL.md\nA' }, sha), { ok: false, problem: 'steps-changed' })
  assert.deepEqual(browserSkillStepsCheck({ ...seal, extra: 1 }, text, sha), { ok: false, problem: 'steps-unsealed' })
  assert.equal(readBrowserSkillStepsSeal({ state: 'none', hash: 'x' }), null)
  assert.deepEqual(browserSkillStepsCheck({ state: 'none' }, null, sha), { ok: true, steps: null })
})

test('the plan the person approved on the preview\'s card is the work\'s material; a pre-approved Skill\'s work says there was no preview', async () => {
  const w = world({ answers: [PLAN, CLICK, DONE], needsApproval: true, seal: sealOf(STEPS) })
  const done = w.run()
  await w.approveWhenReady()
  assert.equal((await done).startsWith(WW.done), true)
  assert.equal('plan' in w.materials[0], false, 'the preview has no plan of its own yet')
  for (const m of w.materials.slice(1)) {
    assert.deepEqual(m.plan, { summary: '元の行をコピーして【回】の名前で登録します', affects: 'なし', values: [{ label: 'コピー元', value: '【秋の回】' }] })
  }
  const pre = world({ answers: [CLICK, DONE], needsApproval: false, seal: sealOf(STEPS) })
  await pre.run()
  assert.equal(pre.calls.includes('step work-preview'), false)
  for (const m of pre.materials) assert.equal(m.plan, null)
  for (const p of [BROWSER_OPERATOR_WORK_PROMPT]) assert.match(p, /null は下見なし/)
})

test('a stopped card shows the screen the operator stopped on — in memory only, beside what it asks, never to an AI, the server or the site', async () => {
  const QUESTION = '同じ名前の行がもうあります。続けてよいですか？'
  // The preview stops to ask: the stopped preview's card (bo_) carries the screen of that step.
  const preview = world({ answers: [JSON.stringify({ do: 'stop', why: 'need-person', unread: [], question: QUESTION })], seal: sealOf(STEPS) })
  const words = await preview.run()
  const view = preview.wiring.previewCard('u-1', COMPANY, RUN)
  assert.equal(view?.next?.kind, 'decide')
  assert.equal(Buffer.from(view!.screen!.base64, 'base64').toString(), `${SCREEN}-1`)
  // The renderer takes it in its shape.
  assert.deepEqual(readBrowserInspectionView(JSON.parse(JSON.stringify(view)))?.screen, view!.screen)
  // The work stops to ask (pre-approved, before any write): the write card (bf_) carries the screen of its last step.
  const work = world({ answers: ['{"do":"wait","seconds":1}', JSON.stringify({ do: 'stop', why: 'need-person', unread: [], question: QUESTION })], needsApproval: false, seal: sealOf(STEPS) })
  const workWords = await work.run()
  const card = work.wiring.card(COMPANY, FRAME_RUN)
  assert.ok(card?.ok)
  assert.equal(Buffer.from(card.view.screen!.base64, 'base64').toString(), `${SCREEN}-2`)
  assert.deepEqual(readBrowserWriteView(JSON.parse(JSON.stringify(card.view)), readBrowserCard)?.screen, card.view.screen)
  // Never the consultation AI's words, any call to the server or the site.
  for (const [w, said] of [[preview, words], [work, workWords]] as const) {
    const encoded = Buffer.from(`${SCREEN}-`).toString('base64').slice(0, 12)
    for (const where of [said, w.calls.join('\n')]) {
      assert.equal(where.includes(SCREEN), false)
      assert.equal(where.includes(encoded), false)
    }
  }
  // A stop that asks nothing carries none; neither does a finished run.
  const blocked = world({ answers: ['{"do":"stop","why":"blocked","unread":[]}'], needsApproval: false, seal: sealOf(STEPS) })
  await blocked.run()
  const b = blocked.wiring.card(COMPANY, FRAME_RUN)
  assert.ok(b?.ok && b.view.screen === undefined)
  // Sign-out: the cards and their screens are gone (memory only).
  work.signOut()
  preview.signOut()
  assert.equal(work.wiring.card(COMPANY, FRAME_RUN), null)
  assert.equal(preview.wiring.previewCard('u-1', COMPANY, RUN), undefined)
})

test('the renderer takes a stop screen only in its exact shape and beside what the card asks', () => {
  const ok = { mediaType: 'image/jpeg', base64: Buffer.from('jpeg').toString('base64') }
  assert.deepEqual(readBrowserStopScreen(ok), ok)
  for (const bad of [
    { ...ok, mediaType: 'image/png' }, { ...ok, extra: 1 }, { mediaType: 'image/jpeg', base64: 'not base64!' }, { mediaType: 'image/jpeg', base64: '' },
    { mediaType: 'image/jpeg', base64: 'abc' }, { mediaType: 'image/jpeg', base64: 'A'.repeat(BROWSER_STOP_SCREEN_MAX + 4) }, null, 'x',
  ]) assert.equal(readBrowserStopScreen(bad), null, JSON.stringify(bad)?.slice(0, 80))
  // Main keeps none for an empty or overlong image.
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  assert.equal(browserStopScreen({ mediaType: 'image/jpeg', data: new Uint8Array() }, b64), null)
  assert.equal(browserStopScreen({ mediaType: 'image/jpeg', data: new Uint8Array(BROWSER_STOP_SCREEN_MAX) }, b64), null)
  // Without a `next` the view's reader leaves the screen off.
  const view = { card: { title: 't', state: 'not_read', headline: 'h', sections: [], checks: [], notes: [] }, readAt: '2026-11-28T00:00:00.000Z', siteLabel: HOST, screen: ok }
  assert.equal(readBrowserInspectionView(view)?.screen, undefined)
  assert.deepEqual(readBrowserInspectionView({ ...view, next: { kind: 'login' } })?.screen, ok)
})

test('the tool takes the person\'s words only in their shape', async () => {
  assert.deepEqual(workPersonOf(undefined, undefined), { said: [], values: [] })
  assert.deepEqual(workPersonOf(['既存は変えない\n登録の前で止めて'], [{ label: '回', value: '' }]), { said: ['既存は変えない\n登録の前で止めて'], values: [{ label: '回', value: '' }] })
  for (const [said, values] of [
    ['x', undefined], [[''], undefined], [['a'.repeat(301)], undefined], [Array(11).fill('a'), undefined], [['a\u0000'], undefined],
    [undefined, [{ label: '', value: 'v' }]], [undefined, [{ label: 'l', value: 'v', extra: 1 }]], [undefined, [{ label: 'l', value: 1 }]],
    [undefined, Array(17).fill({ label: 'l', value: 'v' })], [undefined, [{ label: 'a'.repeat(41), value: 'v' }]], [undefined, [{ label: 'l', value: 'v'.repeat(201) }]],
  ] as const) assert.equal(workPersonOf(said, values), null, JSON.stringify([said, values]))
  let ran = false
  const tool = createBrowserWorkTool(async () => { ran = true; return { words: 'x' } }, [HOST])
  assert.equal(await tool.execute({ site: HOST, task: 't', said: 'not a list' }), WW.badInput)
  assert.equal(ran, false)
})

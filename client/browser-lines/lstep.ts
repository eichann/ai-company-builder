/**
 * Opened lines on Lステップ's map (「開けた1行」, generalization PR 3; agent-browser.md "The first map and the inspection
 * line"). Reviewed data: each is written into `shared/browser-connectors/opened.json` as `pending` by
 * `client/scripts/browser-opened.ts`, and only a reviewed edit approves it. Imports nothing but the core's types.
 *
 * `landing_inspect` — 「流入経路を点検する」 (design memo §7-3, read only): a route someone made by copying another, and the
 * route it was copied from, both chosen from what the site showed (`target` ← `site_fact`, §16-4: the card shows the
 * source's name as read). It reads the route, its row in its folder's list (the friend-add and QR addresses), its
 * action, the source and the source's action; and checks, with the core's words only:
 * - the route equals its source but for its name, the end of its reception and its action;
 * - its action is not the source's (a copy still pointing at its original's action is the most common accident, stage 0
 *   R3) and its tags differ from the source's (the tag left as the previous round's);
 * - its action equals the source's but for its name and its tags (the cancels and templates kept, by number).
 * No business word is here: which date a name or a tag must carry is a business plugin's line (§16-2, §17-1), once the
 * value's source (a bound record field or the person's confirmation, §16-4) can be supplied — a later PR.
 *
 * `step_template_add` — 「リマインダの段にテンプレートを足す」 (generalization PR 6, design memo §6: today's only write of the
 * old path, `lstep@0.6.x` `reminder_step_add_template`, as map + one line — the proof the model fits). **Written
 * `pending`; it stays so until the owner's test write (PR 7).** The old path is unchanged and keeps working beside it; both
 * take the same lock key for the step (`browserLineWriteLocks` = the old `browserLockKey`).
 * - values: the reminder, the step, the template and the template's folder — all ids the site showed (`target` ←
 *   `site_fact`, §16-4: an object's id is a site fact; the person approves the whole card, as on the old path);
 * - reads: the reminder (its name; not hidden), the step (its templates, on the reminder's page), the step's timing (the
 *   site's own words) and the template to add (its name and body; text only), all under the LINE account;
 * - one write: `add_child(step.templates, template)` — the generic prediction: exactly that template once more on that
 *   step, every other field of every read unchanged; the reads made again after the write must equal it exactly;
 * - the map's must-hold facts apply whatever the line says: the account on every read, the step and its timing in this
 *   reminder, and the shared-reminder note on the card (`reminder_step`'s note, the old declaration's `shared` words).
 * No check word: the old type had none either (memo §6); a business rule (which template for which round) is a business
 * plugin's line later.
 *
 * `landing_create` — 「流入経路を複製して作る」 (generalization PR 8, design memo §7 as stage 0 found it). **Written
 * `pending`; it stays so until the owner's read-only confirmations and one test write on the test route** (memo §15 C2:
 * what creating sets off is the map's reviewed promise, tried once on a test object). Generic: copy a route, with its
 * name, the end of its reception and its action replaced by a copy whose tag is replaced:
 * - values: the source route and the tag — ids the site showed (`target` ← `site_fact`, §16-4; the card shows the tag's
 *   name) — and the new name, the end's day and time — each confirmed by the person on the card (`write` ← `person`;
 *   owner decision on #826: which round, and so these values, only from a person for now; never the AI alone);
 * - reads: the source route, its action (by the route's `action_id`) and the tag, all under the LINE account;
 * - writes: (1) register a new action, the source's with exactly the tag (`create_from(source_action_set, { tags })`);
 *   (2) create the route, the source's with the name, the end and **the action write 1 created** (`create_from(source,
 *   { name, to_date, to_time, action_id: created })`). A stop after (1) leaves a registered action nothing points at
 *   (§4-1: stage 0 R1). Neither touches what existed: the source route and its action must read the same after;
 * - the judgement (`judgeBrowserWrites`): each created object read by the id the site gave must be exactly its original
 *   with the set fields; the new route's action is the new action, never the source's (a copy still on its original's
 *   action is stage 0's most common accident), and the tag must differ from the source action's tags before anything is
 *   sent (`browserWritesPlanProblem`).
 * No business word: which round, which date in the name or the tag, which end time are a business plugin's line (§16-2).
 */
import type { BrowserOpenedLine } from '../../shared/core/browser-opened'

export const LINES: readonly BrowserOpenedLine[] = [
  {
    name: 'landing_inspect',
    version: '1.0.0',
    label: '流入経路を点検する',
    read: {
      site: 'lstep',
      values: {
        landing: { kind: 'id', role: 'target', from: ['site_fact'] },
        source: { kind: 'id', role: 'target', from: ['site_fact'] },
      },
      reads: [
        { name: 'landing', thing: 'landing', id: { value: 'landing' } },
        { name: 'landing_row', thing: 'landing_row', id: { read: 'landing', field: 'id' } },
        { name: 'action_set', thing: 'action_set', id: { read: 'landing', field: 'action_id' } },
        { name: 'source', thing: 'landing', id: { value: 'source' } },
        { name: 'source_action_set', thing: 'action_set', id: { read: 'source', field: 'action_id' } },
      ],
      checks: [
        { word: 'unchanged_except', read: 'landing', reference: 'source', except: ['name', 'to_date', 'to_time', 'action_id'] },
        { word: 'changed_from', read: 'landing', reference: 'source', fields: ['action_id'] },
        { word: 'changed_from', read: 'action_set', reference: 'source_action_set', fields: ['tags'] },
        { word: 'unchanged_except', read: 'action_set', reference: 'source_action_set', except: ['name', 'tags'] },
      ],
    },
    readLabels: {
      landing: '点検する流入経路',
      landing_row: '点検する流入経路（一覧の行）',
      action_set: '点検する流入経路のアクション',
      source: '複製元の流入経路',
      source_action_set: '複製元のアクション',
    },
    show: [
      { read: 'landing', fields: ['name', 'to_date', 'to_time'] },
      { read: 'landing_row', fields: ['follow_url', 'qr_url'] },
      { read: 'action_set', fields: ['tags', 'templates', 'stops'] },
      { read: 'source', fields: ['name', 'to_date', 'to_time'] },
      { read: 'source_action_set', fields: ['tags'] },
    ],
  },
  {
    name: 'step_template_add',
    version: '1.0.0',
    label: 'リマインダの段にテンプレートを足す',
    read: {
      site: 'lstep',
      values: {
        reminder: { kind: 'id', role: 'target', from: ['site_fact'] },
        step: { kind: 'id', role: 'target', from: ['site_fact'] },
        template_folder: { kind: 'id', role: 'target', from: ['site_fact'] },
        template: { kind: 'id', role: 'target', from: ['site_fact'] },
      },
      reads: [
        { name: 'reminder', thing: 'reminder', id: { value: 'reminder' } },
        { name: 'step', thing: 'reminder_step', id: { value: 'step' }, parent: { value: 'reminder' } },
        { name: 'timing', thing: 'step_timing', id: { read: 'step', field: 'step' }, parent: { value: 'reminder' } },
        { name: 'template', thing: 'template', id: { value: 'template' }, parent: { value: 'template_folder' } },
      ],
      checks: [],
    },
    writes: [{ read: 'step', verb: 'add_child', field: 'templates', value: 'template' }],
    readLabels: {
      reminder: 'リマインダ',
      step: 'テンプレートを足す段',
      timing: '段の時刻',
      template: '足すテンプレート',
    },
    show: [
      { read: 'reminder', fields: ['name'] },
      { read: 'step', fields: ['templates'] },
      { read: 'timing', fields: ['timing'] },
      { read: 'template', fields: ['name', 'body'] },
    ],
  },
  {
    name: 'landing_create',
    version: '1.0.0',
    label: '流入経路を複製して作る',
    read: {
      site: 'lstep',
      values: {
        source: { kind: 'id', role: 'target', from: ['site_fact'] },
        tag: { kind: 'id', role: 'target', from: ['site_fact'] },
        name: { kind: 'text', role: 'write', from: ['person'] },
        to_date: { kind: 'date', role: 'write', from: ['person'] },
        to_time: { kind: 'time', role: 'write', from: ['person'] },
      },
      reads: [
        { name: 'source', thing: 'landing', id: { value: 'source' } },
        { name: 'source_action_set', thing: 'action_set', id: { read: 'source', field: 'action_id' } },
        { name: 'tag', thing: 'tag', id: { value: 'tag' } },
      ],
      checks: [],
    },
    writes: [
      { read: 'source_action_set', verb: 'create_from', set: { tags: { value: 'tag' } }, as: 'new_action_set' },
      {
        read: 'source', verb: 'create_from', as: 'new_landing',
        set: { name: { value: 'name' }, to_date: { value: 'to_date' }, to_time: { value: 'to_time' }, action_id: { created: 'new_action_set' } },
      },
    ],
    readLabels: {
      source: '複製元の流入経路',
      source_action_set: '複製元のアクション',
      tag: '新しいアクションでつけるタグ',
    },
    show: [
      { read: 'source', fields: ['name', 'to_date', 'to_time'] },
      { read: 'source_action_set', fields: ['tags', 'templates', 'stops'] },
      { read: 'tag', fields: ['name'] },
    ],
  },
]

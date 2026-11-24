/**
 * Lステップ's map 1.0.2 (「サイトの地図」, generalization PR 3, completed in PR 4, extended in PR 6; agent-browser.md "The first map and the
 * inspection line"). Reviewed data. Its things and every key of their JSON answers are exactly what stage 0 recorded
 * (2026-11-24, read only, the owner's login: 「ブラウザ操作の汎用化_段0の結果」 R4, R8, R10, R11) and, for 1.0.1, the full
 * key sets confirmed afterwards (same day, 「追記2：項目の全部の確かめ」: four routes — the 11/12, 11/19 and 11/26 rounds' and
 * the test route —, 47 list rows, four actions; 0 writes) — key names and kinds only, no value was kept.
 *
 * This folder is NOT `client/connectors/lstep/`: that folder's fingerprint is the approved `lstep@0.6.x` checker hash
 * (approved.json), and the old path stays exactly as approved (design memo §8, §15 C10). The map has its own version and
 * its own hashes in `shared/browser-connectors/opened.json`.
 *
 * - `landing` (流入経路) — `GET /api/landings/<id>`: exactly 19 keys (追記2). The answer carries no id of its own (R11), so
 *   its id is the address's (`id_from: address`). `group_id` is a number or null (the test route sits in no folder);
 *   `from_date` / `from_time` were empty strings everywhere, `to_date` / `to_time` `YYYY-MM-DD` / `HH:MM` or empty strings
 *   (no end); `latitude` / `longitude` / `radius` null; `custom_params` an empty list on all four (its items' keys are the
 *   ones R11 named; an item of another shape is not read). `action_texts` is not compared (`ignored`: the action itself
 *   is read as `action_set`), nor a variable's display `name` (only which variables are carried, `params`).
 * - `landing_row` (流入経路の一覧の行) — one entry of `GET /api/landings?group=<folder>&page=<n>` (50 a page, R8): the
 *   friend-add and QR addresses live only there (R10). Exactly 17 keys (追記2); the ones the card does not use are
 *   `ignored` (counters, order, dates of the row, the folder object `group` {id, name, order}, the action's texts). The
 *   list's envelope keys are in `LSTEP_MAP_READS` for the reading code (later PR).
 * - `action_set` (アクション) — `GET /api/actions/<id>`: exactly 6 keys (追記2): `inputs` (type 13 adds tags `tag_ids`,
 *   numbers; type 12 sends a template `egg_id`, a string; type 15 stops a reminder `episode_id`, a string, + `firetype`;
 *   each input also carries `member_query_id` / `send_member_query_id`, null everywhere seen — the reader takes only
 *   null: a condition on who receives it is never compared away), `a_name`, `a_twice_type`, and — not compared — `aid`
 *   (equal to the number asked on all four, still unused: the id is the address's), `funnel_descriptions` (an empty
 *   object), `group_id` (null).
 *
 * Must-hold facts (§15 C5): every thing is bound to the logged-in LINE account (`account`: the `lm-account-id` marker
 * read before and after the reads); an action carries the site's warning that actions can be shared (R3: three actions
 * were used by several routes, one by eight).
 *
 * **1.0.2** (PR 6, design memo §6: today's 「リマインダの段にテンプレートを足す」 as map + one line) adds what that operation
 * reads and writes — only key names the old path's readers recorded from the owner's read-only windows (design memo
 * §34–§36, §39–§41; `client/connectors/lstep/`), no value. Their **full key sets are not confirmed yet** (the old readers
 * are lenient: they read the keys they need and pass others): strict read then stops on a real answer with a key more
 * (availability, never a wrong write) until a read-only confirmation lists them — part of approving the line (PR 7).
 * - `reminder` (リマインダ) — `GET /api/episodes/<id>` (§39): `id`, `name`, `hid_at` (must be null: a hidden reminder is
 *   not read), `steps[]` with `id` and `episode_id` (each must name this reminder); `order`, `type` and every other key of
 *   a step (`order`, `step_days`, `step_time`, `step_type`, `step_minutes`, `skip`, `initial`, `egg_id`,
 *   `member_query_id`, `action_id`) not compared — their meaning is not confirmed; the step's timing is read as the
 *   site's own text (`step_timing`).
 * - `reminder_step` (リマインダの段) — an **html** thing: the step's attached templates are only in the reminder's page
 *   `GET /line/episode/show/<reminder>` (§41: the rows of `#template_confirm_<step>`, each with its `openModal(…)` and
 *   delete form; plus slots in the step's box, the 11/20 capture). Its reader is the old path's checker `view`, unchanged
 *   (`readers.ts`: the same reading the old path approves, memo §16-7 R3). `templates` is the step's template ids in any
 *   order, each as often (the same template may stand in two holes). Bound to the account and to its reminder; it carries
 *   the old declaration's `shared` note word for word; its one write is `add_child(templates)` and it `delivers`
 *   `scheduled` (memo §37: the owner who runs Lステップ — people who have the step's time still ahead, at that time).
 * - `step_timing` (段の時刻) — `GET /api/episode-steps/<step>` (§40): `episode_step_id` (its id), `episode_id` (its
 *   reminder), `step_timing_text` (the site's own words, never parsed); `episode_group_id`, `episode_name` not compared.
 * - `template_folder` (テンプレートのフォルダ) — one entry of `GET /api/template-groups` (§36): `id` (「未分類」 is `0`, §40),
 *   `name`; `order`, `item_count` not compared. Named as a template's parent only.
 * - `template` (テンプレート) — one entry of `GET /api/templates?group=<folder>&page=<n>` (§34, §36, §40): `id`, `name`,
 *   `content_text` (its body), `form_type` (only 8, text: any other kind is not read — the old path's rule, kept in the
 *   reader), `group` (`{ id, name }`, or null in 「未分類」, read as folder `0`: listed `optional` so the core lets it be null — the
 *   reader still requires it); `created_at`, `editor_version`, the
 *   folder's `name` not compared.
 *
 * Never read: `GET /api/landings/<id>?copy=1` (it may create something on the site's side; stage 0 never called it) —
 * no read here carries a query but the folder list's own `group` and `page` (`LSTEP_MAP_READS`, tested).
 */
import type { BrowserMap } from '../../../shared/core/browser-map'

export const LSTEP_MAP: BrowserMap = {
  site: 'lstep',
  version: '1.0.2',
  account: { label: 'LINE アカウント' },
  things: {
    landing: {
      label: '流入経路', answer: 'json', id: 'id', id_from: 'address',
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: '名前' },
        qr_text: { kind: 'text', label: 'QR コードの文字', nullable: true },
        action_id: { kind: 'id', label: 'アクション' },
        prevent_default: { kind: 'flag', label: '既定の動きを止める' },
        only_welcome: { kind: 'flag', label: '初めての友だちだけ' },
        cv_head: { kind: 'text', label: '計測のタグ（head）', nullable: true },
        cv_body: { kind: 'text', label: '計測のタグ（body）', nullable: true },
        group_id: { kind: 'id', label: 'フォルダ', nullable: true },
        from_date: { kind: 'date', label: '受付の始まりの日', nullable: true },
        from_time: { kind: 'time', label: '受付の始まりの時刻', nullable: true },
        to_date: { kind: 'date', label: '受付の終わりの日', nullable: true },
        to_time: { kind: 'time', label: '受付の終わりの時刻', nullable: true },
        out_of_period_message: { kind: 'text', label: '受付の期間外の文', nullable: true },
        latitude: { kind: 'number', label: '緯度', nullable: true },
        longitude: { kind: 'number', label: '経度', nullable: true },
        radius: { kind: 'number', label: '半径', nullable: true },
        params: { kind: 'id_set', label: '引き継ぐ値' },
        only_once_param_sync: { kind: 'flag', label: '値の引き継ぎは1回だけ' },
      },
      keys: {
        name: 'required', qr_text: 'required', action_id: 'required', action_texts: 'ignored', prevent_default: 'required',
        only_welcome: 'required', cv_head: 'required', cv_body: 'required', group_id: 'required', from_date: 'required',
        from_time: 'required', to_date: 'required', to_time: 'required', out_of_period_message: 'required',
        latitude: 'required', longitude: 'required', radius: 'required', custom_params: 'required',
        'custom_params[].var_id': 'required', 'custom_params[].name': 'ignored', only_once_param_sync: 'required',
      },
      must_hold: { account: true },
    },
    landing_row: {
      label: '流入経路の一覧の行', answer: 'json', id: 'id',
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: '名前' },
        follow_url: { kind: 'text', label: '友だち追加の URL' },
        qr_url: { kind: 'text', label: 'QR コードの URL' },
        validity_period_from: { kind: 'text', label: '受付の始まり（一覧）', nullable: true },
        validity_period_to: { kind: 'text', label: '受付の終わり（一覧）', nullable: true },
      },
      keys: {
        id: 'required', name: 'required', follow_url: 'required', qr_url: 'required',
        validity_period_from: 'required', validity_period_to: 'required',
        created_at: 'ignored', updated_at: 'ignored', counter: 'ignored', counter_member: 'ignored', order: 'ignored',
        only_welcome: 'ignored', prevent_default: 'ignored', action_texts: 'ignored', action_twice_type: 'ignored',
        custom_params_script_tag: 'ignored', group: 'ignored', 'group.id': 'ignored', 'group.name': 'ignored', 'group.order': 'ignored',
      },
      must_hold: { account: true },
    },
    action_set: {
      label: 'アクション', answer: 'json', id: 'id', id_from: 'address',
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: 'アクションの名前', nullable: true },
        twice: { kind: 'text', label: '2回目以降の動き', nullable: true },
        tags: { kind: 'id_set', label: 'つけるタグ' },
        templates: { kind: 'id_list', label: '送るテンプレート' },
        stops: { kind: 'id_set', label: '止めるリマインダ（番号_止め方）' },
      },
      keys: {
        inputs: 'required', 'inputs[].type': 'required', 'inputs[].tag_ids': 'optional', 'inputs[].egg_id': 'optional',
        'inputs[].episode_id': 'optional', 'inputs[].firetype': 'optional',
        'inputs[].member_query_id': 'required', 'inputs[].send_member_query_id': 'required',
        aid: 'ignored', a_twice_type: 'required', a_name: 'required', funnel_descriptions: 'ignored', group_id: 'ignored',
      },
      must_hold: {
        account: true,
        note: 'アクションは、ほかの流入経路と共有されていることがあります。同じアクションを指す流入経路は、どれも同じ動きをします。',
      },
    },
    reminder: {
      label: 'リマインダ', answer: 'json', id: 'id',
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: 'リマインダの名前' },
        steps: { kind: 'id_set', label: '段' },
      },
      keys: {
        id: 'required', name: 'required', hid_at: 'required', order: 'ignored', type: 'ignored', steps: 'required',
        'steps[].id': 'required', 'steps[].episode_id': 'required', 'steps[].order': 'ignored', 'steps[].step_days': 'ignored',
        'steps[].step_time': 'ignored', 'steps[].step_type': 'ignored', 'steps[].step_minutes': 'ignored', 'steps[].skip': 'ignored',
        'steps[].initial': 'ignored', 'steps[].egg_id': 'ignored', 'steps[].member_query_id': 'ignored', 'steps[].action_id': 'ignored',
      },
      must_hold: { account: true },
    },
    reminder_step: {
      label: 'リマインダの段', answer: 'html', id: 'step', id_from: 'address',
      parent: { thing: 'reminder', field: 'reminder' },
      fields: {
        step: { kind: 'id', label: '段の番号' },
        reminder: { kind: 'id', label: 'リマインダ' },
        templates: { kind: 'id_set', label: '段のテンプレート' },
      },
      writes: { add_child: { templates: 'template' } },
      delivers: 'scheduled',
      must_hold: {
        account: true,
        parent: true,
        note: '全部の回で共有のリマインダです。ほかの回でも、この段をまだ迎えていない人に届きます（もう過ぎた人には届きません）。',
      },
    },
    step_timing: {
      label: '段の時刻', answer: 'json', id: 'step',
      parent: { thing: 'reminder', field: 'reminder' },
      fields: {
        step: { kind: 'id', label: '段の番号' },
        reminder: { kind: 'id', label: 'リマインダ' },
        timing: { kind: 'text', label: '段の時刻（サイトの表示）' },
      },
      keys: {
        episode_step_id: 'required', episode_id: 'required', step_timing_text: 'required',
        episode_group_id: 'ignored', episode_name: 'ignored',
      },
      must_hold: { account: true, parent: true },
    },
    template_folder: {
      label: 'テンプレートのフォルダ', answer: 'json', id: 'id',
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: 'フォルダの名前' },
      },
      keys: { id: 'required', name: 'required', order: 'ignored', item_count: 'ignored' },
      must_hold: { account: true },
    },
    template: {
      label: 'テンプレート', answer: 'json', id: 'id',
      parent: { thing: 'template_folder', field: 'folder' },
      fields: {
        id: { kind: 'id', label: '番号' },
        folder: { kind: 'id', label: 'フォルダ' },
        name: { kind: 'text', label: 'テンプレートの名前' },
        body: { kind: 'text', label: '本文' },
      },
      keys: {
        id: 'required', name: 'required', content_text: 'required', form_type: 'required', group: 'optional',
        'group.id': 'required', 'group.name': 'ignored', created_at: 'ignored', editor_version: 'ignored',
      },
      must_hold: { account: true, parent: true },
    },
  },
}

/**
 * How each thing is read (mechanics: the reading code of a later PR follows exactly these; hashed with this folder).
 * GET only, fixed paths, `{id}` filled with a plain id; the list's query is `group` (the landing's folder) and `page`
 * (1..10, the app's, never the AI's). Nothing else — never `?copy=1`. The account is the `lm-account-id` marker every
 * page of the site carries (confirmed 6b-1, agent-browser.md "The account"); which page the reading code reads it from
 * is chosen with that code.
 */
export const LSTEP_MAP_READS = {
  landing: { path: '/api/landings/{id}' },
  landing_row: {
    path: '/api/landings', query: ['group', 'page'], pages: { param: 'page', max: 10, perPage: 50 },
    // The list's envelope around `data` (追記2), for the reading code: anything else around the rows is not read.
    envelope: ['current_page', 'data', 'first_page_url', 'from', 'last_page', 'last_page_url', 'links', 'next_page_url', 'path',
      'per_page', 'prev_page_url', 'to', 'total'],
    envelopeLinkKeys: ['url', 'label', 'page', 'active'],
  },
  action_set: { path: '/api/actions/{id}' },
  // 1.0.2 (PR 6). The template list's envelope is not confirmed whole (the old reader names `current_page`, `data`,
  // `last_page`, `per_page`, `total` among others): `envelope: null` until a read-only confirmation lists it (PR 7) —
  // the reading code reads no list whose envelope the map does not name.
  reminder: { path: '/api/episodes/{id}' },
  reminder_step: { path: '/line/episode/show/{parent}', html: true },
  step_timing: { path: '/api/episode-steps/{id}' },
  template_folder: { path: '/api/template-groups', list: 'data' },
  template: { path: '/api/templates', query: ['group', 'page'], pages: { param: 'page', max: 10, perPage: 50 }, folderFrom: 'parent', envelope: null },
} as const

/**
 * How each write of the map is sent (mechanics, 1.0.2; hashed with this folder): the old declaration's one write, word for
 * word (`lstep@0.6.3`: captured on test objects 2026-11-20, its form seen again in §40). `{id}` is the written object's
 * id, `{value}` the id the line adds; `_token` / `_lm_user_id` are the page's own values the reading code takes, never
 * compared. Nothing sends with it yet: the app's writing path is a later PR, behind the server's gate.
 */
export const LSTEP_MAP_WRITES = {
  reminder_step: {
    add_child: {
      templates: {
        method: 'POST', path: '/line/episode/step/pack/template', form: { content_id: '{id}', template_id: '{value}' },
        ignore_body: ['_token', '_lm_user_id'],
      },
    },
  },
} as const

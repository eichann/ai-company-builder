/**
 * Lステップ's map 1.0.0 (「サイトの地図」, generalization PR 3; agent-browser.md "The first map and the inspection line").
 * Reviewed data. Its things and every key of their JSON answers are exactly what stage 0 recorded (2026-11-24, read only,
 * the owner's login: 「ブラウザ操作の汎用化_段0の結果」 R4, R8, R10, R11) — key names only, no value was kept.
 *
 * This folder is NOT `client/connectors/lstep/`: that folder's fingerprint is the approved `lstep@0.6.x` checker hash
 * (approved.json), and the old path stays exactly as approved (design memo §8, §15 C10). The map has its own version and
 * its own hashes in `shared/browser-connectors/opened.json`.
 *
 * - `landing` (流入経路) — `GET /api/landings/<id>`. The answer carries no id of its own (R11), so its id is the address's
 *   (`id_from: address`). `action_texts` is not compared (`ignored`: the action itself is read as `action_set`), nor a
 *   variable's display `name` (only which variables are carried, `params`).
 * - `landing_row` (流入経路の一覧の行) — one entry of `GET /api/landings?group=<folder>&page=<n>` (50 a page, R8): the
 *   friend-add and QR addresses live only there (R10). Stage 0 recorded the row's keys **in part** ("incl."): a row with
 *   more keys is not read whole and the card says 「読み取れませんでした」 for the URL until a reviewed map version lists
 *   them (availability, never a guess). The row is found by its `id` in the landing's folder (the reading code, later PR).
 * - `action_set` (アクション) — `GET /api/actions/<id>`: `inputs` (type 13 adds tags `tag_ids`, type 12 sends a template
 *   `egg_id`, type 15 stops a reminder `episode_id` + `firetype`; R4), `a_name`, `a_twice_type`, and — not compared —
 *   `aid`, `funnel_descriptions`, `group_id`. Stage 0 recorded the top keys as these "and others": the same rule as the
 *   row. Its id is the address's: whether `aid` is that number is not confirmed, so `aid` is never used.
 *
 * Must-hold facts (§15 C5): every thing is bound to the logged-in LINE account (`account`: the `lm-account-id` marker
 * read before and after the reads); an action carries the site's warning that actions can be shared (R3: three actions
 * were used by several routes, one by eight).
 *
 * Never read: `GET /api/landings/<id>?copy=1` (it may create something on the site's side; stage 0 never called it) —
 * no read here carries a query but the folder list's own `group` and `page` (`LSTEP_MAP_READS`, tested).
 */
import type { BrowserMap } from '../../../shared/core/browser-map'

export const LSTEP_MAP: BrowserMap = {
  site: 'lstep',
  version: '1.0.0',
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
        aid: 'ignored', a_twice_type: 'required', a_name: 'required', funnel_descriptions: 'ignored', group_id: 'ignored',
      },
      must_hold: {
        account: true,
        note: 'アクションは、ほかの流入経路と共有されていることがあります。同じアクションを指す流入経路は、どれも同じ動きをします。',
      },
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
  landing_row: { path: '/api/landings', query: ['group', 'page'], pages: { param: 'page', max: 10, perPage: 50 } },
  action_set: { path: '/api/actions/{id}' },
} as const

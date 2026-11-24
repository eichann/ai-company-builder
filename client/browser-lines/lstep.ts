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
]

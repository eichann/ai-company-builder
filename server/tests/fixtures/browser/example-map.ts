/**
 * AN EXAMPLE MAP for the read-side words' tests (generalization PR 2) — not a reviewed map, used by nothing but tests.
 * Its shape follows what stage 0 (2026-11-24, read only) saw of a landing route's JSON (key names only, no value) so the
 * words are tried on a realistic shape; the reviewed map and its readers come with PR 3, in the connector's folder.
 * Every name here is a site's or a business's word, which is exactly why none of them may appear in the new core
 * modules (`browser-read-words.test.ts` "the new core modules name no site, thing or field").
 */
import type { BrowserMap } from '../../../../shared/core/browser-map'
import type { BrowserReadLine } from '../../../../shared/core/browser-read-line'

export const EXAMPLE_MAP: BrowserMap = {
  site: 'example_site',
  version: '1.0.0',
  things: {
    landing_folder: {
      label: '流入経路のフォルダ', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
    },
    landing: {
      label: '流入経路', answer: 'json', id: 'id',
      parent: { thing: 'landing_folder', field: 'group_id' },
      fields: {
        id: { kind: 'id', label: '番号' },
        name: { kind: 'text', label: '名前' },
        group_id: { kind: 'id', label: 'フォルダ' },
        action_id: { kind: 'id', label: 'アクション' },
        to_date: { kind: 'date', label: '受付の終わりの日', nullable: true },
        to_time: { kind: 'time', label: '受付の終わりの時刻', nullable: true },
        prevent_default: { kind: 'flag', label: '既定の動きを止める' },
        param_vars: { kind: 'id_set', label: '引き継ぐ値' },
      },
      keys: {
        id: 'required', name: 'required', group_id: 'required', action_id: 'required', to_date: 'required', to_time: 'required',
        prevent_default: 'required', custom_params: 'optional', 'custom_params[].var_id': 'required', 'custom_params[].name': 'ignored',
        qr_text: 'ignored', updated_at: 'ignored',
      },
    },
    tag: {
      label: 'タグ', answer: 'json', id: 'id',
      fields: { id: { kind: 'id', label: '番号' }, name: { kind: 'text', label: '名前' } },
      keys: { id: 'required', name: 'required' },
    },
  },
}

/** The example's readers (site code; PR 3 puts the real ones in the connector folder). */
export const readLanding = (a: unknown): unknown => {
  const x = a as Record<string, unknown>
  const params = (x.custom_params ?? []) as { var_id: unknown }[]
  return {
    id: x.id, name: x.name, group_id: x.group_id, action_id: x.action_id, to_date: x.to_date, to_time: x.to_time,
    prevent_default: x.prevent_default, param_vars: params.map(p => p.var_id),
  }
}
export const readNamed = (a: unknown): unknown => ({ id: (a as { id: unknown }).id, name: (a as { name: unknown }).name })

/** A landing answer of the example's shape. */
export function landingAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '501', name: '参加者_20261203 の入口', group_id: '9', action_id: '7001', to_date: '2026-12-03', to_time: '18:20',
    prevent_default: false, custom_params: [{ var_id: '11', name: 'a' }, { var_id: '12', name: 'b' }], qr_text: 'x',
    ...over,
  }
}

/** The example's check line (memo §7-3, a business plugin's line: the words are the core's, the names the map's). */
export const EXAMPLE_CHECK_LINE: BrowserReadLine = {
  site: 'example_site',
  values: {
    landing: { kind: 'id', role: 'target', from: ['site_fact'] },
    reference: { kind: 'id', role: 'target', from: ['site_fact'] },
    add_tag: { kind: 'id', role: 'target', from: ['site_fact'] },
    round_date: { kind: 'date', role: 'which', from: ['record_field', 'person'] },
  },
  reads: [
    { name: 'landing', thing: 'landing', id: { value: 'landing' } },
    { name: 'reference', thing: 'landing', id: { value: 'reference' } },
    { name: 'folder', thing: 'landing_folder', id: { read: 'landing', field: 'group_id' } },
    { name: 'add_tag', thing: 'tag', id: { value: 'add_tag' } },
  ],
  checks: [
    { word: 'unchanged_except', read: 'landing', reference: 'reference', except: ['name', 'to_date', 'action_id'] },
    { word: 'date_in_text', read: 'landing', field: 'name', date: 'round_date', format: 'YYYYMMDD' },
    { word: 'date_in_text', read: 'add_tag', field: 'name', date: 'round_date', format: 'YYYYMMDD' },
    { word: 'datetime_on_date', read: 'landing', field: 'to_date', date: 'round_date' },
    { word: 'no_sibling_named', read: 'landing', field: 'name' },
  ],
}

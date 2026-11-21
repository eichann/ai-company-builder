/**
 * Lステップ's browser connector declaration (plugins.md "Browser connectors"), bundled with the app
 * until the shelf hands browser connectors out. Data only, parsed and checked by the core like any
 * package. Its operations name the checker that confirms their target (./reminder-step.ts) and say
 * what the step must show afterwards (`expect`): adding another operation on a step's templates is a
 * new entry here, not new code.
 *
 * What the site sends (captured on test objects only, 2026-11-20): adding a template to a step is
 * `POST /line/episode/step/pack/template`, a form with
 * `_token=<csrf>&_lm_user_id=<session>&content_id=<step>&template_id=<template>`; afterwards the step
 * shows one more `openModal(...)` with that template and a new hole.
 *
 * Adding a template to a reminder's step sends nothing to anyone by itself (`delivers: none`): the
 * step's messages go out on the reminder's schedule. The facts its checker reads for a plan are the
 * table of design memo §31.3 (shared/core/browser-plans.ts holds their shapes).
 *
 * 0.3.0 (PR 6b-1) adds `explore`, the pages the operator AI may ask main to read during the preview
 * (design memo §33 2-2), each with its reviewed reader and its reviewed "no side effects" mark:
 * - `reminder`: `GET /line/episode/show/<reminder>` — read only, changes nothing (the owner's login,
 *   2026-11-22, design memo §34: only our fixed GETs were made; the page's own background reads do
 *   not run, since main reads without a page).
 *
 * 0.4.0 adds the lists the site's own pages read as JSON (design memo §35, §36), with the query
 * strings §33 decision 6 allows (ids and fixed values only, the address built from the declaration
 * and read exactly), each read only — the owner's login, read-only windows: our fixed GETs changed
 * nothing — and each with its reviewed reader (./list-readers.ts):
 * - `reminder_folders`: `GET /api/episode-groups` (no query: an id-free read the preview starts from;
 *   the site's own page sends it with an empty `?`, we send none) → `group`;
 * - `reminders`: `GET /api/episodes?group={group}&page=1` (§36) → `reminder`;
 * - `template_folders`: `GET /api/template-groups` (§36; id-free) → `template_group` (「未分類」, id 0,
 *   is not selectable);
 * - `templates`: `GET /api/templates?group={template_group}&page=1` (§34, §36) → `template`.
 * Page 1 only: a longer list reads as incomplete. Not declared: `/api/landings/<id>` (not this
 * type's). `delivers` stays `none`: what a step's time means for people already past it is not known
 * yet (§34), so no `scheduled` type exists.
 */
import { LSTEP_REMINDER_FOLDERS_READER, LSTEP_REMINDERS_READER, LSTEP_TEMPLATE_FOLDERS_READER, LSTEP_TEMPLATES_READER } from './list-readers'
import { LSTEP_REMINDER_STEP_CHECKER } from './reminder-step'
import { LSTEP_REMINDER_STEPS_READER } from './reminder-steps-reader'

export const LSTEP_DECLARATION = `id: lstep
version: 0.4.0
label: Lステップ
contract: 1
browser:
  host: manager.linestep.net
  asset_hosts: [d1nhtjid4lgi9y.cloudfront.net, profile.line-scdn.net]
  account:
    label: LINE アカウント
  operations:
    reminder_step_add_template:
      label: リマインダの段にテンプレートを足す
      effect: write
      checker: ${LSTEP_REMINDER_STEP_CHECKER}
      lock:
        kind: ${LSTEP_REMINDER_STEP_CHECKER}
      delivers: none
      shared: 全部の回で共有のリマインダです。前の回の人にも届きます。
      target:
        reminder: id
        step: id
      change:
        template: id
      writes:
        - method: POST
          path: /line/episode/step/pack/template
          body: { content_id: "{step}", template_id: "{template}" }
          ignore_body: [_token, _lm_user_id]
      expect:
        - { list: templates, add: "{template}" }
      facts:
        account: { required: true }
        step_parent: { required: true }
        state: { required: true, complete: true }
        names: { required: true }
        template_bodies: { required: true, complete: true }
        shared_with: { required: true, complete: true }
  explore:
    reminder_folders:
      label: リマインダのフォルダの一覧
      path: /api/episode-groups
      reader: ${LSTEP_REMINDER_FOLDERS_READER}
      no_side_effects: reviewed
    reminders:
      label: フォルダの中のリマインダ（1ページ目）
      path: /api/episodes
      query:
        - { name: group, value: "{group}" }
        - { name: page, value: "1" }
      reader: ${LSTEP_REMINDERS_READER}
      no_side_effects: reviewed
    template_folders:
      label: テンプレートのフォルダの一覧
      path: /api/template-groups
      reader: ${LSTEP_TEMPLATE_FOLDERS_READER}
      no_side_effects: reviewed
    templates:
      label: フォルダの中のテンプレート（1ページ目）
      path: /api/templates
      query:
        - { name: group, value: "{template_group}" }
        - { name: page, value: "1" }
      reader: ${LSTEP_TEMPLATES_READER}
      no_side_effects: reviewed
    reminder:
      label: リマインダの中身（段の一覧）
      path: "/line/episode/show/{reminder}"
      reader: ${LSTEP_REMINDER_STEPS_READER}
      no_side_effects: reviewed
`

/**
 * Every declaration of this site, as the approved combinations list reads them
 * (shared/browser-connectors/approved.json, client/scripts/browser-connectors.ts).
 */
export const DECLARATIONS: readonly string[] = [LSTEP_DECLARATION]

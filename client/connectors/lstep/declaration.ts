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
 * Adding a template to a reminder's step sends nothing at once: the step's messages go out on the
 * reminder's schedule (0.2.0–0.5.0 said `delivers: none`; 0.6.0 `scheduled`, below). The facts its
 * checker reads for a plan: shared/core/browser-plans.ts holds their shapes.
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
 * Page 1 only in 0.4.0: a longer list read as incomplete.
 *
 * 0.5.0 reads the paginated lists whole (design memo §38, the owner: folders can hold more than 50):
 * `reminders` and `templates` declare `pages: { param: page, max: 10 }` instead of the fixed `page=1`,
 * so the app — never the AI — reads `…&page=1`, `…&page=2`, … up to `last_page`, at most 10 pages (500
 * items); a longer list is not offered. Not declared: `/api/landings/<id>` (not this
 * type's).
 *
 * 0.6.0 (6b-2b) makes the type `delivers: scheduled` and reads facts version 2 (design 6b-2 §2-3):
 * adding a template to a step reaches only people who have the step's time still ahead of them, at that
 * time, and never anyone already past it — confirmed by the owner, who runs Lステップ (design memo §37);
 * that is the reviewed meaning of `scheduled` here, not something read at run time. The facts:
 * `templates` (name, kind and body of the one to add and of every one on the step; text only — a
 * `form_type` other than 8 makes no plan) and `schedule` (the step's timing as the page shows it), both
 * required and read whole (the first version's rule for `scheduled`), and `audience` (how many will
 * still receive it) optional — unknown is shown as 「読み取れませんでした」, never 0 (6b-2 decision 1).
 * They are read only through the reads `explore` already declares (./reminder-step-facts.ts says from
 * where, and which are not confirmed yet: those stay `unknown`, so no plan is made until they are).
 */
import { LSTEP_REMINDER_FOLDERS_READER, LSTEP_REMINDERS_READER, LSTEP_TEMPLATE_FOLDERS_READER, LSTEP_TEMPLATES_READER } from './list-readers'
import { LSTEP_REMINDER_STEP_CHECKER } from './reminder-step'
import { LSTEP_REMINDER_STEPS_READER } from './reminder-steps-reader'

export const LSTEP_DECLARATION = `id: lstep
version: 0.6.0
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
      delivers: scheduled
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
        templates: { required: true, complete: true }
        schedule: { required: true, complete: true }
        shared_with: { required: true, complete: true }
        audience: { required: false }
  explore:
    reminder_folders:
      label: リマインダのフォルダの一覧
      path: /api/episode-groups
      reader: ${LSTEP_REMINDER_FOLDERS_READER}
      no_side_effects: reviewed
    reminders:
      label: フォルダの中のリマインダ
      path: /api/episodes
      query:
        - { name: group, value: "{group}" }
      pages: { param: page, max: 10 }
      reader: ${LSTEP_REMINDERS_READER}
      no_side_effects: reviewed
    template_folders:
      label: テンプレートのフォルダの一覧
      path: /api/template-groups
      reader: ${LSTEP_TEMPLATE_FOLDERS_READER}
      no_side_effects: reviewed
    templates:
      label: フォルダの中のテンプレート
      path: /api/templates
      query:
        - { name: group, value: "{template_group}" }
      pages: { param: page, max: 10 }
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

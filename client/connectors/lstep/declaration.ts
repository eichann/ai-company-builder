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
 */
import { LSTEP_REMINDER_STEP_CHECKER } from './reminder-step'

export const LSTEP_DECLARATION = `id: lstep
version: 0.2.0
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
`

/**
 * Every declaration of this site, as the approved combinations list reads them
 * (shared/browser-connectors/approved.json, client/scripts/browser-connectors.ts).
 */
export const DECLARATIONS: readonly string[] = [LSTEP_DECLARATION]

/**
 * Lステップ's preview reader of a reminder's page (`explore.reminder` in ./declaration.ts; design
 * memo §33 2-2): which steps the reminder has and which templates each holds, for the operator AI to
 * choose from. It sees only the core's page view (client/shared/browser-page.ts: visible elements,
 * their attributes and text) and hands back declared fields only; choosing is the AI's, guarding is
 * the checker's (./reminder-step.ts).
 *
 * What the page shows (real site, owner's login, 2026-11-22, design memo §34): a step's box
 * `id="templateStep<step>"` (exactly once per step); its slots call
 * `openModal(<reminder>, <step>, <hole>, <template>, <type>)` from an attribute; the step's time is
 * shown in its box as text (「当日 09:00」「N 日前 に送信」).
 *
 * - `step`: from the box's id attribute only (never from text), label = the box's visible text.
 * - `template`: the 4th argument of an `openModal(…)` in an attribute of an element inside the box,
 *   naming this reminder and this step; `extra.in_step` = the step. A call naming another reminder
 *   or step makes the read incomplete (the page is not what we think).
 */
import type { BrowserExploreItem, BrowserExploreReader, BrowserPageElement } from '../../shared/browser-runner'

export const LSTEP_REMINDER_STEPS_READER = 'lstep.reminder_steps'

const POSITIVE_ID = /^[1-9][0-9]{0,18}$/
const STEP_BOX_ID = /^templateStep([1-9][0-9]{0,18})$/
const OPEN_MODAL = /openModal\(\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,\s*['"]?([0-9]+)['"]?\s*,/g
/** Attributes a slot's call may stand in. */
const CALL_ATTRIBUTES = ['onclick', 'href', 'data-onclick'] as const

function slotsOf(box: BrowserPageElement): Array<{ reminder: string; step: string; template: string }> {
  const out: Array<{ reminder: string; step: string; template: string }> = []
  for (const name of CALL_ATTRIBUTES) {
    for (const el of box.find({ hasAttribute: name })) {
      const value = el.attr(name) ?? ''
      for (const m of value.matchAll(OPEN_MODAL)) out.push({ reminder: m[1], step: m[2], template: m[4] })
    }
  }
  return out
}

export function createLstepReminderStepsReader(): BrowserExploreReader {
  return {
    id: LSTEP_REMINDER_STEPS_READER,
    fields: ['step', 'template'],
    extra: ['in_step'],
    read(values, page) {
      const reminder = values.reminder
      if (!POSITIVE_ID.test(reminder ?? '')) return { items: [], complete: false }
      let complete = true
      const items: BrowserExploreItem[] = []
      const boxes = page.find({ idPattern: STEP_BOX_ID })
      if (boxes.length === 0) complete = false
      for (const box of boxes) {
        const step = STEP_BOX_ID.exec(box.id ?? '')?.[1]
        if (!step) { complete = false; continue }
        items.push({ field: 'step', value: step, label: box.text() })
        for (const slot of slotsOf(box)) {
          if (slot.reminder !== reminder || slot.step !== step) { complete = false; continue }
          items.push({ field: 'template', value: slot.template, extra: { in_step: step } })
        }
      }
      return { items, complete }
    },
  }
}

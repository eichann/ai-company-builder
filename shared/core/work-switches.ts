/**
 * The two switches each member sets for themselves (自分の設定, owner decision
 * 2026-11-02, plan「新しい画面のデモ」J「2つのスイッチは人ごとにも」) — one copy of
 * the rule for the server (the member's API, the clock, the Google client,
 * Slack's signals), the desktop app (whether its AI turns start by themselves)
 * and the admin console:
 *
 * - 受信を読む (`readIncoming`): the AI reads the member's own received mail
 *   and Slack messages and makes 「返事のお願い」 of those that need an answer.
 * - AI が自動で進める (`autoRun`): the member's 「AI の番」 starts by itself on
 *   their PC (the PC of the record's assignee); off, it waits for
 *   ［AI に進めてもらう］. Sending and approving are always a person's either way,
 *   and work still arrives (a minutes check is still delivered; only the AI's
 *   work waits).
 *
 * The company decides, per switch, whether members may use it (`allowed`) and
 * what a member who never chose starts with (`memberDefault`); each member
 * turns their own on or off. A switch the company does not allow is off for
 * everyone and cannot be turned on (turning it off is always possible).
 *
 * Pure: imports only shared/core (server/tests/unit/core-purity.test.ts).
 */

export const WORK_SWITCHES = ['readIncoming', 'autoRun'] as const
export type WorkSwitch = typeof WORK_SWITCHES[number]

export const isWorkSwitch = (v: unknown): v is WorkSwitch => (WORK_SWITCHES as readonly unknown[]).includes(v)

/** The company's side of one switch. */
export interface WorkSwitchPolicy {
  /** Members may use it (使ってよいか). Off: off for everyone, nobody can turn it on. */
  allowed: boolean
  /** A member who never chose starts with this (各自の初めの値). */
  memberDefault: boolean
}

export type WorkSwitchPolicies = Record<WorkSwitch, WorkSwitchPolicy>

/**
 * Owner decision 2026-11-02: 受信を読む is allowed and each member starts off;
 * AI が自動で進める is allowed and each member starts on.
 */
export const DEFAULT_WORK_SWITCH_POLICIES: WorkSwitchPolicies = Object.freeze({
  readIncoming: Object.freeze({ allowed: true, memberDefault: false }),
  autoRun: Object.freeze({ allowed: true, memberDefault: true }),
}) as WorkSwitchPolicies

/** What a member chose; a switch left out was never chosen (the company's 初めの値 applies). */
export type WorkSwitchChoices = Partial<Record<WorkSwitch, boolean>>

/** A stored choice document → the known switches with a boolean only (anything else is "never chose"). */
export function parseWorkSwitchChoices(raw: unknown): WorkSwitchChoices {
  const out: WorkSwitchChoices = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const s of WORK_SWITCHES) {
    const v = (raw as Record<string, unknown>)[s]
    if (typeof v === 'boolean') out[s] = v
  }
  return out
}

/** Whether the switch is on for the member: allowed by the company, and their choice (else the company's 初めの値). */
export function workSwitchOn(policy: WorkSwitchPolicy, choice: boolean | undefined): boolean {
  return policy.allowed && (choice ?? policy.memberDefault)
}

/** One switch as the member's settings show it. */
export interface WorkSwitchState {
  /** In force now. */
  on: boolean
  /** The company lets members use it (false: 「会社の設定で止まっています」, greyed out). */
  allowed: boolean
  /** The company's 初めの値. */
  companyDefault: boolean
  /** What the member chose; null = never chose (the 初めの値 applies). */
  chosen: boolean | null
}

export function workSwitchState(policy: WorkSwitchPolicy, choice: boolean | undefined): WorkSwitchState {
  return { on: workSwitchOn(policy, choice), allowed: policy.allowed, companyDefault: policy.memberDefault, chosen: choice ?? null }
}

/**
 * The member turns a switch on or off. Turning on a switch the company does not
 * allow is refused (`company-off`); turning off is always kept (it stays off
 * if the company allows it again later).
 */
export function chooseWorkSwitch(policies: WorkSwitchPolicies, choices: WorkSwitchChoices, which: WorkSwitch, on: boolean): { value: WorkSwitchChoices } | { refused: 'company-off' } {
  if (on && !policies[which].allowed) return { refused: 'company-off' }
  return { value: { ...choices, [which]: on } }
}

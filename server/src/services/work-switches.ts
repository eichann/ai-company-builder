/**
 * Each member's own switches (自分の設定: 受信を読む, AI が自動で進める; owner decision
 * 2026-11-02, `.claude/rules/tasks.md` "Each member's switches"). The rule is
 * shared/core/work-switches.ts; the company's side (使ってよいか, 各自の初めの値) is in
 * the task settings (`workSwitchPoliciesOf`); the member's choices are behind the
 * company handle (`tasks.workSwitches`).
 *
 * Who reads what: a member reads and changes only their own; the server asks
 * `isOn` for anyone of the company (the clock for a record's assignee, the
 * Google client and Slack's signals for the member whose mail or messages they
 * are).
 */
import { workSwitchPoliciesOf, type TaskSettings } from '../../shared/core/task-settings'
import { chooseWorkSwitch, isWorkSwitch, parseWorkSwitchChoices, workSwitchOn, workSwitchState, type WorkSwitch, type WorkSwitchChoices } from '../../shared/core/work-switches'
import type { MyWorkSwitches } from '../../shared/types/work-switches'
import type { Clock } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Member } from './access'
import { ok, refuse, type Outcome } from './outcome'

export const WORK_SWITCH_COMPANY_OFF = '会社の設定で止まっています。管理者に確かめてください。'

export interface WorkSwitchesDeps {
  companyData: CompanyDataSource
  clock: Clock
  /** The company's task settings in force (services/task-settings.ts `settingsOf`). */
  settingsOf(companyId: string): TaskSettings
  /**
   * Whether the member has given ACB the reading it needs (Google's 受信を読む, Slack's reading):
   * only shown, so the app can offer 「Google で許可」 after the member turns 受信を読む on.
   */
  readingConnected?(companyId: string, userId: string): { mail: boolean; chat: boolean }
  /**
   * Whether the company has a usable connector for the `mail` / `chat` role now
   * (connector-roles.md; `choice-needed` counts as connected). Absent or failing:
   * the field is left out and the app shows its mail / chat parts as before.
   */
  channelsOf?(companyId: string): Promise<{ mail: boolean; chat: boolean }>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function createWorkSwitches(deps: WorkSwitchesDeps) {
  const repo = (companyId: string) => deps.companyData.forCompany(companyId).tasks

  function choicesOf(companyId: string, userId: string): WorkSwitchChoices {
    const raw = repo(companyId).workSwitches(userId)
    if (raw === null) return {}
    try { return parseWorkSwitchChoices(JSON.parse(raw)) } catch { return {} }
  }

  async function channelsOf(companyId: string): Promise<MyWorkSwitches['channels']> {
    if (!deps.channelsOf) return undefined
    try {
      const c = await deps.channelsOf(companyId)
      return { mail: c.mail === true, chat: c.chat === true }
    } catch {
      return undefined
    }
  }

  async function view(companyId: string, userId: string): Promise<MyWorkSwitches> {
    const channels = await channelsOf(companyId)
    const settings = deps.settingsOf(companyId)
    const policies = workSwitchPoliciesOf(settings)
    const choices = choicesOf(companyId, userId)
    return {
      readIncoming: {
        ...workSwitchState(policies.readIncoming, choices.readIncoming),
        connected: deps.readingConnected?.(companyId, userId) ?? { mail: false, chat: false },
      },
      autoRun: workSwitchState(policies.autoRun, choices.autoRun),
      teamMode: { on: settings.teamMode },
      ...(channels ? { channels } : {}),
    }
  }

  return {
    /**
     * Whether a member's switch is on now (the company allows it, and their choice or the
     * 初めの値). `userId` null (a record nobody is assigned): the company's 初めの値.
     */
    isOn(companyId: string, userId: string | null, which: WorkSwitch): boolean {
      const policy = workSwitchPoliciesOf(deps.settingsOf(companyId))[which]
      return workSwitchOn(policy, userId === null ? undefined : choicesOf(companyId, userId)[which])
    },

    /** GET …/me/work-switches (any member): their own. */
    my(member: Member): Promise<MyWorkSwitches> {
      return view(member.companyId, member.userId)
    },

    /**
     * PUT …/me/work-switches { switch, on } (any member, their own only). Turning on a switch
     * the company does not allow → 409 `WORK_SWITCH_COMPANY_OFF`; off is always kept.
     */
    async set(member: Member, body: unknown): Promise<Outcome<MyWorkSwitches>> {
      if (!isObject(body) || !isWorkSwitch(body.switch) || typeof body.on !== 'boolean') {
        return refuse('bad-request', 'switch must be readIncoming or autoRun; on must be true or false')
      }
      const policies = workSwitchPoliciesOf(deps.settingsOf(member.companyId))
      const next = chooseWorkSwitch(policies, choicesOf(member.companyId, member.userId), body.switch, body.on)
      if ('refused' in next) return refuse('conflict', WORK_SWITCH_COMPANY_OFF, { code: 'WORK_SWITCH_COMPANY_OFF' })
      repo(member.companyId).saveWorkSwitches(member.userId, JSON.stringify(next.value), deps.clock.now())
      return ok(await view(member.companyId, member.userId))
    },
  }
}

export type WorkSwitches = ReturnType<typeof createWorkSwitches>

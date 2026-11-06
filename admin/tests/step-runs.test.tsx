// 「手順の始め方と置き場所」 (owner decisions 2026-11-06, plugin-steps.md "Starting by itself"): a
// person's step shows the button by default and offers 「自動で始める」; the choice and the folder are
// sent as the server's setting; a step that starts by itself already offers no choice.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { StepRunsSection } from '@/app/companies/[id]/integrations/step-runs'
import type { PluginStepSkillsView } from '@/lib/api'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { ok } from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/co_123/integrations`,
  useSearchParams: () => new URLSearchParams(),
}))

const view = (autoStart: boolean, folder: string | null): PluginStepSkillsView => ({
  steps: [
    { step: 'prepare_proposal', label: '提案書を用意する', overridable: true, skill: null, start: 'person', autoStart, deliverableFolder: folder ?? '提案書を用意する', deliverableFolderChosen: folder },
    { step: 'reflect_meeting', label: '商談のあとを案件に反映する', overridable: false, skill: null, start: 'ai_turn', autoStart: false, deliverableFolder: '商談のあとを案件に反映する', deliverableFolderChosen: null },
  ],
})

describe('手順の始め方と置き場所', () => {
  it('starts at the button; 自動で始める and a folder are sent as the setting; an automatic step offers no choice', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/plugins/corporate-sales/step-skills`]: { body: ok(view(false, null)) },
      [`PUT ${base}/plugins/corporate-sales/step-settings/prepare_proposal`]: { body: ok(view(true, '提案書')) },
    })
    renderInCompany(<StepRunsSection pluginId="corporate-sales" />)
    const start = await screen.findByRole('combobox', { name: '提案書を用意するの始め方' })
    expect(start).toHaveValue('button')
    expect(screen.queryByRole('combobox', { name: '商談のあとを案件に反映するの始め方' })).toBeNull()
    expect(screen.getByText('この手順は、もともと自動で始まります。')).toBeInTheDocument()
    await userEvent.selectOptions(start, 'auto')
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ autoStart: true }]))
    await userEvent.type(await screen.findByRole('textbox', { name: '提案書を用意するの置き場所' }), '提案書/x')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('textbox', { name: '提案書を用意するの置き場所' }))
    await userEvent.type(screen.getByRole('textbox', { name: '提案書を用意するの置き場所' }), '見積')
    await userEvent.click(screen.getAllByRole('button', { name: '保存' })[0])
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ autoStart: true }, { deliverableFolder: '見積' }]))
  })
})

// Stage 2 editing screens: permission editor, security, role change, rename.
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import MembersPage from '@/app/companies/[id]/members/page'
import PermissionsPage from '@/app/companies/[id]/permissions/page'
import SecurityPage from '@/app/companies/[id]/security/page'
import SettingsPage from '@/app/companies/[id]/settings/page'
import { toast } from 'sonner'

import { ApiError, type Member } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { base, companyRoutes, renderInCompany } from './company-harness'
import {
  COMPANY_ID,
  company,
  effectiveAt,
  managerCapabilities,
  members,
  ok,
  ownerCapabilities,
  permissionScopes,
  quietOverview,
  rejectionPage,
} from './fixtures'
import { mockApi } from './mock-api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

/** The tree row that selects a place (not its expand/collapse toggle). */
async function treeRow(name: string): Promise<HTMLElement> {
  const tree = await screen.findByRole('tree')
  const row = within(tree).getAllByRole('button').find((b) => b.hasAttribute('data-tree-row') && b.textContent?.startsWith(name))
  if (!row) throw new Error(`no tree row ${name}`)
  return row
}

describe('権限', () => {
  const yamada: Member = {
    id: 'm4',
    userId: 'u_member2',
    companyId: COMPANY_ID,
    role: 'member',
    email: 'yamada@example.com',
    name: '山田 次郎',
    createdAt: '2026-09-04 02:00:00',
  }
  const permissionRoutes = (caps = ownerCapabilities, scopes = permissionScopes) => ({
    ...companyRoutes(caps),
    [`GET ${base}/members`]: { body: ok([...members, yamada]) },
    [`GET ${base}/permissions`]: { body: ok({ scopes }) },
    [`GET ${base}/permissions/effective?path=`]: { body: ok(effectiveAt('', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部`]: { body: ok(effectiveAt('営業部', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部/契約書`]: { body: ok(effectiveAt('営業部/契約書', '営業部/契約書', ['u_member'])) },
    [`PUT ${base}/permissions/scopes/by-path`]: { body: ok({ scope: null, rules: [] }) },
  })
  const puts = (calls: Array<{ method: string; body: unknown }>) => calls.filter((c) => c.method === 'PUT').map((c) => c.body)
  const previewCounts = () => screen.getByText((_, el) => el?.tagName === 'P' && /^編集できる \d+人/.test(el.textContent ?? ''))
  const option = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) })

  it('shows the company default, the tree badges and the company choice (no 上の階層と同じ at the root)', async () => {
    mockApi(permissionRoutes())
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('会社全体の基本ルール')).toBeInTheDocument()
    expect(screen.getByText(/一部の人にだけ見せたいファイルは/)).toBeInTheDocument()
    const tree = screen.getByRole('tree', { name: '権限を設定する場所' })
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4)
    expect(within(tree).getAllByText('継承')).toHaveLength(2)
    expect(within(tree).getByText('全員が編集')).toBeInTheDocument()
    expect(within(tree).getByText('一部が編集')).toBeInTheDocument()

    expect(await screen.findByRole('heading', { name: '株式会社サンプル の設定' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '編集できる人' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /^上の階層と同じ/ })).not.toBeInTheDocument()
    expect(option('全員')).toBeChecked()
    expect(option('指定した人だけ')).not.toBeChecked()
    expect(screen.getByText('一部の人にだけ見せたいときは、非公開フォルダを作ってそこに置きます。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect((await screen.findAllByText('オーナーは常に編集できます')).length).toBeGreaterThan(0)
  })

  it('指定した人だけ: pick a member, preview updates before saving, confirm who loses edit, save one rule set, undo', async () => {
    const success = vi.spyOn(toast, 'success')
    const { calls } = mockApi(permissionRoutes())
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('営業部'))
    expect(await screen.findByRole('heading', { name: '営業部 の設定' })).toBeInTheDocument()
    expect(option('上の階層と同じ')).toBeChecked()
    expect(screen.getByText('「株式会社サンプル」と同じ：全員')).toBeInTheDocument()

    await userEvent.click(option('指定した人だけ'))
    expect(screen.getByText(/まだ誰も選ばれていません/)).toBeInTheDocument()
    expect(screen.getByText('保存前のプレビュー')).toBeInTheDocument()
    expect(previewCounts()).toHaveTextContent('編集できる 2人 · 閲覧のみ 2人')

    await userEvent.click(screen.getByRole('button', { name: '追加' }))
    const picker = await screen.findByRole('dialog')
    expect(within(picker).queryByText('佐藤 花子')).not.toBeInTheDocument()
    expect(within(picker).getByText(/オーナー・管理者（2人）は常に編集できる/)).toBeInTheDocument()
    expect(within(picker).getByText('責任者')).toBeInTheDocument() // 田中 manages 営業部
    await userEvent.type(within(picker).getByRole('combobox'), '田中')
    await userEvent.click(within(picker).getByText('田中 太郎'))
    await userEvent.keyboard('{Escape}')

    const chips = screen.getByRole('list', { name: '編集できる人' })
    expect(within(chips).getByText('田中 太郎')).toBeInTheDocument()
    expect(screen.getByText(/それ以外の人は「閲覧のみ」になります/)).toBeInTheDocument()
    expect(previewCounts()).toHaveTextContent('編集できる 3人 · 閲覧のみ 1人')
    expect(puts(calls)).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('1人が編集できなくなります')).toBeInTheDocument()
    expect(within(dialog).getByText('山田 次郎')).toBeInTheDocument()
    expect(puts(calls)).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: '保存する' }))
    await waitFor(() =>
      expect(puts(calls)).toEqual([
        {
          path: '営業部',
          rules: [
            { subjectType: 'everyone', subjectId: null, canWrite: false },
            { subjectType: 'user', subjectId: 'u_member', canWrite: true },
          ],
        },
      ])
    )
    await waitFor(() => expect(success).toHaveBeenCalled())
    const [message, options] = success.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(message).toBe('営業部：編集できる人を「指定した人だけ（田中 太郎）」にしました')
    expect(options.action.label).toBe('元に戻す')
    options.action.onClick()
    await waitFor(() => expect(puts(calls)[1]).toEqual({ path: '営業部', rules: [] }))
  })

  it('loads a saved 指定した人だけ, removes a chip, and switches to 上の階層と同じ / 全員 without asking when nobody loses edit', async () => {
    const { calls } = mockApi(permissionRoutes())
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('契約書'))
    expect(await screen.findByRole('heading', { name: '契約書 の設定' })).toBeInTheDocument()
    expect(option('指定した人だけ')).toBeChecked()
    const chips = screen.getByRole('list', { name: '編集できる人' })
    expect(within(chips).getByText('田中 太郎')).toBeInTheDocument()

    // Removing the only chosen person, then discarding, restores the saved choice.
    await userEvent.click(within(chips).getByRole('button', { name: '田中 太郎を外す' }))
    expect(screen.getByText(/まだ誰も選ばれていません/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '取り消す' }))
    expect(within(screen.getByRole('list', { name: '編集できる人' })).getByText('田中 太郎')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()

    await userEvent.click(option('上の階層と同じ'))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(puts(calls)).toEqual([{ path: '営業部/契約書', rules: [] }]))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('全員 on the root after 指定した人だけ (keyboard only)', async () => {
    const restricted = permissionScopes.map((s) =>
      s.path === ''
        ? {
            ...s,
            effectiveSummary: 'everyone-r' as const,
            rules: [
              { id: 'r_everyone', subjectType: 'everyone' as const, subjectId: null, subjectLabel: '全員', canRead: true, canWrite: false },
              { id: 'r_role', subjectType: 'role' as const, subjectId: 'member', subjectLabel: 'メンバー', canRead: true, canWrite: true },
            ],
          }
        : s
    )
    const { calls } = mockApi(permissionRoutes(ownerCapabilities, restricted))
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByRole('heading', { name: '株式会社サンプル の設定' })).toBeInTheDocument()
    expect(option('指定した人だけ')).toBeChecked()
    expect(within(screen.getByRole('list', { name: '編集できる人' })).getByText('役割: メンバー')).toBeInTheDocument()
    option('指定した人だけ').focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(option('全員')).toBeChecked()
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: '保存' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(puts(calls)).toEqual([{ path: '', rules: [{ subjectType: 'everyone', subjectId: null, canWrite: true }] }]))
  })

  it('explains rules made with the earlier editor that the choice cannot express', async () => {
    const custom = permissionScopes.map((s) =>
      s.path === '営業部/契約書'
        ? {
            ...s,
            rules: [
              { id: 'a', subjectType: 'everyone' as const, subjectId: null, subjectLabel: '全員', canRead: true, canWrite: true },
              { id: 'b', subjectType: 'user' as const, subjectId: 'u_member', subjectLabel: '田中 太郎', canRead: true, canWrite: false },
            ],
          }
        : s
    )
    mockApi(permissionRoutes(ownerCapabilities, custom))
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('契約書'))
    expect(await screen.findByText(/以前の画面で作った細かい設定（全員: 編集できる、田中 太郎: 閲覧のみ）/)).toBeInTheDocument()
    expect(option('全員')).toBeChecked()
  })

  it('keeps the draft and explains when saving fails', async () => {
    const error = vi.spyOn(toast, 'error')
    mockApi({
      ...permissionRoutes(),
      [`PUT ${base}/permissions/scopes/by-path`]: {
        status: 403,
        body: { error: 'Only owners, admins and the managers of this department can change its permissions' },
      },
    })
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('契約書'))
    await userEvent.click(await screen.findByRole('radio', { name: /^全員/ }))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('権限を保存できませんでした', expect.anything()))
    expect(option('全員')).toBeChecked()
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('a department manager edits only the subtree they receive and sees what it inherits from the company', async () => {
    const subtree = permissionScopes.filter((s) => s.path.startsWith('営業部'))
    mockApi(permissionRoutes(managerCapabilities, subtree))
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText(/あなたが責任者を務める部署と、その中のフォルダだけ/)).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '営業部 の設定' })).toBeInTheDocument()
    expect(screen.queryByText('会社全体の基本ルール')).not.toBeInTheDocument()
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2)
    expect(screen.getByText('「株式会社サンプル」と同じ：全員')).toBeInTheDocument()
    expect(screen.queryByText('確認のみ')).not.toBeInTheDocument()
  })

  it('explains refused edits in plain Japanese', () => {
    expect(describeError(new ApiError(400, 'Restricting read access is not available yet: every rule lets its subject read.'))).toMatch(
      /閲覧の制限はまだ使えません/
    )
    expect(describeError(new ApiError(403, 'Only owners, admins and the managers of this department can change its permissions'))).toMatch(
      /その部署の責任者/
    )
    expect(describeError(new ApiError(400, 'The last owner cannot be demoted. Make another member an owner first.'))).toMatch(
      /最後のオーナー/
    )
    expect(describeError(new ApiError(400, 'The company-wide rules cannot be removed; change them instead'))).toMatch(/会社全体のルール/)
  })

  it('explains when the user may not view permissions', async () => {
    mockApi({
      ...companyRoutes(managerCapabilities),
      [`GET ${base}/permissions`]: { status: 403, body: { error: 'Only owners, admins and department managers can view permissions' } },
    })
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('権限を確認できるのは、オーナー・管理者と部署の責任者です')).toBeInTheDocument()
  })
})

describe('セキュリティ', () => {
  it('explains the built-in rules and lists rejected pushes with their files', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/push-rejections?limit=25`]: { body: ok(rejectionPage) } })
    renderInCompany(<SecurityPage />)
    for (const title of ['配布設定の保護', 'スキルの自動実行', '個人用フォルダ（.personal）', '秘密情報の検出', 'Windowsで使えない名前', '編集権限']) {
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
    }
    expect(screen.getByText('メンバーの役割の変更')).toBeInTheDocument()
    const row = (await screen.findByText('APIキーやパスワードなどの秘密情報が含まれていた')).closest('button')!
    expect(within(row).getByText('田中 太郎')).toBeInTheDocument()
    expect(within(row).getByText(/ほか1件/)).toBeInTheDocument()
    await userEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: '対象のファイル' })).toHaveTextContent('営業部/顧客.env')
    expect(screen.getByText('3件中 2件を表示')).toBeInTheDocument()
  })

  it('loads more', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/push-rejections?limit=25`]: { body: ok(rejectionPage) },
      [`GET ${base}/push-rejections?limit=25&offset=2`]: {
        body: ok({ ...rejectionPage, rejections: [{ ...rejectionPage.rejections[0], id: 'pr3', marker: 'SOMETHING_NEW', paths: [] }] }),
      },
    })
    renderInCompany(<SecurityPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'さらに表示' }))
    expect(await screen.findByText('3件中 3件を表示')).toBeInTheDocument()
    expect(screen.getAllByText('SOMETHING_NEW').length).toBeGreaterThan(0)
    expect(calls.some((c) => c.url.includes('offset=2'))).toBe(true)
  })

  it('filters by type', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/push-rejections?limit=25`]: { body: ok(rejectionPage) },
      [`GET ${base}/push-rejections?marker=PROTECTED_CONFIG&limit=25`]: {
        body: ok({ ...rejectionPage, total: 1, rejections: [rejectionPage.rejections[1]] }),
      },
    })
    renderInCompany(<SecurityPage />)
    await screen.findByText('3件中 2件を表示')
    await userEvent.click(screen.getByRole('combobox', { name: '種類で絞り込む' }))
    await userEvent.click(await screen.findByRole('option', { name: '配布設定の保護' }))
    expect(await screen.findByText('1件中 1件を表示')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('marker=PROTECTED_CONFIG'))).toBe(true)
  })

  it('shows the empty state', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/push-rejections?limit=25`]: { body: ok({ total: 0, markers: [], rejections: [] }) } })
    renderInCompany(<SecurityPage />)
    expect(await screen.findByText('止められた同期はありません')).toBeInTheDocument()
  })

  it('is for owners and admins only', async () => {
    const { calls } = mockApi(companyRoutes(managerCapabilities))
    renderInCompany(<SecurityPage />)
    expect(await screen.findByText('このページはオーナーと管理者だけが使えます')).toBeInTheDocument()
    expect(calls.some((c) => c.url.includes('push-rejections'))).toBe(false)
  })
})

describe('メンバー: 役割の変更', () => {
  it('an owner changes a member to admin', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`GET ${base}/overview`]: { body: ok(quietOverview) },
      [`PUT ${base}/members/u_member/role`]: { body: ok({ userId: 'u_member', companyId: COMPANY_ID, role: 'admin' }) },
    })
    renderInCompany(<MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '田中 太郎 の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '役割を変更' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('combobox', { name: '役割' }))
    await userEvent.click(await screen.findByRole('option', { name: '管理者' }))
    await userEvent.click(within(dialog).getByRole('button', { name: '変更する' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toMatchObject({ body: { role: 'admin' } }))
  })

  it('the last owner cannot step down', async () => {
    mockApi({ ...companyRoutes(), [`GET ${base}/overview`]: { body: ok(quietOverview) } })
    renderInCompany(<MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '佐藤 花子 の操作' }))
    expect(screen.queryByRole('menuitem', { name: '会社から削除' })).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('menuitem', { name: '役割を変更' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/この会社のオーナーはあなただけです/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '変更する' })).toBeDisabled()
  })

  it('admins do not get role changes', async () => {
    mockApi({ ...companyRoutes({ role: 'admin', managedDepartmentIds: [] }), [`GET ${base}/overview`]: { body: ok(quietOverview) } })
    renderInCompany(<MembersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '田中 太郎 の操作' }))
    expect(await screen.findByRole('menuitem', { name: '会社から削除' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '役割を変更' })).not.toBeInTheDocument()
  })
})

describe('会社の設定: 名前の変更', () => {
  it('renames the company and refuses an empty name', async () => {
    const { calls } = mockApi({
      ...companyRoutes(),
      [`PATCH ${base}`]: { body: ok({ ...company, name: '株式会社あたらしい' }) },
    })
    renderInCompany(<SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: '名前を変更' }))
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('会社名')
    await userEvent.clear(input)
    expect(within(dialog).getByRole('button', { name: '保存' })).toBeDisabled()
    expect(within(dialog).getByText('会社名を入力してください。')).toBeInTheDocument()
    await userEvent.type(input, '  株式会社あたらしい ')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ body: { name: '株式会社あたらしい' } }))
  })
})

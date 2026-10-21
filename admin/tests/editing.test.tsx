// Stage 2 editing screens: permission editor, security, role change, rename.
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import MembersPage from '@/app/companies/[id]/members/page'
import PermissionsPage from '@/app/companies/[id]/permissions/page'
import SecurityPage from '@/app/companies/[id]/security/page'
import SettingsPage from '@/app/companies/[id]/settings/page'
import { ApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { base, companyRoutes, renderInCompany } from './company-harness'
import {
  COMPANY_ID,
  company,
  effectiveAt,
  managerCapabilities,
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
  const permissionRoutes = (caps = ownerCapabilities, scopes = permissionScopes) => ({
    ...companyRoutes(caps),
    [`GET ${base}/permissions`]: { body: ok({ scopes }) },
    [`GET ${base}/permissions/effective?path=`]: { body: ok(effectiveAt('', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部`]: { body: ok(effectiveAt('営業部', '', ['u_member'])) },
    [`GET ${base}/permissions/effective?path=営業部/契約書`]: { body: ok(effectiveAt('営業部/契約書', '営業部/契約書', ['u_member'])) },
  })

  it('shows the company default, the tree and the company rule with its preview', async () => {
    mockApi(permissionRoutes())
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText('会社全体の基本ルール')).toBeInTheDocument()
    expect(screen.getByText(/閲覧そのものを制限する（見せない）設定は、今後のアップデートで対応予定/)).toBeInTheDocument()
    expect(screen.getByText(/オーナーと管理者は、ルールに関係なく常に/)).toBeInTheDocument()
    const tree = screen.getByRole('tree', { name: '権限を設定する場所' })
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4)
    expect(within(tree).getAllByText('継承')).toHaveLength(2)
    // The company is selected first: its rule is editable.
    const group = screen.getByRole('radiogroup', { name: '全員の権限' })
    expect(within(group).getByRole('radio', { name: '編集できる' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'ルールを追加' })).toBeInTheDocument()
    // The only company rule cannot be removed.
    expect(screen.getByRole('button', { name: '全員のルールは削除できません' })).toBeDisabled()
    expect((await screen.findAllByText('オーナーは常に編集できます')).length).toBeGreaterThan(0)
  })

  it('asks before taking edit rights from everyone, then saves', async () => {
    const { calls } = mockApi({
      ...permissionRoutes(),
      [`PATCH ${base}/permissions/rules/r_everyone`]: { body: ok({ scope: null, rules: [] }) },
    })
    renderInCompany(<PermissionsPage />)
    const group = await screen.findByRole('radiogroup', { name: '全員の権限' })
    await userEvent.click(within(group).getByRole('radio', { name: '閲覧のみ' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('全員を「閲覧のみ」にしますか？')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    await userEvent.click(within(dialog).getByRole('button', { name: '閲覧のみにする' }))
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ body: { canWrite: false } }))
  })

  it('changing an inherited rule gives the department its own rule', async () => {
    const { calls } = mockApi({
      ...permissionRoutes(),
      [`POST ${base}/permissions/rules`]: { status: 201, body: ok({ scope: null, rules: [] }) },
    })
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('営業部'))
    expect(await screen.findByText('「株式会社サンプル」から継承しているルール')).toBeInTheDocument()
    expect(screen.getByText(/いまのルールをこの場所にコピーしてから変更します/)).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('radiogroup', { name: '全員の権限' })).getByRole('radio', { name: '閲覧のみ' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '閲覧のみにする' }))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        body: { path: '営業部', subjectType: 'everyone', subjectId: null, canWrite: false },
      })
    )
  })

  it('adds a rule for one member, read-only, from the searchable picker (owners/admins not offered)', async () => {
    const { calls } = mockApi({
      ...permissionRoutes(),
      [`POST ${base}/permissions/rules`]: { body: ok({ scope: null, rules: [] }) },
    })
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('契約書'))
    await userEvent.click(await screen.findByRole('button', { name: 'ルールを追加' }))
    const picker = await screen.findByRole('dialog')
    await userEvent.click(
      within(within(picker).getByRole('radiogroup', { name: '追加するルールの権限' })).getByRole('radio', { name: '閲覧のみ' })
    )
    expect(within(picker).queryByText('佐藤 花子')).not.toBeInTheDocument()
    expect(within(picker).getByText(/オーナー・管理者（2人）は常に編集できる/)).toBeInTheDocument()
    await userEvent.type(within(picker).getByRole('combobox'), '田中')
    await userEvent.click(within(picker).getByText('田中 太郎'))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        body: { path: '営業部/契約書', subjectType: 'user', subjectId: 'u_member', canWrite: false },
      })
    )
  })

  it('keeps the everyone rule while others exist and confirms removing a rule', async () => {
    const { calls } = mockApi({
      ...permissionRoutes(),
      [`DELETE ${base}/permissions/rules/r_contracts_tanaka`]: { body: ok({ scope: null, rules: [] }) },
    })
    renderInCompany(<PermissionsPage />)
    await userEvent.click(await treeRow('契約書'))
    expect(await screen.findByText('この場所のルール')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全員のルールは削除できません' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '上の階層のルールに合わせる' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '田中 太郎のルールを削除' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '削除する' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true))
  })

  it('a department manager edits only the subtree they receive, without the company card', async () => {
    const subtree = permissionScopes.filter((s) => s.path.startsWith('営業部'))
    mockApi(permissionRoutes(managerCapabilities, subtree))
    renderInCompany(<PermissionsPage />)
    expect(await screen.findByText(/あなたが責任者を務める部署と、その中のフォルダだけ/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'ルールを追加' })).toBeInTheDocument()
    expect(screen.queryByText('会社全体の基本ルール')).not.toBeInTheDocument()
    expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2)
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

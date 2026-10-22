// 非公開フォルダ (permission plan stage 3c): the list, the create dialog
// (place, name, 見られる人 / 編集できる人, the summary line), 409s, 公開に戻す,
// and the private folder on the 権限 screen.
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import PermissionsPage from '@/app/companies/[id]/permissions/page'
import PrivateFoldersPage from '@/app/companies/[id]/private-folders/page'
import type { PermissionScope, PrivateFolderDetail, PrivateFolderSummary } from '@/lib/api'
import {
  MANAGERS_MAY_CHANGE_VIEWERS,
  PRIVATE_FOLDER_HELP,
  PRIVATE_FOLDER_HELP_TITLE,
  REMOVED_VIEWER_CAVEAT,
} from '@/lib/private-folder-help'
import { audienceCounts, audienceFromDetail, audienceRequest, defaultViewers, displayPath } from '@/lib/private-folders'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { COMPANY_ID, departments, effectiveAt, managerCapabilities, members, ok, permissionScopes } from './fixtures'
import { mockApi, type Call } from './mock-api'
import * as clientHelp from '../../client/shared/private-folder-help'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}/private-folders`,
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const evaluation: PrivateFolderSummary = {
  scopeId: 's_eval',
  path: '人事部/評価',
  departmentId: 'd_hr',
  viewerCount: 3,
  editorCount: 3,
  createdAt: '2026-10-22 01:00:00',
  createdBy: 'u_owner',
  createdByName: '佐藤 花子',
}

const evaluationDetail: PrivateFolderDetail = {
  ...evaluation,
  members: [
    { userId: 'u_owner', name: '佐藤 花子', email: 'sato@example.com', role: 'owner', canWrite: true, via: 'role' },
    { userId: 'u_admin', name: '鈴木 一郎', email: 'suzuki@example.com', role: 'admin', canWrite: true, via: 'role' },
    { userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com', role: 'member', canWrite: true, via: 'rule' },
  ],
}

const salesFolders = { path: '営業部', folders: [{ name: '提案書', path: '営業部/提案書', scopeId: null, hasRules: false, private: false }] }
const rootFolders = {
  path: '',
  folders: [
    { name: '人事部', path: '人事部', scopeId: null, hasRules: false, private: false },
    { name: '営業部', path: '営業部', scopeId: 's_sales', hasRules: false, private: false },
  ],
}

function routes(extra: Record<string, Parameters<typeof mockApi>[0][string]> = {}, caps = companyRoutes()) {
  return {
    ...caps,
    [`GET ${base}/private-folders`]: { body: ok([evaluation]) },
    [`GET ${base}/private-folders/s_eval`]: { body: ok(evaluationDetail) },
    [`GET ${base}/permissions/folders?path=`]: { body: ok(rootFolders) },
    [`GET ${base}/permissions/folders?path=営業部`]: { body: ok(salesFolders) },
    ...extra,
  }
}

const posted = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(path))

async function openCreateAndPickSales() {
  await userEvent.click((await screen.findAllByRole('button', { name: /非公開フォルダを作成/ }))[0])
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(await within(dialog).findByRole('button', { name: /営業部/ }))
  await within(dialog).findByText('提案書')
  return dialog
}

describe('非公開フォルダ: helpers', () => {
  it('defaults to the creator and the managers, never owners/admins', () => {
    expect(defaultViewers('u_owner', ['u_member'], members)).toEqual(['u_member'])
    expect(defaultViewers('u_member', ['u_member'], members)).toEqual(['u_member'])
  })

  it('counts owners/admins in the summary and omits editors for 見られる人全員', () => {
    expect(audienceCounts({ viewers: ['u_member'], editorsMode: 'all', editors: [] }, members)).toEqual({ viewers: 3, editors: 3, admins: 2 })
    expect(audienceCounts({ viewers: ['u_member'], editorsMode: 'specific', editors: [] }, members)).toEqual({ viewers: 3, editors: 2, admins: 2 })
    expect(audienceRequest({ viewers: ['a', 'b'], editorsMode: 'all', editors: ['a'] })).toEqual({ viewers: ['a', 'b'] })
    expect(audienceRequest({ viewers: ['a'], editorsMode: 'specific', editors: ['a', 'gone'] })).toEqual({ viewers: ['a'], editors: ['a'] })
  })

  it('reads the saved audience back from the detail', () => {
    expect(audienceFromDetail(evaluationDetail)).toEqual({ viewers: ['u_member'], editorsMode: 'all', editors: [] })
    expect(displayPath('人事部/評価', departments)).toBe('人事部 / 評価')
    expect(displayPath('development/設計', departments)).toBe('開発部 / 設計')
  })
})

describe('非公開フォルダ: list', () => {
  it('lists the folders with who can see and edit them', async () => {
    mockApi(routes())
    renderInCompany(<PrivateFoldersPage />)
    const list = await screen.findByRole('list', { name: '非公開フォルダ' })
    expect(within(list).getByText('人事部 / 評価')).toBeInTheDocument()
    expect(within(list).getAllByText('3人')).toHaveLength(2)
    expect(within(list).getByText('佐藤 花子')).toBeInTheDocument()
  })

  it('shows the next step when there are none', async () => {
    mockApi(routes({ [`GET ${base}/private-folders`]: { body: ok([]) } }))
    renderInCompany(<PrivateFoldersPage />)
    expect(await screen.findByText('非公開フォルダはまだありません')).toBeInTheDocument()
  })
})

describe('非公開フォルダ: create', () => {
  it('creates with the default viewers (creator + the department managers) and the summary line', async () => {
    const api = mockApi(
      routes({
        [`POST ${base}/private-folders`]: {
          status: 201,
          body: ok({ ...evaluationDetail, scopeId: 's_new', path: '営業部/顧客対応' }),
        },
      })
    )
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()

    // 営業部's manager 田中 is the default viewer; owners/admins (2) are implied.
    expect(within(within(dialog).getByRole('list', { name: '見られる人' })).getByText('田中 太郎')).toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('このフォルダとその中身は 3 人にだけ届きます')

    await userEvent.type(within(dialog).getByLabelText('名前'), '顧客対応')
    expect(within(dialog).getByText('作成する場所：営業部/顧客対応')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: '作成' }))

    await waitFor(() => expect(posted(api.calls, '/private-folders')).toHaveLength(1))
    expect(posted(api.calls, '/private-folders')[0].body).toEqual({ parentPath: '営業部', name: '顧客対応', viewers: ['u_member'] })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('sends a subset of editors for 指定した人だけ', async () => {
    const api = mockApi(routes({ [`POST ${base}/private-folders`]: { status: 201, body: ok(evaluationDetail) } }))
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()
    await userEvent.type(within(dialog).getByLabelText('名前'), '顧客対応')
    await userEvent.click(within(dialog).getByRole('radio', { name: /指定した人だけ/ }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: '田中 太郎' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('編集できるのは 2 人です')
    await userEvent.click(within(dialog).getByRole('button', { name: '作成' }))
    await waitFor(() => expect(posted(api.calls, '/private-folders')).toHaveLength(1))
    expect(posted(api.calls, '/private-folders')[0].body).toEqual({ parentPath: '営業部', name: '顧客対応', viewers: ['u_member'], editors: [] })
  })

  it('shows the server sentence for a name that is taken, without saying why', async () => {
    const message = '『営業部/提案書』というフォルダ名は使えません。別の名前にしてください。'
    mockApi(routes({ [`POST ${base}/private-folders`]: { status: 409, body: { error: message, code: 'FOLDER_NAME_UNAVAILABLE' } } }))
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()
    await userEvent.type(within(dialog).getByLabelText('名前'), '提案書')
    await userEvent.click(within(dialog).getByRole('button', { name: '作成' }))
    expect(await within(dialog).findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('refuses names the folder rules do not allow before sending', async () => {
    const api = mockApi(routes())
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()
    await userEvent.type(within(dialog).getByLabelText('名前'), 'a/b')
    expect(within(dialog).getByText(/使えない文字/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '作成' })).toBeDisabled()
    expect(posted(api.calls, '/private-folders')).toHaveLength(0)
  })

  it('explains outdated apps for the first private folder and lets an owner create anyway', async () => {
    const calls: unknown[] = []
    const api = mockApi(
      routes({
        [`POST ${base}/private-folders`]: () => {
          calls.push(1)
          return calls.length === 1
            ? {
                status: 409,
                body: {
                  error: 'Some members use a desktop app that cannot handle private folders yet; ask them to update the app first',
                  code: 'OUTDATED_CLIENTS',
                  canForce: true,
                  members: [{ userId: 'u_member', name: '田中 太郎', email: 'tanaka@example.com', role: 'member', clientVersion: null, version: '不明', lastSeenAt: null }],
                },
              }
            : { status: 201, body: ok(evaluationDetail) }
        },
      })
    )
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()
    await userEvent.type(within(dialog).getByLabelText('名前'), '顧客対応')
    await userEvent.click(within(dialog).getByRole('button', { name: '作成' }))
    const outdated = await screen.findByRole('dialog', { name: /アプリの更新が必要なメンバーがいます/ })
    expect(outdated).toHaveTextContent('非公開フォルダを扱えません')
    await userEvent.click(within(outdated).getByRole('button', { name: 'それでも作成する' }))
    await waitFor(() => expect(posted(api.calls, '/private-folders')).toHaveLength(2))
    expect(posted(api.calls, '/private-folders')[1].body).toMatchObject({ force: true, name: '顧客対応' })
  })

  it('a manager starts in their own department and cannot make folders public', async () => {
    mockApi(routes({}, companyRoutes(managerCapabilities)))
    renderInCompany(<PrivateFoldersPage />)
    expect(await screen.findByText('あなたが責任者を務める部署の中だけで作成・変更できます。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /のその他の操作/ })).not.toBeInTheDocument()
    await userEvent.click((await screen.findAllByRole('button', { name: /非公開フォルダを作成/ }))[0])
    const dialog = await screen.findByRole('dialog')
    // The only root is 営業部: its folders are listed straight away.
    expect(await within(dialog).findByText('提案書')).toBeInTheDocument()
    expect(within(within(dialog).getByRole('navigation', { name: '作成する場所' })).queryByText('株式会社サンプル')).not.toBeInTheDocument()
  })
})

describe('非公開フォルダ: 公開に戻す', () => {
  it('asks for the folder name and says everyone will get the contents', async () => {
    const api = mockApi(routes({ [`POST ${base}/private-folders/s_eval/make-public`]: { body: ok({ path: '人事部/評価', commit: 'abc' }) } }))
    renderInCompany(<PrivateFoldersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '人事部 / 評価 のその他の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '公開に戻す…' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('このフォルダの中身がすべて、会社の全員に届きます。取り消せません。')
    expect(dialog).toHaveTextContent('非公開だったあいだの変更の履歴はサーバーに控えとして保管され、誰にも配られません。')
    const confirm = within(dialog).getByRole('button', { name: '公開に戻す' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByRole('textbox'), '評価')
    await userEvent.click(confirm)
    await waitFor(() => expect(posted(api.calls, '/make-public')).toHaveLength(1))
  })
})

describe('非公開フォルダ: 削除', () => {
  it('asks for the folder name, explains the archive, sends DELETE and reloads the list', async () => {
    const success = vi.spyOn(toast, 'success')
    let listed = [evaluation]
    const api = mockApi(
      routes({
        [`GET ${base}/private-folders`]: () => ({ body: ok(listed) }),
        [`DELETE ${base}/private-folders/s_eval?confirm=評価`]: () => {
          listed = []
          return { body: ok({ path: '人事部/評価', archived: true }) }
        },
      })
    )
    renderInCompany(<PrivateFoldersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '人事部 / 評価 のその他の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '削除…' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('このフォルダとその中身が、見られる人全員のPCから消えます。')
    expect(dialog).toHaveTextContent('サーバーには控え（アーカイブ）が残り')
    const confirm = within(dialog).getByRole('button', { name: '削除' })
    expect(confirm).toBeDisabled()
    await userEvent.type(within(dialog).getByRole('textbox'), '評価')
    await userEvent.click(confirm)
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1))
    await waitFor(() => expect(success).toHaveBeenCalledWith('「人事部 / 評価」を削除しました', expect.anything()))
    expect(await screen.findByText('非公開フォルダはまだありません')).toBeInTheDocument()
  })

  it('keeps the dialog open and says what to do when the server refuses', async () => {
    const error = vi.spyOn(toast, 'error')
    mockApi(
      routes({
        [`DELETE ${base}/private-folders/s_eval?confirm=評価`]: {
          status: 503,
          body: { error: 'A push to this folder is still running; try again in a moment', code: 'BUSY' },
        },
      })
    )
    renderInCompany(<PrivateFoldersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '人事部 / 評価 のその他の操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '削除…' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByRole('textbox'), '評価')
    await userEvent.click(within(dialog).getByRole('button', { name: '削除' }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('削除できませんでした', {
        description: 'いま誰かがこのフォルダを同期しています。少し待ってからもう一度お試しください。',
      })
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('is not offered to department managers', async () => {
    mockApi(routes({}, companyRoutes(managerCapabilities)))
    renderInCompany(<PrivateFoldersPage />)
    await screen.findByRole('list', { name: '非公開フォルダ' })
    expect(screen.queryByRole('button', { name: /のその他の操作/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: '削除…' })).not.toBeInTheDocument()
  })
})

describe('非公開フォルダ: 非公開フォルダについて', () => {
  it('opens the help from the page header with every point', async () => {
    mockApi(routes())
    renderInCompany(<PrivateFoldersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '非公開フォルダについて' }))
    const dialog = await screen.findByRole('dialog', { name: '非公開フォルダについて' })
    const items = within(dialog).getAllByRole('listitem')
    expect(items).toHaveLength(PRIVATE_FOLDER_HELP.length)
    expect(dialog).toHaveTextContent('パスワードやAPIキーは、非公開フォルダにも置かないでください。')
    expect(dialog).toHaveTextContent('AIに送った内容は、各自のAIサービスのアカウントにも送られます。')
  })

  it('is linked from the create dialog, which says who else can see and manage the folder', async () => {
    mockApi(routes())
    renderInCompany(<PrivateFoldersPage />)
    const dialog = await openCreateAndPickSales()
    expect(dialog).toHaveTextContent('オーナーと管理者は常に見られます。')
    expect(dialog).toHaveTextContent('この部署の責任者は、見られる人をあとから変更でき、自分を加えることもできます。')
    await userEvent.click(within(dialog).getByRole('button', { name: '非公開フォルダについて' }))
    expect(await screen.findByRole('dialog', { name: '非公開フォルダについて' })).toBeInTheDocument()
  })

  it('is the same text as the desktop app (client/shared/private-folder-help.ts)', () => {
    expect(clientHelp.PRIVATE_FOLDER_HELP).toEqual(PRIVATE_FOLDER_HELP)
    expect(clientHelp.PRIVATE_FOLDER_HELP_TITLE).toBe(PRIVATE_FOLDER_HELP_TITLE)
    expect(clientHelp.REMOVED_VIEWER_CAVEAT).toBe(REMOVED_VIEWER_CAVEAT)
    expect(clientHelp.MANAGERS_MAY_CHANGE_VIEWERS).toBe(MANAGERS_MAY_CHANGE_VIEWERS)
  })
})

describe('非公開フォルダ: 見られる人を変更', () => {
  it('warns that removed people lose the folder at their next sync, then saves', async () => {
    const api = mockApi(routes({ [`PUT ${base}/private-folders/s_eval/members`]: { body: ok({ ...evaluationDetail, members: evaluationDetail.members.slice(0, 2) }) } }))
    renderInCompany(<PrivateFoldersPage />)
    await userEvent.click(await screen.findByRole('button', { name: '見られる人' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(await within(dialog).findByRole('button', { name: '田中 太郎を外す' }))
    expect(within(dialog).getByText(/田中 太郎の手元からは、次の同期でこのフォルダが削除されます/)).toHaveTextContent(
      'ただし、それまでにその人のPCに届いた内容（コピー、バックアップ、AIとの会話の記録）は取り消せません。'
    )
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/members'))).toBe(true))
    expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ viewers: [] })
  })
})

describe('権限: private folders in the tree', () => {
  const privateScope: PermissionScope = {
    id: 's_eval',
    path: '人事部/評価',
    kind: 'folder',
    departmentId: 'd_hr',
    repoId: 'repo_1',
    inherited: false,
    rules: [
      { id: 'r_eval_everyone', subjectType: 'everyone', subjectId: null, subjectLabel: '全員', canRead: false, canWrite: false },
      { id: 'r_eval_tanaka', subjectType: 'user', subjectId: 'u_member', subjectLabel: '田中 太郎', canRead: true, canWrite: true },
    ],
    effectiveSummary: 'restricted',
    inheritedFrom: null,
  }

  it('marks the private folder and shows who can see it instead of the general editor', async () => {
    mockApi(
      routes({
        [`GET ${base}/permissions`]: { body: ok({ scopes: [...permissionScopes, privateScope], orphanedScopes: [] }) },
        [`GET ${base}/permissions/effective?path=`]: { body: ok(effectiveAt('', '', ['u_member'])) },
      })
    )
    renderInCompany(<PermissionsPage />)
    const tree = await screen.findByRole('tree')
    const row = within(tree)
      .getAllByRole('button')
      .find((b) => b.hasAttribute('data-tree-row') && b.textContent?.startsWith('評価'))
    expect(row).toBeDefined()
    expect(row).toHaveTextContent('非公開')
    await userEvent.click(row!)
    expect(await screen.findByRole('heading', { name: '評価 の設定' })).toBeInTheDocument()
    const viewers = await screen.findByRole('list', { name: '見られる人' })
    expect(within(viewers).getByText('田中 太郎')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /全員/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '見られる人を変更' })).toBeEnabled()
  })
})

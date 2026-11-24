// 「預かり」 (private-folders.md "Holding: review", A1): the tab is shown only with something to review,
// the take-in's choice becomes the request body (backups and 本人のメモ never ticked by default, never
// 上書き unless chosen), 捨てる asks first and says what is lost, and every refusal code is said in plain
// words. Everything shown comes from the review API's answer.
import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

import OverviewPage from '@/app/companies/[id]/page'
import FoldersPage from '@/app/companies/[id]/folders/page'
import { ApiError, attachmentName, type HoldingReviewDetail, type HoldingReviewFile, type HoldingReviewItem } from '@/lib/api'
import { defaultSelection, describeHoldingError, takeRequest } from '@/lib/holding'
import { base, companyRoutes, renderInCompany } from './company-harness'
import { COMPANY_ID, homeOf, managerCapabilities, ok, quietOverview } from './fixtures'
import { mockApi, type Call } from './mock-api'

const nav = vi.hoisted(() => ({ search: 'tab=holding' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/companies/${COMPANY_ID}/folders`,
  useSearchParams: () => new URLSearchParams(nav.search),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const DAY = 24 * 60 * 60 * 1000

const item: HoldingReviewItem = {
  itemId: 'hi_1',
  scopeId: 's_eval',
  folderPath: '人事部/評価',
  folderGone: false,
  userId: 'u_member',
  userName: '田中 太郎',
  cause: 'readers',
  state: 'waiting',
  receivedAt: new Date(Date.now() - 2 * DAY).toISOString(),
  expiresAt: new Date(Date.now() + 28 * DAY - 60_000).toISOString(),
  counts: { changed: 2, deleted: 1, backup: 1, personal: 1, namesOnly: 1 },
  bytes: 1234,
}

const file = (over: Partial<HoldingReviewFile> & Pick<HoldingReviewFile, 'idx' | 'path' | 'kind'>): HoldingReviewFile => ({
  size: 100,
  label: null,
  held: true,
  dropped: null,
  takeable: true,
  standing: 'unchanged',
  inFolderNow: true,
  ...over,
})

const files: HoldingReviewFile[] = [
  file({ idx: 0, path: '面談メモ.md', kind: 'changed' }),
  file({ idx: 1, path: '評価表.xlsx', kind: 'changed', standing: 'changed' }),
  file({ idx: 2, path: '古い下書き.md', kind: 'deleted', held: false, size: 0 }),
  file({ idx: 3, path: '面談メモ.md', kind: 'backup', label: '同期のぶつかり 11/20' }),
  file({ idx: 4, path: '.personal/メモ.md', kind: 'personal', takeable: false }),
  file({ idx: 5, path: '.env', kind: 'names-only', held: false, takeable: false, dropped: 'secret' }),
]

const detail: HoldingReviewDetail = { ...item, files }

const LIST = `GET ${base}/holding`
const DETAIL = `GET ${base}/holding/hi_1`
const TAKE = `POST ${base}/holding/hi_1/take`
const DISCARD = `POST ${base}/holding/hi_1/discard`

function routes(extra: Parameters<typeof mockApi>[0] = {}, caps = companyRoutes()) {
  return {
    ...caps,
    [LIST]: { body: ok({ items: [item] }) },
    [DETAIL]: { body: ok(detail) },
    ...extra,
  }
}

const posts = (calls: Call[], suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(suffix))

async function openItem() {
  nav.search = 'tab=holding'
  renderInCompany(<FoldersPage />)
  const list = await screen.findByRole('list', { name: '預かっているもの' })
  await userEvent.click(within(list).getByRole('button', { name: '中身を確かめる' }))
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText('評価表.xlsx')
  return dialog
}

const box = (dialog: HTMLElement, path: string, group: string) =>
  within(within(dialog).getByRole('region', { name: group })).queryByRole('checkbox', { name: `${path} をフォルダに入れる` })

describe('預かり: the tab', () => {
  it('is hidden when there is nothing to review, and shows the count when there is', async () => {
    nav.search = ''
    const { calls } = mockApi({ ...routes({ [LIST]: { body: ok({ items: [] }) } }), [`GET ${base}/permissions`]: { body: ok([]) } })
    const { unmount } = renderInCompany(<FoldersPage />)
    await screen.findByRole('link', { name: 'だれが変えられるか' })
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/holding'))).toBe(true))
    expect(screen.queryByRole('link', { name: /預かり/ })).toBeNull()
    unmount()

    mockApi({ ...routes(), [`GET ${base}/permissions`]: { body: ok([]) } })
    renderInCompany(<FoldersPage />)
    const tab = await screen.findByRole('link', { name: /預かり/ })
    expect(tab).toHaveAttribute('href', `/companies/${COMPANY_ID}/folders?tab=holding`)
    expect(tab).toHaveTextContent('1')
  })

  it('lists who handed it over, why, and when it is discarded — from the API\'s answer', async () => {
    nav.search = 'tab=holding'
    mockApi(routes())
    renderInCompany(<FoldersPage />)
    const list = await screen.findByRole('list', { name: '預かっているもの' })
    expect(within(list).getByText(/田中 太郎さん・.*・見る人から外れたとき/)).toBeInTheDocument()
    expect(within(list).getByText('人事部 / 評価')).toBeInTheDocument()
    expect(within(list).getByText('あと28日で自動的に捨てます')).toBeInTheDocument()
  })

  it('says so when nothing is held', async () => {
    nav.search = 'tab=holding'
    mockApi(routes({ [LIST]: { body: ok({ items: [] }) } }))
    renderInCompany(<FoldersPage />)
    expect(await screen.findByText('預かっているものはありません。')).toBeInTheDocument()
  })
})

describe('預かり: taking in', () => {
  it('ticks the unsent changes only; backups, 本人のメモ and names only are not ticked or cannot be', async () => {
    mockApi(routes())
    const dialog = await openItem()
    const changes = 'まだ届けていなかった変更'
    expect(box(dialog, '面談メモ.md', changes)).toBeChecked()
    expect(box(dialog, '評価表.xlsx', changes)).toBeChecked()
    expect(box(dialog, '古い下書き.md', changes)).toBeChecked()
    expect(box(dialog, '面談メモ.md', '田中 太郎さんの版（バックアップ）')).not.toBeChecked()
    expect(box(dialog, '.personal/メモ.md', '本人のメモ（フォルダには入れられません）')).toBeNull()
    expect(box(dialog, '.env', '預かれなかったファイル（名前だけ）')).toBeNull()
  })

  it('sends the ticked entries, placed alongside a later change unless 「上書きする」 is chosen', async () => {
    const { calls } = mockApi(routes({ [TAKE]: { body: ok({ state: 'taken', commit: 'abc', placed: [], skipped: [] }) } }))
    const dialog = await openItem()
    // Not the backup, but untick a deletion: the body follows the ticks.
    await userEvent.click(box(dialog, '古い下書き.md', 'まだ届けていなかった変更')!)
    const group = within(dialog).getByRole('radiogroup', { name: 'その後ほかの人が変えたファイル' })
    expect(within(group).getByRole('radio', { name: /田中 太郎さんの版」として並べて置く/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(within(dialog).getByRole('button', { name: /フォルダに入れる（2件）/ }))
    await waitFor(() => expect(posts(calls, '/take')).toHaveLength(1))
    expect(posts(calls, '/take')[0].body).toEqual({ files: [0, 1], whenChanged: 'alongside' })
  })

  it('sends 「上書きする」 only when chosen, and offers it only when a ticked file was changed since', async () => {
    const { calls } = mockApi(routes({ [TAKE]: { body: ok({ state: 'taken', commit: 'abc', placed: [], skipped: [] }) } }))
    const dialog = await openItem()
    await userEvent.click(within(dialog).getByRole('radio', { name: /上書きする/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: /フォルダに入れる（3件）/ }))
    await waitFor(() => expect(posts(calls, '/take')).toHaveLength(1))
    expect(posts(calls, '/take')[0].body).toEqual({ files: [0, 1, 2], whenChanged: 'overwrite' })
  })

  it('hides the overwrite choice when no ticked file meets a later change', async () => {
    mockApi(routes())
    const dialog = await openItem()
    expect(within(dialog).getByRole('radiogroup', { name: 'その後ほかの人が変えたファイル' })).toBeInTheDocument()
    await userEvent.click(box(dialog, '評価表.xlsx', 'まだ届けていなかった変更')!)
    expect(within(dialog).queryByRole('radiogroup', { name: 'その後ほかの人が変えたファイル' })).toBeNull()
  })

  it('offers only download and discard for a folder that is gone', async () => {
    mockApi(routes({ [DETAIL]: { body: ok({ ...detail, folderGone: true, files: files.map((f) => ({ ...f, takeable: false })) }) } }))
    const dialog = await openItem()
    expect(within(dialog).getByText('このフォルダはもうありません')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /フォルダに入れる/ })).toBeNull()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(dialog).getByRole('button', { name: /捨てる/ })).toBeEnabled()
  })
})

describe('預かり: discarding asks first', () => {
  it('says what is lost, and sends nothing until confirmed', async () => {
    const { calls } = mockApi(routes({ [DISCARD]: { body: ok({ state: 'discarded' }) } }))
    const dialog = await openItem()
    await userEvent.click(within(dialog).getByRole('button', { name: /捨てる/ }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm).toHaveTextContent('元に戻せません')
    expect(confirm).toHaveTextContent('6件')
    await userEvent.click(within(confirm).getByRole('button', { name: 'やめる' }))
    expect(posts(calls, '/discard')).toHaveLength(0)

    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /捨てる/ }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '捨てる' }))
    await waitFor(() => expect(posts(calls, '/discard')).toHaveLength(1))
  })
})

describe('預かり: refusals', () => {
  it('someone decided first: says so, closes and reads the list again', async () => {
    const error = vi.spyOn(toast, 'error')
    const { calls } = mockApi(routes({ [TAKE]: { status: 409, body: { error: 'ほかの人が先に決めました。', code: 'ALREADY_DECIDED' } } }))
    const dialog = await openItem()
    const listReads = () => calls.filter((c) => c.method === 'GET' && c.url.endsWith(`${base}/holding`)).length
    const before = listReads()
    await userEvent.click(within(dialog).getByRole('button', { name: /フォルダに入れる/ }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('ほかの人が先に決めました。一覧を読み込み直しました。'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(listReads()).toBeGreaterThan(before))
  })

  it('a file with no place now: says so in plain words, marks and unticks it, reads the item again', async () => {
    const { calls } = mockApi(routes({ [TAKE]: { status: 409, body: { error: '…', code: 'PATH_TAKEN', files: [1] } } }))
    const dialog = await openItem()
    await userEvent.click(within(dialog).getByRole('button', { name: /フォルダに入れる（3件）/ }))
    expect(await within(dialog).findByText(/置けないファイルがありました/)).toBeInTheDocument()
    expect(within(dialog).getByText('このファイルは入れられません')).toBeInTheDocument()
    await waitFor(() => expect(box(dialog, '評価表.xlsx', 'まだ届けていなかった変更')).not.toBeChecked())
    expect(box(dialog, '面談メモ.md', 'まだ届けていなかった変更')).toBeChecked()
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/holding/hi_1')).length).toBe(2))
  })

  it('maps each code to its own sentence, never Git words', () => {
    const err = (status: number, code?: string, extra: Record<string, unknown> = {}) =>
      new ApiError(status, 'x', code ? { error: 'x', code, ...extra } : { error: 'Not found' })
    expect(describeHoldingError(err(503, 'BUSY')).message).toMatch(/フォルダが使われているため/)
    expect(describeHoldingError(err(409, 'FOLDER_GONE')).message).toMatch(/ダウンロードするか捨てることだけ/)
    expect(describeHoldingError(err(410, 'EXPIRED'))).toMatchObject({ gone: true, message: expect.stringMatching(/30日/) })
    expect(describeHoldingError(err(404))).toMatchObject({ gone: true })
    expect(describeHoldingError(err(400, 'NOT_TAKEABLE', { files: [4, 'x'] }))).toMatchObject({ gone: false, files: [4] })
    expect(describeHoldingError(err(409, 'PATH_TAKEN', { files: [1] }))).toMatchObject({ gone: false, files: [1] })
    const refused = new ApiError(409, 'フォルダに入れられないファイルがありました（理由: パスワードなどが入っています）。預かったものはそのまま残しています。', {
      code: 'TAKE_REFUSED',
    })
    expect(describeHoldingError(refused).message).toMatch(/理由: パスワードなどが入っています/)
    // A refusal the console does not know is never shown as the server's raw text.
    expect(describeHoldingError(new ApiError(409, '[WRITE_DENIED] path', { code: 'TAKE_REFUSED' })).message).not.toMatch(/WRITE_DENIED/)
    for (const code of ['BUSY', 'FOLDER_GONE', 'PATH_TAKEN', 'NOT_TAKEABLE', 'ALREADY_DECIDED', 'EXPIRED', 'INVALID']) {
      expect(describeHoldingError(err(409, code)).message).not.toMatch(/コミット|プッシュ|push|commit|git/i)
    }
  })

  it('never sends an entry the server did not mark takeable, whatever is ticked', () => {
    expect(takeRequest(files, new Set([0, 3, 4, 5]), false)).toEqual({ files: [0, 3], whenChanged: 'alongside' })
    expect(defaultSelection(files, false)).toEqual(new Set([0, 1, 2]))
    expect(defaultSelection(files, true)).toEqual(new Set())
  })
})

describe('預かり: downloads', () => {
  it('saves under the entry\'s own name, never a path the header might carry', () => {
    expect(attachmentName(`attachment; filename*=UTF-8''${encodeURIComponent('評価表.xlsx')}`, 'file')).toBe('評価表.xlsx')
    expect(attachmentName(`attachment; filename*=UTF-8''${encodeURIComponent('../../x/y.txt')}`, 'file')).toBe('y.txt')
    expect(attachmentName(null, 'fallback.md')).toBe('fallback.md')
    expect(attachmentName("attachment; filename*=UTF-8''%E0%A4%A", 'fallback.md')).toBe('fallback.md')
  })
})

describe('預かり: the home', () => {
  it('counts what waits, says what expires within 7 days, and leads to the tab', async () => {
    const home = homeOf(quietOverview)
    mockApi({
      ...companyRoutes(),
      [`GET ${base}/home`]: { body: ok({ ...home, attention: { ...home.attention, holding: { waiting: 3, expiringSoon: 1 } } }) },
    })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('預かったファイルを確かめてください')).toBeInTheDocument()
    expect(screen.getByText('3件')).toBeInTheDocument()
    expect(screen.getByText(/うち1件は、あと7日以内に自動的に捨てます/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /預かりを開く/ })).toHaveAttribute('href', `/companies/${COMPANY_ID}/folders?tab=holding`)
  })

  it('shows nothing for a server without the holding place, or nothing waiting (a manager too)', async () => {
    const home = homeOf(quietOverview, { view: 'manager', setup: null, departments: [{ id: 'd_sales', name: '営業部' }] })
    mockApi({ ...companyRoutes(managerCapabilities), [`GET ${base}/home`]: { body: ok({ ...home, attention: { ...home.attention, holding: { waiting: 0, expiringSoon: 0 } } }) } })
    renderInCompany(<OverviewPage />)
    expect(await screen.findByText('対応が必要なことはありません')).toBeInTheDocument()
    expect(screen.queryByText('預かったファイルを確かめてください')).toBeNull()
  })
})

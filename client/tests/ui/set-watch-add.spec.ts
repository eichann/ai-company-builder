// 「会議のあとの見張りを足す」 in 設定 →「定期の仕事」 (4b-4 PR6b, src/features/jobs/components/SetWatchAdd.tsx) on
// tests/download-folders-ui.html?manual=1&tab=jobs. Guards: the member chooses the Skill it runs and the Skills it reads, and
// only then may ask for the 案; the 案 is shown in the 受け取る words before anything is sent; 「これで管理者に出す」 sends exactly
// the candidate and fingerprint shown; nothing is sent to an owner / admin without that press.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('choose, see the 案 in the 受け取る words, then send exactly what was shown', async ({ page }) => {
  const state = await openPreview(page, 'download-folders', { manual: '1', tab: 'jobs' })
  await page.getByRole('button', { name: '見張りを足す' }).click()
  // The one Skill with its reasons is chosen by itself; the other is offered to read.
  await expect(page.getByRole('radio', { name: 'sales-proposal-auto（法人ソリューション）' })).toBeChecked()
  const make = page.getByRole('button', { name: '案を作る' })
  await expect(make).toBeEnabled()
  await page.getByRole('checkbox', { name: 'sales-proposal-v1（法人ソリューション）' }).check()
  await make.click()
  // Three lines first (使い心地のメモ #37); every line of the consent stays behind ［くわしく］.
  const summary = page.getByRole('list', { name: '見張りの案（要点）' })
  await expect(summary.getByRole('listitem')).toHaveCount(3)
  await expect(summary).toContainText('あなたが担当の「議事録を確認する」が完了したあと')
  await expect(summary).toContainText('［反映する］を押すまで')
  const lines = page.getByRole('list', { name: '見張りの案', exact: true })
  await expect(lines).toHaveCount(0)
  await page.getByRole('button', { name: 'くわしく' }).click()
  await expect(lines).toContainText('これから来る')
  await expect(lines).toContainText('動く条件：')
  await expect(lines).toContainText('提案を求められた')
  // Nothing sent to an owner / admin yet: only the choice was asked of the server.
  const sent = () => page.evaluate(() => (window as unknown as { __acbSetWatch: unknown[] }).__acbSetWatch)
  expect(await sent()).toHaveLength(1)
  expect((await sent())[0]).toMatchObject({ skill: { place: '法人ソリューション', skill: 'sales-proposal-auto' }, readSkills: [{ place: '法人ソリューション', skill: 'sales-proposal-v1' }] })
  await page.getByRole('button', { name: 'これで管理者に出す' }).click()
  await expect(page.getByRole('status').filter({ hasText: '管理者に出しました' })).toBeVisible()
  expect((await sent())[1]).toEqual({ candidateId: `jc.${'5'.repeat(32)}`, fingerprint: `sha256:${'f'.repeat(64)}` })
  expectNoPageErrors(state)
})

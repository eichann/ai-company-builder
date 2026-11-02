// The task card (tests/task-card-ui.tsx, features/tasks, tasks-ui.md "The card"). Guards: what the
// AI prepared is on top; on a task to be checked first the assignee completes only by naming whose
// OK (from 未着手 too since task version 9, at the version shown); 受けられない needs a reason; 延ばす sends a new due; a
// run with an unknown outside result is settled by the member; the completed card states the OK
// in words; the 自分だけ and 例外（この件だけ） marks show; 「部署に出す」 is offered only on an
// owner-only task and sends the chosen department at the version shown; the source slot shows what the screen gives
// and stays hidden without it.
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('prepared things on top; completing on whose OK; 受けられない needs a reason; 延ばす; an unknown result settled', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('region', { name: 'AI が用意したもの' })).toContainText('窓口を3つにした下書き')
  await expect(page.getByTestId('prepared')).toHaveText('用意したもの：お礼メール')
  await expect(card).toContainText('自分だけ')
  await expect(card.getByRole('complementary', { name: 'つながっているもの' })).toContainText('例外（この件だけ）')

  // 確かめてから: the one main action is 「終わったので見てもらう」; completing on an OK given elsewhere is in 「…」.
  await expect(card.getByRole('button', { name: '終わったので見てもらう' })).toBeVisible()
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /完了にする（OK をもらった）/ }).click()
  const form = page.getByRole('dialog', { name: '完了にする（OK をもらった）' })
  const submit = form.getByRole('button', { name: '完了にする（OK をもらった）' })
  await expect(submit).toBeDisabled()
  await form.getByLabel('OK をくれた人').selectOption({ label: '阿部さん' })
  await submit.click()
  await expect(page.locator('#acted')).toHaveText('complete@3:ok=u-abe/')

  // Everything else is behind 「…」, each with what it does; leaving the list says what happens and who is told first.
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await expect(page.getByRole('menuitem', { name: /受けられない（頼んだ人に返す）/ })).toContainText('わけを添えて、阿部さんに返します')
  await page.getByRole('menuitem', { name: /受けられない（頼んだ人に返す）/ }).click()
  const decline = page.getByRole('dialog', { name: '頼んだ人に返しますか？' })
  await expect(decline).toContainText('知らせる人阿部さん（わけも届きます）')
  await expect(decline.getByRole('button', { name: '受けられない（頼んだ人に返す）' })).toBeDisabled()
  await decline.getByLabel('理由').fill('今週は手が空かないため')
  await decline.getByRole('button', { name: '受けられない（頼んだ人に返す）' }).click()
  await expect(page.locator('#acted')).toContainText('decline@3:今週は手が空かないため')
  const returned = page.getByRole('status').filter({ hasText: '阿部さんに返しました' })
  await returned.getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toContainText('undo 4@4')

  await page.getByRole('button', { name: '延ばす' }).click()
  await page.getByRole('group', { name: '延ばす' }).getByRole('button', { name: /あしたの朝/ }).click()
  await expect(page.locator('#acted')).toContainText(/set_due@3:due=\d{4}-\d{2}-\d{2}T09:00/)

  await page.getByRole('button', { name: '届いていなかった' }).click()
  await expect(page.locator('#acted')).toContainText('reconcile run-1 mail-send-1 false')
  expectNoPageErrors(state)
})

test('a task completed on someone\'s OK says so in words, never as an approval', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { task: 'done' })
  const card = page.getByTestId('task-card')
  await expect(card).toContainText('佐藤さんが阿部さんの了承を得たとして完了にしました（電話で）')
  await card.getByRole('button', { name: /経緯/ }).click()
  await expect(card.getByRole('region', { name: '経緯' })).toContainText('佐藤さんが阿部さんの了承を得たとして完了にしました')
  expectNoPageErrors(state)
})

test('「＋ファイルをつなぐ」 links a company file; a linked file is taken away from its 「…」 and put back; a dropped file is linked', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  await page.getByRole('button', { name: 'ファイルをつなぐ' }).click()
  const picker = page.getByRole('group', { name: 'つなぐファイル' })
  await picker.getByLabel('ファイルを探す').fill('提案')
  await expect(picker.getByRole('button')).toHaveCount(1)
  await picker.getByRole('button', { name: /提案書\.md/ }).click()
  await expect(page.locator('#acted')).toHaveText('link 営業/提案書.md@3')

  await page.getByRole('button', { name: '「見積書_v2.xlsx」の操作' }).click()
  await page.getByRole('menuitem', { name: /つながりを外す/ }).click()
  await expect(page.locator('#acted')).toContainText('unlink 営業/見積書_v2.xlsx@3')
  const undone = page.getByRole('status').filter({ hasText: '「見積書_v2.xlsx」とのつながりを外しました' })
  await undone.getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toContainText('unlink 営業/見積書_v2.xlsx@3,link 営業/見積書_v2.xlsx@3')

  const card = page.getByRole('complementary', { name: 'つながっているもの' })
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.setData('application/x-file-paths', JSON.stringify(['/Users/elsewhere/x.md', '/Users/me/company/経理/請求書.xlsx']))
    return dt
  })
  await card.dispatchEvent('dragover', { dataTransfer: data })
  await card.dispatchEvent('drop', { dataTransfer: data })
  await expect(page.locator('#acted')).toContainText('link 経理/請求書.xlsx@3')
  expectNoPageErrors(state)
})

test('the source slot shows what the screen gives for the task, and nothing without it', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { source: '1' })
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('region', { name: '元のやりとり' })).toContainText('元のメール：A社 見積書を 150万円 で作り直す')
  expectNoPageErrors(state)

  const plain = await openPreview(page, 'task-card')
  await expect(card.getByRole('region', { name: 'AI が用意したもの' })).toBeVisible()
  await expect(card.getByRole('region', { name: '元のやりとり' })).toHaveCount(0)
  expectNoPageErrors(plain)
})

test('「部署に出す」 on an owner-only task sends the chosen department; a shared task does not offer it', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  await page.getByRole('button', { name: '部署に出す' }).click()
  const form = page.getByRole('group', { name: '部署に出す' })
  const submit = form.getByRole('button', { name: 'この部署に出す' })
  await expect(submit).toBeDisabled()
  await form.getByLabel('出す先の部署').selectOption({ label: '経理部' })
  await expect(form).toContainText('「経理部」を見られる人みんなに見えるようになります。あとから「自分だけ」には戻せません。')
  await submit.click()
  await expect(page.locator('#acted')).toHaveText('share 経理@3')
  expectNoPageErrors(state)

  const sharedState = await openPreview(page, 'task-card', { shared: '1' })
  await expect(page.getByTestId('task-card')).toContainText('A社 見積書')
  await expect(page.getByRole('button', { name: '部署に出す' })).toHaveCount(0)
  expectNoPageErrors(sharedState)
})

test('「相談する」 on the card (no consultation yet) asks for a consultation about this task', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { consult: 'none' })
  await expect(page.getByRole('button', { name: '新しい相談' })).toHaveCount(0)
  await page.getByRole('button', { name: '相談する' }).click()
  await expect(page.locator('#acted')).toHaveText('consult task-0000aa')
  expectNoPageErrors(state)
})

// Owner 2026-11-02: tags could only be added (quick add, AI suggestions), never removed or added
// later by hand. Guards: the field opens an editor for who may set tags; × removes one; a tag in
// use is picked rather than a near spelling; a new word only from 「新しいタグにする」; the AI's
// suggestions inside it; the server's refusal shown; a 案件's name offers ［案件につなぐ］; a finished
// task's tags are read only.
test('「タグ」: removed with ×, picked from the tags in use, a new word only when chosen, AI suggestions inside', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: /^タグ：営業、見積/ }).click()
  const editor = card.getByRole('group', { name: 'タグを変える' })
  await editor.getByRole('button', { name: '#見積 を外す' }).click()
  await expect(page.locator('#acted')).toHaveText('set_tags@3:tags=営業')

  // 「けいり」 is not in use; 「経」 matches 経理 — Enter picks the tag in use, never a near spelling.
  const input = editor.getByRole('textbox', { name: 'タグを足す' })
  await input.fill('経')
  await expect(editor.getByRole('option', { name: /#経理/ })).toBeVisible()
  await input.press('Enter')
  await expect(page.locator('#acted')).toHaveText('set_tags@3:tags=営業,set_tags@3:tags=営業|見積|経理')

  // Nothing in use matches: Enter adds the new word.
  await input.fill('急ぎ')
  await expect(editor.getByRole('option')).toHaveText(['「急ぎ」を新しいタグにする'])
  await input.press('Enter')
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|急ぎ')

  // The server's refusal, in its words.
  await input.fill('禁止')
  await input.press('Enter')
  await expect(editor.getByRole('alert')).toHaveText('このタグは付けられません。')

  await editor.getByRole('button', { name: 'AI にタグの候補を出してもらう' }).click()
  await editor.getByRole('button', { name: '#経理 を付ける' }).click()
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|経理')
  expectNoPageErrors(state)

  const done = await openPreview(page, 'task-card', { task: 'done' })
  await expect(page.getByTestId('task-card')).toContainText('了承を得たとして')
  await expect(page.getByRole('button', { name: /^タグ：/ })).toHaveCount(0)
  await expect(page.getByTestId('task-card')).toContainText('#営業 #見積')
  expectNoPageErrors(done)
})

test('「タグ」: a word that is a 案件\'s name offers ［案件につなぐ］ (the same link), adding it as a tag stays possible', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: /^タグ：/ }).click()
  const editor = card.getByRole('group', { name: 'タグを変える' })
  await editor.getByRole('textbox', { name: 'タグを足す' }).fill('B社 新人研修')
  await expect(editor.getByRole('note')).toContainText('『B社 新人研修』は案件の名前です。案件につなぎますか？')
  await editor.getByRole('note').getByRole('button', { name: '案件につなぐ' }).click()
  await expect(page.locator('#acted')).toHaveText('link task-0000aa bundle=deal-0002cd@3')
  await editor.getByRole('textbox', { name: 'タグを足す' }).fill('B社 新人研修')
  await editor.getByRole('option', { name: /新しいタグにする/ }).click()
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|B社 新人研修')
  expectNoPageErrors(state)
})

test('someone changed it first: the card says who and what, and that the press did not happen', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { conflict: '1' })
  await page.getByRole('button', { name: '延ばす' }).click()
  await page.getByRole('group', { name: '延ばす' }).getByRole('button', { name: /あしたの朝/ }).click()
  const alert = page.getByTestId('task-card').getByRole('alert')
  await expect(alert).toContainText('阿部さんが先に変えました。最新を読み込みました。もう一度押してください')
  await expect(alert).toContainText('変わったところ：阿部：期限を変える')
  expectNoPageErrors(state)
})

test('where it came from and 「終わったら」 are on the card before anything is pressed', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await expect(card).toContainText('終わったら：確かめる人に見てもらう（その人の OK で完了）')
  await expect(card.getByRole('article')).toContainText('A社 問い合わせ対応の効率化')
  await expect(card.getByRole('complementary', { name: 'つながっているもの' })).not.toContainText('A社 問い合わせ対応の効率化')
  expectNoPageErrors(state)
})

test('a link is taken off from its 「…」 and put back; where it came from has no 「…」', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const side = page.getByRole('complementary', { name: 'つながっているもの' })
  await expect(side.getByRole('button', { name: '「A社 打ち合わせ」の操作' })).toHaveCount(0)
  await side.getByRole('button', { name: '「スケジュール案を出す」の操作' }).click()
  await page.getByRole('menuitem', { name: /つながりを外す/ }).click()
  await expect(page.locator('#acted')).toHaveText('unlink task-0000aa related=task-0000bb@3')
  const done = page.getByRole('status').filter({ hasText: '「スケジュール案を出す」とのつながりを外しました' })
  await done.getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toContainText('undo 4@4')
  expectNoPageErrors(state)
})

test('its 案件: ［変える］ picks another, ［外す］ takes it off with 取り消す', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const field = page.getByTestId('task-card').getByRole('group', { name: '記録' })
  await field.getByRole('button', { name: '変える' }).click()
  const picker = page.getByRole('dialog', { name: '記録につなぐ' })
  await expect(picker.getByRole('button', { name: /A社 問い合わせ対応の効率化/ })).toBeDisabled()
  await picker.getByRole('button', { name: /B社 新人研修/ }).click()
  await expect(page.locator('#acted')).toHaveText('link task-0000aa bundle=deal-0002cd@3')
  await field.getByRole('button', { name: '外す' }).click()
  await expect(page.locator('#acted')).toContainText('unlink task-0000aa bundle=deal-0001ab@3')
  await expect(page.getByRole('status').filter({ hasText: '「A社 問い合わせ対応の効率化」から外しました' })).toBeVisible()
  expectNoPageErrors(state)
})

test('「議事録を確認する」: the summary, the AI\'s proposals added all at once or picked, put away and back, decisions checked', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { task: 'review' })
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('region', { name: '要約（AI）' })).toContainText('窓口を3つに増やす方向で合意。')
  await expect(card.getByRole('button', { name: '確認を終える' })).toBeVisible()
  const proposals = card.getByRole('region', { name: 'AI のタスクの案' })
  await expect(proposals).toContainText('見積を直す佐藤さん・11/7 17:00')
  await proposals.getByRole('button', { name: '全部足す' }).click()
  await expect(page.locator('#acted')).toHaveText('adopt@1,adopt@1')

  await proposals.getByRole('button', { name: '選んで足す' }).click()
  await proposals.getByLabel('見積を直す を選ぶ').uncheck()
  await proposals.getByRole('button', { name: '選んだものを足す' }).click()
  await expect(page.locator('#acted')).toHaveText('adopt@1,adopt@1,adopt@1')

  await proposals.getByRole('listitem').filter({ hasText: '会食の店を探す' }).getByRole('button', { name: '戻す' }).click()
  await expect(page.locator('#acted')).toContainText('propose_again@2')

  const decisions = card.getByRole('region', { name: '決めたこと（AI が残した）' })
  await expect(decisions.getByRole('listitem').filter({ hasText: '4月から始める' }).getByRole('button')).toHaveCount(1)
  await decisions.getByRole('listitem').filter({ hasText: '窓口は3つにする' }).getByRole('button', { name: '確かめる' }).click()
  await expect(page.locator('#acted')).toContainText('confirm@3')
  expectNoPageErrors(state)
})

test('who can see it at the top right; 「AIへの相談」 on the right with its consultations and only ［＋新しい相談］', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await expect(card.locator('[data-seen]')).toHaveText('あなただけ')
  const group = card.getByRole('complementary', { name: 'つながっているもの' }).getByRole('region', { name: 'AIへの相談' })
  await expect(group).toContainText('見積の相談')
  await expect(group.getByRole('button', { name: '相談する' })).toHaveCount(0)
  await group.getByRole('button', { name: '新しい相談' }).click()
  await expect(page.locator('#acted')).toHaveText('consult task-0000aa fresh')
  expectNoPageErrors(state)
})

test('no 案件 yet: 〇〇 is the department\'s kind; ［新しい案件にする］ makes one from the task\'s title and puts the task in', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { bundle: 'none' })
  const field = page.getByTestId('task-card').getByRole('group', { name: '案件' })
  await expect(field.getByRole('button', { name: '案件につなぐ' })).toBeVisible()
  await field.getByRole('button', { name: '新しい案件にする' }).click()
  const dialog = page.getByRole('dialog', { name: '新しい案件にする' })
  await expect(dialog.getByLabel('名前')).toHaveValue('A社 見積書を 150万円 で作り直す')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: '作る' }).click()
  await expect(page.locator('#acted')).toHaveText('create deal A社 見積書を 150万円 で作り直す folder=営業部,link task-0000aa bundle=deal-0009zz@3')
  expectNoPageErrors(state)
})

// 返事待ち with its 見込み (task version 12, tasks-ui.md "返事待ち and its 見込み"). Screenshots for the PR:
// SCREENSHOTS=<dir> writes the wait chooser and the came-back card there.
const shots = process.env.SCREENSHOTS

test('返事待ちにする asks what and until when: chips set the date; nothing chosen sends none (the server sets 3 business days)', async ({ page }) => {
  // Monday 2026-11-02 10:00 in Japan (11-03 is 文化の日).
  await page.clock.install({ time: new Date('2026-11-02T01:00:00Z') })
  const state = await openPreview(page, 'task-card', { task: 'todo-team' })
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /返事待ちにする/ }).click()
  const dialog = page.getByRole('dialog', { name: '返事待ちにしますか？' })
  const chips = dialog.getByRole('group', { name: 'いつごろ来そうか' })
  await expect(chips.getByRole('button', { name: /次の営業日/ })).toContainText('11/4')
  await expect(chips.getByRole('button', { name: /3日後/ })).toContainText('11/6')
  await expect(chips.getByRole('button', { name: /来週/ })).toContainText('11/9')
  await expect(dialog).toContainText('選ばなければ 3営業日後（11/6）にします')
  await dialog.getByLabel('待っているもの').fill('先方からの返事')
  await chips.getByRole('button', { name: /来週/ }).click()
  if (shots) await dialog.screenshot({ path: `${shots}/wait-chooser.png` })
  await dialog.getByRole('button', { name: '返事待ちにする' }).click()
  await expect(page.locator('#acted')).toHaveText('wait@3:on=先方からの返事:until=2026-11-09')
  await expect(page.getByRole('status').filter({ hasText: '返事待ちにしました（11/9 ごろまで）' })).toBeVisible()

  // Nothing chosen: no date goes (the server's default).
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /返事待ちにする/ }).click()
  await page.getByLabel('待っているもの').fill('見積の回答')
  await page.getByRole('dialog', { name: '返事待ちにしますか？' }).getByRole('button', { name: '返事待ちにする' }).click()
  await expect(page.locator('#acted')).toHaveText('wait@3:on=先方からの返事:until=2026-11-09,wait@3:on=見積の回答')
  expectNoPageErrors(state)
})

test('while waiting the card shows the 見込み, and ［見込みを変える］ sets a new one', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-02T01:00:00Z') })
  const state = await openPreview(page, 'task-card', { task: 'waiting' })
  const band = page.getByRole('region', { name: '返事待ち' })
  await expect(band).toContainText('返事待ち：先方からの返事（11/6 ごろまで）')
  await band.getByRole('button', { name: '見込みを変える' }).click()
  await expect(band.getByRole('button', { name: 'この日にする' })).toBeDisabled()
  await band.getByRole('button', { name: '日を選ぶ' }).click()
  await band.getByLabel('見込みの日').fill('2026-11-12')
  await band.getByRole('button', { name: 'この日にする' }).click()
  await expect(page.locator('#acted')).toHaveText('set_wait_until@3:until=2026-11-12')
  expectNoPageErrors(state)
})

test('given back by the clock: 「先方からの返事が来ていません（3日）」, 経緯 says why, and 催促の下書き / もう少し待つ / 完了にする', async ({ page }) => {
  // Saturday 2026-11-07 09:00 in Japan: waited since Mon 11-02 → Wed, Thu, Fri (Tue was 文化の日).
  await page.clock.install({ time: new Date('2026-11-07T00:00:00Z') })
  const state = await openPreview(page, 'task-card', { task: 'back' })
  const card = page.getByTestId('task-card')
  const band = card.getByRole('region', { name: '返事が来ていません' })
  await expect(band).toContainText('先方からの返事が来ていません（3日）')
  await expect(band).toContainText('返事の見込み（11/6）を過ぎたので、あなたの番に戻りました。')
  await card.getByRole('button', { name: /経緯/ }).click()
  await expect(card.getByRole('region', { name: '経緯' })).toContainText('ACB の時計：返事の見込み（11/6）を過ぎました')
  if (shots) await card.screenshot({ path: `${shots}/came-back-card.png` })

  await band.getByRole('button', { name: '催促の下書きを作る' }).click()
  await expect(page.locator('#acted')).toHaveText('nudge task-0000ww')
  await band.getByRole('button', { name: 'もう少し待つ' }).click()
  const again = page.getByRole('dialog', { name: 'もう少し待ちますか？' })
  await expect(again.getByLabel('待っているもの')).toHaveValue('先方からの返事')
  await again.getByRole('group', { name: 'いつごろ来そうか' }).getByRole('button', { name: /3日後/ }).click()
  await again.getByRole('button', { name: 'もう少し待つ' }).click()
  await expect(page.locator('#acted')).toHaveText('nudge task-0000ww,wait@3:on=先方からの返事:until=2026-11-11')
  await band.getByRole('button', { name: '完了にする' }).click()
  await expect(page.locator('#acted')).toContainText('complete@3')
  expectNoPageErrors(state)
})

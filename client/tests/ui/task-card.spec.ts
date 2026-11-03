// The task card (tests/task-card-ui.tsx, features/tasks, tasks-ui.md "The card"). Guards: what the
// AI prepared is on top; on a task to be checked first the assignee completes only by naming whose
// OK (from 未着手 too since task version 9, at the version shown); 受けられない needs a reason; 延ばす sends a new due; a
// run with an unknown outside result is settled by the member; the completed card states the OK
// in words; 「あなただけ」 said once (top right, never a chip beside the state) and 例外（この件だけ） show; 「部署に出す」 is offered only on an
// owner-only task and sends the chosen department at the version shown; the source slot shows what the screen gives
// only on a task linking the 来た連絡 it came from; 返事待ちにする is in 「…」 without チームの進め方; the 「…」 of
// 2026-11-03 (アーカイブ and ［戻す］, 「終わったら」 as one item, 「自分が担当する」 on top, 要らない only on a proposal).
import { test, expect } from '@playwright/test'
import { expectNoPageErrors, openPreview } from './helpers'

test('prepared things on top; completing on whose OK; 受けられない needs a reason; 延ばす; an unknown result settled', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await expect(card.getByRole('region', { name: 'AI が用意したもの' })).toContainText('窓口を3つにした下書き')
  await expect(page.getByTestId('prepared')).toHaveText('用意したもの：お礼メール')
  // 「あなただけ」 once, top right (見られる人); no second chip beside 未着手 (owner 2026-11-03).
  await expect(card.getByText('あなただけ', { exact: true })).toHaveCount(1)
  await expect(card).not.toContainText('自分だけ')
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

test('「＋ファイル・フォルダをつなぐ」 links a company file; a linked file is taken away from its 「…」 and put back; a dropped file is linked', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  await page.getByRole('button', { name: 'ファイル・フォルダをつなぐ' }).click()
  const picker = page.getByRole('group', { name: 'つなぐファイル・フォルダ' })
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
  await expect(page.locator('#acted')).toContainText('drop task-0000aa 経理/請求書.xlsx target:files')
  expectNoPageErrors(state)
})

test('the source slot shows what the screen gives only for a task that came from a 来た連絡 (no もとの連絡 block on a task made by hand)', async ({ page }) => {
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
  await expect(form).toContainText('「経理部」を見られる人みんなに見えるようになります。あとから「あなただけ」には戻せません。')
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

// Owner 2026-11-02: tags could only be added, never removed or added later by hand; 2026-11-03
// (使い心地のメモ #6): the editor was 「ダサい」 — now pills in the field and a small popover combobox.
// Guards: × on a pill removes one; the popover opens from the field (or ＋), lists the company's
// tags with ✓ on the task's own (picking a checked one takes it off), ↑↓ Enter pick, a tag in use
// is taken rather than a near spelling, 「『〇〇』を作る」 only when nothing is that word; the AI's
// suggestions are a quiet row inside it; Esc and a press outside close it; the server's refusal
// shows; a 案件's name offers ［案件につなぐ］; a finished task's tags are read only.
// SCREENSHOTS=<dir> writes the field and the popover (light and dark).
test('「タグ」: pills with ×, a popover combobox (✓, ↑↓ Enter, 作る), AI suggestions inside, Esc / outside closes', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: '#見積 を外す' }).click()
  await expect(page.locator('#acted')).toHaveText('set_tags@3:tags=営業')

  const opener = card.getByRole('button', { name: /^タグを足す・外す/ })
  await expect(opener).toHaveAttribute('aria-label', 'タグを足す・外す（いま：営業、見積）')
  await opener.click()
  const popover = page.getByRole('dialog', { name: 'タグ' })
  const input = popover.getByRole('combobox', { name: 'タグを探す・作る' })
  await expect(input).toBeFocused()
  // The task's own tags checked first, then the tags in use; the AI's suggestion as one quiet row.
  await expect(popover.getByRole('option')).toHaveText(['#営業', '#見積', '#経理'])
  await expect(popover.getByRole('option', { name: '#営業' })).toHaveAttribute('aria-selected', 'true')
  await expect(popover.getByRole('option', { name: '#経理' })).toHaveAttribute('aria-selected', 'false')
  await expect(popover).toContainText('合いそうなタグ：#経理')
  if (process.env.SCREENSHOTS) {
    await page.setViewportSize({ width: 1100, height: 900 })
    await card.screenshot({ path: `${process.env.SCREENSHOTS}/tag-popover.png` })
  }

  // ↓↓ Enter on 経理 adds it (a tag in use, never a near spelling).
  await input.press('ArrowDown')
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.locator('#acted')).toHaveText('set_tags@3:tags=営業,set_tags@3:tags=営業|見積|経理')
  // Picking a checked one takes it off.
  await popover.getByRole('option', { name: '#営業' }).click()
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=見積')

  // Typing filters; a word nothing is gets 「『〇〇』を作る」 as the last row, and Enter makes it.
  await input.fill('経')
  await expect(popover.getByRole('option')).toHaveText(['#経理', '「経」を作る'])
  await input.fill('急ぎ')
  await expect(popover.getByRole('option')).toHaveText(['「急ぎ」を作る'])
  await input.press('Enter')
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|急ぎ')

  // The server's refusal, in its words, inside the popover.
  await input.fill('禁止')
  await input.press('Enter')
  await expect(popover.getByRole('alert')).toHaveText('このタグは付けられません。')

  // The AI's suggestion adds only when picked.
  await popover.getByRole('button', { name: '#経理 を付ける（AI の候補）' }).click()
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|経理')

  // Esc closes; so does a press outside.
  await input.press('Escape')
  await expect(popover).toHaveCount(0)
  await opener.click()
  await expect(popover).toBeVisible()
  await card.getByRole('heading').first().click()
  await expect(popover).toHaveCount(0)
  expectNoPageErrors(state)

  const done = await openPreview(page, 'task-card', { task: 'done' })
  await expect(page.getByTestId('task-card')).toContainText('了承を得たとして')
  await expect(page.getByRole('button', { name: /^タグを足す・外す/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /を外す$/ })).toHaveCount(0)
  await expect(page.getByTestId('task-card')).toContainText('#営業')
  expectNoPageErrors(done)
})

test('「タグ」: a word that is a 案件\'s name offers ［案件につなぐ］ (the same link), adding it as a tag stays possible', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: /^タグを足す・外す/ }).click()
  const popover = page.getByRole('dialog', { name: 'タグ' })
  const input = popover.getByRole('combobox', { name: 'タグを探す・作る' })
  await input.fill('B社 新人研修')
  await expect(popover.getByRole('note')).toContainText('『B社 新人研修』は案件の名前です。')
  await popover.getByRole('note').getByRole('button', { name: '案件につなぐ' }).click()
  await expect(page.locator('#acted')).toHaveText('link task-0000aa bundle=deal-0002cd@3')
  await input.fill('B社 新人研修')
  await popover.getByRole('option', { name: /を作る/ }).click()
  await expect(page.locator('#acted')).toContainText('set_tags@3:tags=営業|見積|B社 新人研修')
  expectNoPageErrors(state)
})

// 「延ばす」 (使い心地のメモ #7): more choices, and the popover closes on Esc and on a press outside.
test('「延ばす」: more choices; Esc and a press outside close it', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  const button = card.getByRole('button', { name: '延ばす' })
  const choices = page.getByRole('group', { name: '延ばす' })
  await button.click()
  await expect(choices.getByRole('button', { name: /あしたの朝/ })).toBeVisible()
  await expect(choices.getByRole('button', { name: /来月のはじめ/ })).toBeVisible()
  await expect(choices.getByRole('button', { name: /2週間後/ })).toBeVisible()
  if (process.env.SCREENSHOTS) await card.screenshot({ path: `${process.env.SCREENSHOTS}/postpone.png` })
  await page.keyboard.press('Escape')
  await expect(choices).toHaveCount(0)
  await button.click()
  await expect(choices).toBeVisible()
  await card.getByRole('heading').first().click()
  await expect(choices).toHaveCount(0)
  // The ＋ファイル・フォルダをつなぐ picker closes the same way.
  await card.getByRole('button', { name: 'ファイル・フォルダをつなぐ' }).click()
  const picker = card.getByRole('group', { name: 'つなぐファイル・フォルダ' })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
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

test('返事待ちにする is in 「…」 without チームの進め方, on the member\'s own task too, with the same window (owner decision 2026-11-03)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-02T01:00:00Z') })
  const state = await openPreview(page, 'task-card', { task: 'todo-own' })
  const card = page.getByTestId('task-card')
  // Nothing added to the main view: the main button is still 完了にする.
  await expect(card.getByRole('button', { name: '返事待ちにする' })).toHaveCount(0)
  if (shots) await page.screenshot({ path: `${shots}/task-card-own.png`, fullPage: true })
  await card.getByRole('button', { name: 'その他の操作' }).click()
  const item = page.getByRole('menuitem', { name: /返事待ちにする/ })
  await expect(item).toBeVisible()
  if (shots) await page.screenshot({ path: `${shots}/more-menu-wait.png` })
  await item.click()
  const dialog = page.getByRole('dialog', { name: '返事待ちにしますか？' })
  await dialog.getByRole('group', { name: 'いつごろ来そうか' }).getByRole('button', { name: /3日後/ }).click()
  await dialog.getByRole('button', { name: '返事待ちにする' }).click()
  await expect(page.locator('#acted')).toHaveText('wait@3:on=相手からの返事:until=2026-11-06')
  // A task made by hand links no 来た連絡: no もとの連絡 block.
  await expect(card.getByRole('region', { name: '元のやりとり' })).toHaveCount(0)
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

// The 「…」 decisions of 2026-11-03 (tasks-ui.md "The card" 4.). SCREENSHOTS=<dir> writes the menu, the
// 「終わったら」 chooser and the archived card.
test('「…」 on a task nobody holds: 自分が担当する first; 終わったら is one item; アーカイブ in normal colour; no 要らない', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { task: 'unassigned' })
  const card = page.getByTestId('task-card')
  await card.getByRole('button', { name: 'その他の操作' }).click()
  const items = page.getByRole('menuitem')
  await expect(items.first()).toContainText('自分が担当する')
  await expect(page.getByRole('menuitem', { name: /^終わったら/ })).toContainText('いまは「知らせるだけ」')
  await expect(page.getByRole('menuitem', { name: /確かめる人を決める|終わったらを決める|要らない|やめる/ })).toHaveCount(0)
  const archive = page.getByRole('menuitem', { name: /アーカイブ/ })
  await expect(archive).toContainText('一覧から外します。消しません。［戻す］で元に戻せます')
  await expect(archive.locator('.text-rose-600')).toHaveCount(0)
  if (shots) await page.screenshot({ path: `${shots}/task-menu.png` })

  // 自分が担当する: one press, assigned to the member with the note the type requires.
  await items.first().click()
  await expect(page.locator('#acted')).toHaveText('assign@3:自分が担当します:assignee=u-sato')
  await expect(page.getByRole('status').filter({ hasText: '自分が担当になりました' })).toBeVisible()

  // 終わったら → 〇〇さんに確かめてもらう: the person and 確かめてから in one go, each at the next version.
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /^終わったら/ }).click()
  const chooser = page.getByRole('dialog', { name: '終わったら' })
  await expect(chooser.getByRole('button', { name: '決める' })).toBeDisabled()
  await chooser.getByLabel('確かめる人').selectOption({ label: '阿部さん' })
  await expect(chooser).toContainText('阿部さんに確かめてもらう')
  if (shots) await chooser.screenshot({ path: `${shots}/when-done-chooser.png` })
  await chooser.getByRole('button', { name: '決める' }).click()
  await expect(page.locator('#acted')).toHaveText('assign@3:自分が担当します:assignee=u-sato,set_reviewer@3:reviewer=u-abe,set_when_done@4:when_done=check')

  // アーカイブ: what happens and who is told first; the type asks a reason.
  await card.getByRole('button', { name: 'その他の操作' }).click()
  await page.getByRole('menuitem', { name: /アーカイブ/ }).click()
  const confirm = page.getByRole('dialog', { name: 'アーカイブしますか？' })
  await expect(confirm).toContainText('一覧から外します。消しません。［戻す］で元に戻せます')
  await confirm.getByLabel('理由').fill('今回は見送り')
  await confirm.getByRole('button', { name: 'アーカイブ' }).click()
  await expect(page.locator('#acted')).toContainText(',cancel@3:今回は見送り')
  await expect(page.getByRole('status').filter({ hasText: 'アーカイブしました' })).toBeVisible()
  expectNoPageErrors(state)
})

test('an archived task: 「アーカイブ済み」, ［戻す］ brings it back, 経緯 says 「佐藤さんがアーカイブしました」', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { task: 'archived' })
  const card = page.getByTestId('task-card')
  await expect(card).toContainText('アーカイブ済み')
  await card.getByRole('button', { name: /経緯/ }).click()
  await expect(card.getByRole('region', { name: '経緯' })).toContainText('佐藤さんがアーカイブしました（先方の都合で見送り）')
  if (shots) await page.screenshot({ path: `${shots}/task-archived.png`, fullPage: true })
  await card.getByRole('button', { name: '戻す' }).click()
  await expect(page.locator('#acted')).toHaveText('reopen@3')
  await expect(page.getByRole('status').filter({ hasText: '一覧に戻しました' })).toBeVisible()
  expectNoPageErrors(state)
})

// ［＋ 新しいファイル］ (owner decision 2026-11-03, tasks-ui.md "A new file on a task only the member sees"):
// only on an owner-only task; the name window offers the title; the file is made in today's folder by the
// screen, linked at the version shown and opened (`file.open` = the active tab). A `.personal/` link row says
// 「あなたの Mac だけにあるファイル」 instead of 「つながりが切れています」. SCREENSHOTS=<dir> writes the card and the window.
test('［＋ 新しいファイル］ only on an owner-only task: named, made in today\'s folder, linked, opened; .personal rows say so', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const card = page.getByTestId('task-card')
  const links = card.getByRole('complementary', { name: 'つながっているもの' })
  await expect(links).toContainText('打ち合わせメモ.md')
  await expect(links).toContainText('あなたの Mac だけにあるファイル')
  await expect(links).not.toContainText('つながりが切れています')
  if (shots) await card.screenshot({ path: `${shots}/task-card-new-file.png` })

  await links.getByRole('button', { name: '新しいファイル' }).click()
  await expect(page.getByRole('heading', { name: '新しいファイル（今日のフォルダ・あなたの Mac だけ）' })).toBeVisible()
  const input = page.getByPlaceholder('メモ.md')
  const create = page.getByRole('button', { name: '作成', exact: true })
  await expect(input).toHaveValue('A社 見積書を 150万円 で作り直す.md')
  if (shots) await page.screenshot({ path: `${shots}/task-card-new-file-dialog.png` })
  // A taken name keeps the window open with the reason; nothing is linked or opened.
  await input.fill('既存.md')
  await create.click()
  await expect(page.getByRole('alert')).toContainText('同じ名前のファイルまたはフォルダがすでにあります')
  await expect(page.locator('#acted')).toHaveText('today 既存.md')
  await input.fill('見積メモ.md')
  await create.click()
  await expect(page.locator('#acted')).toHaveText('today 既存.md,today 見積メモ.md,link 営業/.personal/inbox/日付別/2026/20261103/見積メモ.md@3,open /Users/me/company/営業/.personal/inbox/日付別/2026/20261103/見積メモ.md')
  await expect(input).toHaveCount(0)
  expectNoPageErrors(state)
})

test('a task shown to a department keeps only ［ファイル・フォルダをつなぐ］', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { shared: '1' })
  const links = page.getByTestId('task-card').getByRole('complementary', { name: 'つながっているもの' })
  await expect(links.getByRole('button', { name: 'ファイル・フォルダをつなぐ' })).toBeVisible()
  await expect(links.getByRole('button', { name: '新しいファイル' })).toHaveCount(0)
  expectNoPageErrors(state)
})

// A consultation about the task can be taken off it from the card (「…」 on its row): the screen takes
// the topic off in the chat history, so the AI's new files are no longer linked to this task.
test('「このやることから外す」 on a consultation row of 「AIへの相談」', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const links = page.getByTestId('task-card').getByRole('complementary', { name: 'つながっているもの' })
  await links.getByRole('button', { name: '「見積の相談」の操作' }).click()
  await page.getByRole('menuitem', { name: /このやることから外す/ }).click()
  await expect(page.locator('#acted')).toHaveText('detach s-1')
  expectNoPageErrors(state)
})

// 「落とすと、つながります」 (owner decision 2026-11-03, tasks-ui.md "Dropping links"). What a row of the
// list, 探す, a tab or 「AIへの相談」 puts on a drag (`dragTypes.ts`) dropped on the card's 「つながっているもの」.
async function dropOnLinks(page: import('@playwright/test').Page, type: string, value: unknown) {
  const links = page.getByRole('complementary', { name: 'つながっているもの' })
  const data = await page.evaluateHandle(([t, v]) => { const dt = new DataTransfer(); dt.setData(t as string, JSON.stringify(v)); return dt }, [type, value] as const)
  await links.dispatchEvent('dragenter', { dataTransfer: data })
  await links.dispatchEvent('dragover', { dataTransfer: data })
  return { links, drop: () => links.dispatchEvent('drop', { dataTransfer: data }) }
}

test('a record dropped on the card links it with ［取り消す］; one no link allows is refused in one line', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const { links, drop } = await dropOnLinks(page, 'application/x-acb-record', { id: 'task-0000zz', title: '会場を押さえる' })
  await expect(links.locator('[data-link-drop-zone]')).toHaveText('ここに落とすと、つながります')
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/drop-over-card.png` })
  await drop()
  await expect(page.locator('#acted')).toHaveText('drop task-0000aa task-0000zz target:related')
  const done = links.getByRole('status').filter({ hasText: 'をつなぎました' })
  await done.getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toHaveText('drop task-0000aa task-0000zz target:related,undo 9@9')

  // The refusal shows at the drop zone it was dropped on (owner 2026-11-03, 使い心地のメモ #4), then fades.
  const refused = await dropOnLinks(page, 'application/x-acb-record', { id: 'decision-0000yy', title: '今回だけ値引き' })
  await refused.drop()
  const zone = links.locator('[data-link-drop-zone]')
  await expect(zone.getByRole('alert')).toHaveText('やることには決めたことはつなげません')
  await expect(links.getByRole('alert')).toHaveCount(1)
  await expect(page.locator('#acted')).not.toContainText('decision-0000yy')
  if (process.env.SCREENSHOTS) await links.screenshot({ path: `${process.env.SCREENSHOTS}/drop-refused-at-zone.png` })
  await expect(zone.getByRole('alert')).toHaveCount(0, { timeout: 8000 })
  expectNoPageErrors(state)
})

test('a consultation dropped on the card becomes one about this やること, and ［取り消す］ puts its topic back', async ({ page }) => {
  const state = await openPreview(page, 'task-card')
  const { links, drop } = await dropOnLinks(page, 'application/x-acb-consultation', { sessionId: 's-9', title: '会場の相談', topicRecordId: 'task-0000bb' })
  await drop()
  await expect(page.locator('#acted')).toHaveText('topic s-9=task-0000aa')
  const done = links.getByRole('status').filter({ hasText: '「会場の相談」をこのやることについての相談にしました' })
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/drop-consultation.png` })
  await done.getByRole('button', { name: '取り消す' }).click()
  await expect(page.locator('#acted')).toHaveText('topic s-9=task-0000aa,topic s-9=task-0000bb')
  expectNoPageErrors(state)
})

test('a folder from the tree is linked; linked folders open in the tree, say who cannot open them by count only, and one not downloaded is marked', async ({ page }) => {
  const state = await openPreview(page, 'task-card', { folders: '1' })
  const { links, drop } = await dropOnLinks(page, 'application/x-file-paths', ['/Users/me/company/営業/見積'])
  await drop()
  await expect(page.locator('#acted')).toHaveText('drop task-0000aa 営業/見積 target:files')
  const folders = links.getByRole('region', { name: 'フォルダ' })
  await expect(folders).toContainText('月次')
  await expect(folders).toContainText('2人はこのフォルダを開けません')
  await expect(folders).toContainText('この Mac には未ダウンロード')
  if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/folder-links.png` })
  await folders.getByRole('button', { name: /^月次/ }).click()
  await expect(page.locator('#acted')).toContainText('reveal /Users/me/company/経理/月次')
  expectNoPageErrors(state)
})

// A business plugin's four slots in Chromium (plugin-frame.md "The four slots"), with the test
// package tests/fixtures/plugins/slots-sample: ① a left tab with the declared name whose content
// is the plugin's frame, ② the peek over it drawn by the core from the task list, ③ a section in
// the record card of the declared type whose frame gets only the record id and reads through the
// bridge, ④ a file menu item for the declared kinds that opens the frame with the company path.
// Turning the plugin off hides every slot. Screenshots: PLUGIN_SLOTS_SHOTS=<dir>.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { pluginFrameCsp } from '../../shared/plugin-bridge'
import { expectNoPageErrors, openPreview } from './helpers'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugins', 'slots-sample')
const BASE = '/__plugin/slots-sample/0.1.0/ui/'
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' }
const SHOTS = process.env.PLUGIN_SLOTS_SHOTS

async function servePackage(page: Page) {
  const network: string[] = []
  await page.route('**/__fixture/slots-sample/plugin.yaml', route => route.fulfill({ status: 200, contentType: 'text/plain', body: fs.readFileSync(path.join(FIXTURE, 'plugin.yaml'), 'utf8') }))
  await page.route('**/__plugin/**', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : ''
    const file = name && /^[a-z]+\.(html|js|css)$/.test(name) ? path.join(FIXTURE, 'ui', name) : ''
    if (!file || !fs.existsSync(file)) { network.push(url.pathname); return route.fulfill({ status: 404, body: '' }) }
    return route.fulfill({
      status: 200, contentType: TYPES[name.split('.').pop()!], body: fs.readFileSync(file),
      headers: { 'Content-Security-Policy': pluginFrameCsp(`${url.origin}${BASE}`) },
    })
  })
  return network
}

const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `plugin-slots-${name}.png`) }) }

test('the four slots show the plugin\'s screens where it declared them, and none once it is turned off', async ({ page }) => {
  const network = await servePackage(page)
  const state = await openPreview(page, 'plugin-slots')
  const received = page.getByRole('list', { name: '本体が受け取ったもの' })

  // ③ The record card of type program_plan gets the 構成 section (not the task one); its frame
  // gets only the record id and reads the record through the bridge.
  const section = page.getByRole('region', { name: '構成' })
  await expect(section).toBeVisible()
  await expect(page.getByRole('region', { name: '番組のメモ' })).toHaveCount(0)
  const sectionFrame = page.frameLocator('iframe[title="構成"]')
  await expect(sectionFrame.locator('#context')).toHaveText('{"slot":"record_section","recordId":"program_plan-abc123"}')
  await expect(sectionFrame.locator('#answer')).toHaveText('記録：春の特番')
  await expect(received).toContainText('main co-preview slots-sample@0.1.0 records.get {"recordId":"program_plan-abc123"}')

  // ① The tab with the declared name, next to the core's; ② its peek on hover lists the member's
  // turn among items implementing `request` only, with the count on the tab.
  const tab = page.getByRole('button', { name: /番組/ })
  await expect(tab).toBeVisible()
  await expect(tab).toContainText('1')
  await tab.hover()
  const peek = page.getByRole('dialog', { name: '番組：あなたの番' })
  await expect(peek).toBeVisible()
  await expect(peek.getByRole('button')).toHaveText([/台本を確認する/])
  await shot(page, 'peek')
  await peek.getByRole('button', { name: /台本を確認する/ }).click()
  await expect(received).toContainText('open record task-aaa111')

  await tab.click()
  const tabFrame = page.frameLocator('iframe[title="番組"]')
  await expect(tabFrame.locator('#context')).toHaveText('{"slot":"tab"}')
  await expect(tabFrame.locator('#answer')).toHaveText('企画 3 件')
  await page.mouse.move(900, 700)
  await shot(page, 'tab')

  // ④ The file menu: the plugin's item on a PDF, not on a spreadsheet; it opens the frame with the company path.
  await page.getByRole('button', { name: 'ファイル' }).click()
  await page.getByRole('button', { name: '予算.xlsx' }).click({ button: 'right' })
  await expect(page.getByText('企画の資料にする')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '台本.pdf' }).click({ button: 'right' })
  await page.getByText('企画の資料にする').click()
  const dialog = page.getByRole('dialog', { name: '企画の資料にする' })
  await expect(dialog).toBeVisible()
  const actionFrame = page.frameLocator('iframe[title="企画の資料にする"]')
  await expect(actionFrame.locator('#context')).toHaveText('{"slot":"file_action","path":"企画/台本.pdf","isFolder":false}')
  await shot(page, 'file-action')

  // The company turns it off: the tab, the section and the open dialog go.
  await page.evaluate(() => (window as unknown as { __acbPlugins: { turnOff(): void } }).__acbPlugins.turnOff())
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /番組/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '構成' })).toHaveCount(0)
  await page.getByRole('button', { name: '台本.pdf' }).click({ button: 'right' })
  await expect(page.getByText('企画の資料にする')).toHaveCount(0)

  expect(network).toEqual([])
  expectNoPageErrors(state)
})

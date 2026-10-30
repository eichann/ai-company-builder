import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPathWithin } from './path'

const root = '/Users/me/ACB/会社'
const script = `${root}/コンテンツG/台本.md`
const proposal = `${root}/sales/提案.md`
const salesX = `${root}/sales-x/memo.md`

test('new files go to the selected department when the active tab is elsewhere', () => {
  assert.equal(isPathWithin(proposal, `${root}/sales`), true)
  assert.equal(isPathWithin(script, `${root}/sales`), false)
  assert.equal(isPathWithin(salesX, `${root}/sales`), false)
  assert.equal(isPathWithin(`${root}/sales`, `${root}/sales/`), true)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Lightning } from '@phosphor-icons/react'
import { resolveLeftPanel, shownPanels, type LeftPanel } from './leftPanels'

const panel = (id: string, extra: Partial<LeftPanel> = {}): LeftPanel =>
  ({ id, title: id, icon: Lightning, mount: 'once-opened', render: () => null, ...extra })
const PANELS = [panel('skills'), panel('files', { mount: 'always' }), panel('search'), panel('history')]

test('a remembered panel that is registered opens again', () => {
  for (const id of ['skills', 'files', 'search', 'history']) assert.equal(resolveLeftPanel(id, PANELS), id)
})

test('a remembered id no panel has (an extension since removed, a typo, nothing saved) opens the first panel', () => {
  for (const id of ['tasks', '', null, undefined, '__proto__']) assert.equal(resolveLeftPanel(id, PANELS), 'skills', String(id))
})

test('a hidden panel has no tab and is never opened; with nothing shown there is no panel', () => {
  const panels = [panel('tasks', { visible: false }), ...PANELS]
  assert.deepEqual(shownPanels(panels).map(p => p.id), ['skills', 'files', 'search', 'history'])
  assert.equal(resolveLeftPanel('tasks', panels), 'skills')
  assert.equal(resolveLeftPanel('skills', [panel('skills', { visible: false })]), null)
})

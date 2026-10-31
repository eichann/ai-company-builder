import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatPaneWith, publishChatPane, showInOtherChatPane } from './chatPanes'

// Two panes saving one consultation would overwrite each other's messages:
// a consultation open in one pane is shown there, never opened in another.
test('a consultation open in another pane is shown there; one open nowhere else is left to this pane', () => {
  const shown: string[] = []
  const removeLeft = publishChatPane('chat', ['a', 'b'], id => shown.push(`chat:${id}`))
  const removeRight = publishChatPane('right', ['c'], id => shown.push(`right:${id}`))

  assert.equal(showInOtherChatPane('a', 'right'), true)
  assert.deepEqual(shown, ['chat:a'])
  assert.equal(showInOtherChatPane('a', 'chat'), false, 'its own pane opens it itself')
  assert.equal(showInOtherChatPane('z', 'right'), false)
  assert.equal(chatPaneWith('c', 'chat'), 'right')

  // A pane publishes again when its tabs change; a closed pane no longer holds anything.
  publishChatPane('right', [], id => shown.push(`right:${id}`))
  assert.equal(chatPaneWith('c', 'chat'), undefined)
  removeRight()
  removeLeft()
  assert.equal(chatPaneWith('a', 'right'), undefined)
})


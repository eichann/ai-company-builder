import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesVoiceShortcut, validShortcut, shortcutFromEvent } from './voiceShortcut'

test('voice shortcut requires exact modifiers and ignores key repeat and IME', () => {
  const e = { code: 'KeyM', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, isComposing: false, repeat: false } as KeyboardEvent
  const shortcut = shortcutFromEvent(e)
  assert.ok(validShortcut(shortcut))
  assert.ok(matchesVoiceShortcut(e, shortcut))
  for (const changed of [{repeat:true},{isComposing:true},{altKey:true},{ctrlKey:true},{shiftKey:false},{code:'KeyU'}]) {
    assert.equal(matchesVoiceShortcut({...e,...changed},shortcut),false)
  }
  assert.equal(validShortcut({...shortcut,meta:false}),false)
  assert.equal(validShortcut({...shortcut,code:'Enter'}),false)
  assert.equal(validShortcut(null),false)
})

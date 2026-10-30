import { test } from 'node:test'
import assert from 'node:assert/strict'
import { brokerNoKeyMessage } from '../../../../shared/core/key-broker'
import { brokerKeyNeedsOf } from './brokerKeyNeeds'

test('a "no key" answer in a tool\'s output or the AI\'s text offers 「自分の鍵」 for that service, and only the service name is taken', () => {
  const relay = JSON.stringify({ type: 'error', error: { code: 'ACB_NO_KEY', message: brokerNoKeyMessage('Google Gemini', 'gemini') } })
  const parts = [
    { type: 'dynamic-tool', output: `Traceback …\ngoogle.genai.errors.ClientError: 403 ${relay}` },
    { type: 'tool-Bash', errorText: `Error code: 403 - {'error': {'message': '${brokerNoKeyMessage('OpenAI', 'openai')}'}}` },
    { type: 'text', text: `鍵がないようです。${brokerNoKeyMessage('Google Gemini', 'gemini')}` },
    // The member's own words and reasoning are not where the relay's answer arrives.
    { type: 'reasoning', text: brokerNoKeyMessage('Anthropic', 'anthropic') },
  ]
  assert.deepEqual(brokerKeyNeedsOf(parts), ['gemini', 'openai'])
  // Look-alikes that are not the marker (a key, a token, a bad name) give nothing.
  assert.deepEqual(brokerKeyNeedsOf([{ type: 'text', text: 'ACB_NO_KEY gemini [ACB_NO_KEY:GEMINI] [ACB_NO_KEY:acb_tok_x y]' }]), [])
})

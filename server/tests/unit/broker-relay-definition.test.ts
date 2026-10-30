/**
 * Unit Test: the input rules of a generic relay service (K9, shared/core/key-broker.ts).
 * These decide where a real key may be sent and in which header, so each
 * refusal below is a way the relay could otherwise become an open proxy or
 * leak the key.
 */
import { describe, it, expect } from 'vitest'
import {
  isValidRelayServiceId,
  normalizeRelayFormat,
  normalizeRelayHeaderName,
  parseBrokerRelayDefinition,
  parseRelayBaseUrl,
  readBrokerRelayDefinition,
  relayCredentialOf,
  relayCredentialValue,
} from '../../shared/core/key-broker'

describe('generic relay service ids', () => {
  it('lower-case words joined by single hyphens; never a built-in; no "_" (one ACB_<ID>_* name per service)', () => {
    for (const ok of ['hubspot', 'case-master', 'crm2', 'a1']) expect(isValidRelayServiceId(ok), ok).toBe(true)
    for (const bad of ['gemini', 'openai', 'anthropic', 'case_master', 'Case', '1crm', '-crm', 'crm-', 'a--b', 'x', 'a'.repeat(33), 'crm.v2', 'クラウド', '']) {
      expect(isValidRelayServiceId(bad), bad).toBe(false)
    }
  })
})

describe('the base URL fixes the one host', () => {
  it('https and an exact public name only', () => {
    expect(parseRelayBaseUrl('https://API.Example.com/v2/')).toEqual({ value: { host: 'api.example.com', basePath: '/v2' } })
    expect(parseRelayBaseUrl('https://api.example.com:443')).toEqual({ value: { host: 'api.example.com', basePath: '' } })
    for (const bad of [
      'http://api.example.com', 'ftp://api.example.com', '//api.example.com', 'api.example.com',
      'https://api.example.com:8443', 'https://user@api.example.com', 'https://u:p@api.example.com',
      'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://x.localhost', 'https://crm.local', 'https://crm.internal',
      'https://*.example.com', 'https://api.example.com/v2?x=1', 'https://api.example.com/#f', 'https://api.example.com/a/../b',
      'https://api.example.com/a%2fb', 'https://api.example.com/a b', 'https://api.example.com\\@evil.com', 'https://api.example.com//x',
    ]) {
      expect('error' in parseRelayBaseUrl(bad), bad).toBe(true)
    }
  })
})

describe('the header and its format', () => {
  it('a plain header name, never one that frames, routes or identifies the request', () => {
    expect(normalizeRelayHeaderName('X-ChatWorkToken')).toBe('x-chatworktoken')
    expect(normalizeRelayHeaderName('Authorization')).toBe('authorization')
    for (const bad of ['host', 'Cookie', 'set-cookie', 'connection', 'transfer-encoding', 'content-length', 'content-type', 'x-forwarded-host',
      'forwarded', 'x-acb-user', 'proxy-authorization', 'origin', 'accept-encoding', 'x-a b', 'x-a\r\nb', 'x:y', '']) {
      expect(normalizeRelayHeaderName(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('{key} exactly once, printable ASCII only (no header injection)', () => {
    expect(normalizeRelayFormat('Bearer {key}')).toBe('Bearer {key}')
    for (const bad of ['Bearer', '{key}{key}', 'Bearer {key}\r\nX-Evil: 1', 'Bearer\t{key}', 'ベアラー {key}', '']) {
      expect(normalizeRelayFormat(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(relayCredentialValue('Token token={key}', 'abc')).toBe('Token token=abc')
    expect(relayCredentialOf('Token token={key}', 'Token token=acb_tok_x')).toBe('acb_tok_x')
    expect(relayCredentialOf('Token token={key}', 'something-else')).toBe('something-else')
  })

  it('a stored definition that no longer passes the rules is not used', () => {
    const def = parseBrokerRelayDefinition({ label: 'CRM', baseUrl: 'https://api.example.com/v1', header: 'x-api-key' })
    expect(def).toEqual({ value: { label: 'CRM', host: 'api.example.com', basePath: '/v1', header: 'x-api-key', format: '{key}' } })
    expect(readBrokerRelayDefinition('value' in def ? def.value : null)).toEqual('value' in def ? def.value : null)
    expect(readBrokerRelayDefinition({ label: 'CRM', host: '10.0.0.1', basePath: '', header: 'x-api-key', format: '{key}' })).toBeNull()
    expect(readBrokerRelayDefinition({ label: 'CRM', host: 'api.example.com', basePath: '', header: 'host', format: '{key}' })).toBeNull()
  })
})

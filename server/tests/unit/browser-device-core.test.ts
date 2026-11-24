/**
 * The words of a PC's registration for 「ブラウザ操作」 (shared/core/browser-device.ts; agent-browser.md "This PC's
 * registration"): the key's one spelling, the PC's name, the moves, and the gate's one rule — an enabled registration of
 * that member, the plan on the registration that made it, and the transition exception for an owner only.
 */
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'crypto'
import {
  BROWSER_DEVICE_OWNER_TRANSITION, BROWSER_DEVICE_STATES, BROWSER_DEVICE_WORDS, browserDeviceDecision, browserDeviceMoveAllowed,
  normalizeBrowserDeviceLabel, parseBrowserDeviceKey,
} from '../../../shared/core/browser-device'

const newKey = () => `v1.${randomBytes(32).toString('base64url')}`

describe('the PC key header', () => {
  it('takes exactly v1. and 32 bytes of unpadded base64url, in its one spelling', () => {
    for (let i = 0; i < 50; i++) expect(parseBrowserDeviceKey(newKey())).not.toBeNull()
    const key = newKey()
    expect(parseBrowserDeviceKey(key)).toBe(key)
    const body = key.slice(3)
    for (const bad of [
      body, `v2.${body}`, `V1.${body}`, `v1.${body}=`, `v1.${body.slice(1)}`, `v1.${body}A`, ` ${key}`, `${key} `, `${key}\n`,
      `v1.${randomBytes(32).toString('base64')}`.replace(/[+/]/g, '+'), // standard base64 alphabet
      `v1.${body.slice(0, 42)}B`, // the last character's unused bits set: a second spelling of a key
      undefined, null, 1, '',
    ]) {
      expect(parseBrowserDeviceKey(bad), String(bad)).toBeNull()
    }
    // Every last character allowed is one whose two unused bits are zero.
    for (const c of 'AEIMQUYcgkosw048') expect(parseBrowserDeviceKey(`v1.${body.slice(0, 42)}${c}`)).not.toBeNull()
  })
})

describe('the PC name', () => {
  it('kept trimmed and NFC, 1–60 characters, no control or direction character', () => {
    expect(normalizeBrowserDeviceLabel('  阿部の MacBook Pro ')).toBe('阿部の MacBook Pro')
    expect(normalizeBrowserDeviceLabel('ガ'.normalize('NFD'))).toBe('ガ')
    expect(normalizeBrowserDeviceLabel('x'.repeat(60))).toBe('x'.repeat(60))
    for (const bad of ['', '   ', 'x'.repeat(61), 'a\nb', 'a\u202eb', 'a\u0000', 'a\u2066b', 1, null]) expect(normalizeBrowserDeviceLabel(bad)).toBeNull()
  })
})

describe('the moves', () => {
  it('pending → enabled / revoked, enabled → revoked; revoked is final, nothing goes back', () => {
    const allowed = BROWSER_DEVICE_STATES.flatMap(from => BROWSER_DEVICE_STATES.filter(to => browserDeviceMoveAllowed(from, to)).map(to => `${from}→${to}`))
    expect(allowed).toEqual(['pending→enabled', 'pending→revoked', 'enabled→revoked'])
  })
})

describe('the gate (browserDeviceDecision)', () => {
  const enabled = { id: 'bd_1', state: 'enabled' as const }
  it('an enabled registration of this member passes and names it; pending, stopped, none or a malformed key are refused', () => {
    for (const role of ['owner', 'admin', 'member']) {
      expect(browserDeviceDecision({ key: 'present', registration: enabled, role, plan: null })).toEqual({ ok: true, deviceId: 'bd_1' })
      expect(browserDeviceDecision({ key: 'present', registration: { id: 'bd_1', state: 'pending' }, role, plan: null })).toEqual({ ok: false, code: 'BROWSER_DEVICE_PENDING' })
      expect(browserDeviceDecision({ key: 'present', registration: { id: 'bd_1', state: 'revoked' }, role, plan: null })).toEqual({ ok: false, code: 'BROWSER_DEVICE_REVOKED' })
      expect(browserDeviceDecision({ key: 'present', registration: null, role, plan: null })).toEqual({ ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' })
      // A malformed key is never the transition exception, an owner's included.
      expect(browserDeviceDecision({ key: 'malformed', registration: enabled, role, plan: null })).toEqual({ ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' })
    }
  })

  it('no header: the transition exception lets an owner through (no registration), never an admin or a member, and not once it ends', () => {
    expect(BROWSER_DEVICE_OWNER_TRANSITION).toBe(true)
    expect(browserDeviceDecision({ key: 'absent', registration: null, role: 'owner', plan: null })).toEqual({ ok: true, deviceId: null })
    for (const role of ['admin', 'member', 'manager', '']) {
      expect(browserDeviceDecision({ key: 'absent', registration: null, role, plan: null })).toEqual({ ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' })
    }
    expect(browserDeviceDecision({ key: 'absent', registration: null, role: 'owner', plan: null, ownerTransition: false })).toEqual({ ok: false, code: 'BROWSER_DEVICE_NOT_REGISTERED' })
  })

  it('a plan goes on only on the registration that made it', () => {
    expect(browserDeviceDecision({ key: 'present', registration: enabled, role: 'member', plan: { boundTo: 'bd_1' } })).toEqual({ ok: true, deviceId: 'bd_1' })
    expect(browserDeviceDecision({ key: 'present', registration: enabled, role: 'member', plan: { boundTo: 'bd_2' } })).toEqual({ ok: false, code: 'BROWSER_DEVICE_ELSEWHERE' })
    // Made under the exception (no registration): a registered PC cannot take it over, the owner's unregistered PC can.
    expect(browserDeviceDecision({ key: 'present', registration: enabled, role: 'owner', plan: { boundTo: null } })).toEqual({ ok: false, code: 'BROWSER_DEVICE_ELSEWHERE' })
    expect(browserDeviceDecision({ key: 'absent', registration: null, role: 'owner', plan: { boundTo: null } })).toEqual({ ok: true, deviceId: null })
    expect(browserDeviceDecision({ key: 'absent', registration: null, role: 'owner', plan: { boundTo: 'bd_1' } })).toEqual({ ok: false, code: 'BROWSER_DEVICE_ELSEWHERE' })
    // The registration's own problem is said first (a stopped PC is told it is stopped, not "elsewhere").
    expect(browserDeviceDecision({ key: 'present', registration: { id: 'bd_1', state: 'revoked' }, role: 'member', plan: { boundTo: 'bd_1' } })).toEqual({ ok: false, code: 'BROWSER_DEVICE_REVOKED' })
  })

  it('every refusal has a plain Japanese sentence that says PC, never デバイス', () => {
    for (const sentence of Object.values(BROWSER_DEVICE_WORDS.refusals)) {
      expect(sentence).toContain('PC')
      expect(sentence).not.toMatch(/デバイス|ハッシュ|device/i)
    }
  })
})

/**
 * The push channel's targeted notice (services/push-channel.ts notify, used
 * by the state engine, records.md): a `records` event reaches only the
 * members it names, in that company — never the same user id in another
 * company, never a colleague the action did not name — and carries only
 * kind + version.
 */
import { describe, expect, it } from 'vitest'
import { createPushChannel } from '../../src/services/push-channel'
import type { PushEvent } from '../../shared/types/agent-stop'

describe('push channel: records notices', () => {
  it('reach only the named members of that company, with kind + version only', () => {
    const channel = createPushChannel()
    const got: Record<string, PushEvent[]> = { aBob: [], aCarol: [], bBob: [] }
    channel.open('a', 'u-bob', { send: e => got.aBob.push(e) })
    channel.open('a', 'u-carol', { send: e => got.aCarol.push(e) })
    channel.open('b', 'u-bob', { send: e => got.bBob.push(e) })
    channel.notify('a', ['u-bob', 'u-bob', 'u-nobody'], { kind: 'records', version: 'ab12cd34ef56ab12cd34ef56ab12cd34', extra: 'x' } as PushEvent)
    expect(got.aBob).toEqual([{ kind: 'records', version: 'ab12cd34ef56ab12cd34ef56ab12cd34' }])
    expect(got.aCarol).toEqual([])
    expect(got.bBob).toEqual([])
  })
})

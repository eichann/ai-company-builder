// 参加者 of a 非公開 案件・プロジェクト (records.md "Private 案件・プロジェクト"). Guards: adding or taking off
// one person never changes what anyone else may do (a read-only participant stays read-only), and owners /
// admins — who see it anyway — are never written as participants.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrivateFolderMember } from '../../../shared/private-folder-ui'
import { participantsAfter } from './participants'

const m = (userId: string, canWrite: boolean, via: 'rule' | 'role' = 'rule'): PrivateFolderMember =>
  ({ userId, name: userId, email: null, role: via === 'role' ? 'admin' : 'member', canWrite, via })
const members = [m('alice', true), m('bob', false), m('admin', true, 'role')]

test('adding someone keeps everyone else as they were; the added may change the files', () => {
  assert.deepEqual(participantsAfter(members, { add: 'carol' }), { viewers: ['alice', 'bob', 'carol'], editors: ['alice', 'carol'] })
})

test('taking someone off removes them only; owners and admins are never sent', () => {
  assert.deepEqual(participantsAfter(members, { remove: 'alice' }), { viewers: ['bob'], editors: [] })
})

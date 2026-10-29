// Contract of the document review's sidecar files and pure logic. The sidecar
// names and JSON shapes are stored in company folders and read by every
// member's app and by the AI: a change here orphans existing reviews.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectReviewStatus,
  emailToHash,
  findTextInMarkdown,
  getReplyFilePath,
  getReviewFilePath,
  getReviewRequestFilePath,
  hasUnseenReviews,
  replyFileKey,
  isReviewSidecarFile,
  markOrphanedComments,
  markReviewSeen,
  mergeRepliesIntoReviews,
  mergeReviewEdits,
  type CommentReply,
  type ResolutionEntry,
  type Review,
} from './model'

const DOC = '/Users/demo/会社/営業部/提案書.md'
const ID = '0b8f6a52-2d4c-4b8e-9a0e-3f1c2d4e5f60'

test('sidecar file names: <doc>.review.<id>.json, <doc>.reply.<hash>.json, <doc>.review-request.json', () => {
  assert.equal(getReviewFilePath(DOC, ID), `${DOC}.review.${ID}.json`)
  assert.equal(getReplyFilePath(DOC, 'qtm6lc'), `${DOC}.reply.qtm6lc.json`)
  assert.equal(getReviewRequestFilePath(DOC), `${DOC}.review-request.json`)
})

test('the reply file hash of an email never changes (existing reply files are found by it)', () => {
  assert.equal(emailToHash('demo@example.com'), 'qtm6lc')
  assert.equal(emailToHash('yamada@example.co.jp'), 'n01z8d')
  assert.equal(emailToHash('山田@例え.jp'), 'dn3fu2')
  assert.equal(emailToHash('a'), '2p')
  // A signed-out member (no email) shares one reply file with every other one.
  assert.equal(emailToHash(''), '0')
  assert.match(emailToHash('someone.with.a.long.address@example.com'), /^[0-9a-z]+$/)
})

test('replyFileKey: the email keeps its existing reply file; without one the member id keeps members apart', () => {
  assert.equal(replyFileKey('demo@example.com', 'u1'), 'qtm6lc', 'same file name as before for members with an email')
  assert.equal(replyFileKey('demo@example.com'), 'qtm6lc')
  const a = replyFileKey('', 'member-a')
  const b = replyFileKey('  ', 'member-b')
  assert.notEqual(a, b)
  assert.notEqual(a, '0')
  assert.equal(replyFileKey('', 'member-a'), a, 'stable')
  assert.match(a, /^[0-9a-z]+$/)
  assert.equal(replyFileKey('', null), '0', 'nobody signed in: the old shared name')
})

test('isReviewSidecarFile: review, reply, request and the legacy .reviews.json; not the document', () => {
  for (const name of [`提案書.md.review.${ID}.json`, '提案書.md.reply.qtm6lc.json', '提案書.md.review-request.json', '提案書.md.reviews.json']) {
    assert.equal(isReviewSidecarFile(name), true, name)
  }
  for (const name of ['提案書.md', 'review.json', '提案書.md.review.json', 'notes.json', '提案書.md.reply.json']) {
    assert.equal(isReviewSidecarFile(name), false, name)
  }
})

test('detectReviewStatus groups review files and requests by document name', () => {
  const status = detectReviewStatus([
    '提案書.md',
    `提案書.md.review.${ID}.json`,
    '提案書.md.review.second.json',
    '提案書.md.reply.qtm6lc.json',
    '台本.md.review-request.json',
    '台本.md',
  ])
  assert.deepEqual([...status.keys()].sort(), ['台本.md', '提案書.md'])
  assert.deepEqual(status.get('提案書.md'), { hasReview: true, hasRequest: false, reviewFileNames: [`提案書.md.review.${ID}.json`, '提案書.md.review.second.json'] })
  assert.deepEqual(status.get('台本.md'), { hasReview: false, hasRequest: true, reviewFileNames: [] })
})

test('detectReviewStatus: a reply file alone does not mark a document as reviewed', () => {
  assert.equal(detectReviewStatus(['提案書.md.reply.qtm6lc.json']).size, 0)
})

function withLocalStorage(run: (store: Map<string, string>) => void) {
  const store = new Map<string, string>()
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)) } }
  const g = globalThis as { localStorage?: unknown }
  const before = g.localStorage
  g.localStorage = fake
  try { run(store) } finally { g.localStorage = before }
}

test('unseen reviews: new files are unseen until marked; marking stores the sorted names per document', () => {
  withLocalStorage(store => {
    const files = ['提案書.md.review.b.json', '提案書.md.review.a.json']
    assert.equal(hasUnseenReviews(DOC, files), true)
    assert.equal(hasUnseenReviews(DOC, []), false)
    markReviewSeen(DOC, files)
    assert.deepEqual(files, ['提案書.md.review.b.json', '提案書.md.review.a.json'], "the caller's array is not reordered")
    assert.equal(store.get(`review-seen:${DOC}`), JSON.stringify(['提案書.md.review.a.json', '提案書.md.review.b.json']))
    assert.equal(hasUnseenReviews(DOC, files), false)
    assert.equal(hasUnseenReviews(DOC, ['提案書.md.review.a.json']), false, 'a removed review is not "unseen"')
    assert.equal(hasUnseenReviews(DOC, [...files, '提案書.md.review.c.json']), true)
    assert.equal(hasUnseenReviews('/other.md', files), true, 'seen state is per document')
    store.set(`review-seen:${DOC}`, '{broken')
    assert.equal(hasUnseenReviews(DOC, files), true)
  })
})

function review(id: string, comments: Array<{ id: string; resolved?: boolean; replies?: CommentReply[] }>): Review {
  return {
    id, reviewerName: '佐藤', reviewerEmail: 'sato@example.com', status: 'completed',
    createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T01:00:00.000Z',
    comments: comments.map(c => ({
      id: c.id, authorName: '佐藤', severity: 'must_fix', selectedText: '来期', startOffset: 0, endOffset: 2,
      body: '数字を', createdAt: '2026-10-01T00:30:00.000Z', resolved: c.resolved ?? false, replies: c.replies ?? [],
    })),
  }
}
const reply = (id: string, createdAt: string, reviewId?: string, commentId?: string): CommentReply =>
  ({ id, authorName: '山田', body: id, createdAt, reviewId, commentId })

test('mergeRepliesIntoReviews: replies join their comment by review id + comment id, oldest first, without duplicates', () => {
  const reviews = [review('r1', [{ id: 'c1', replies: [reply('x', '2026-10-02T00:00:00Z', 'r1', 'c1')] }, { id: 'c2' }]), review('r2', [{ id: 'c1' }])]
  const merged = mergeRepliesIntoReviews(reviews, [
    reply('y', '2026-10-01T12:00:00Z', 'r1', 'c1'),
    reply('x', '2026-10-02T00:00:00Z', 'r1', 'c1'), // the same reply also in a reply file
    reply('z', '2026-10-03T00:00:00Z', 'r2', 'c1'),
    reply('orphan', '2026-10-03T00:00:00Z'), // no ids: ignored
  ], [])
  assert.deepEqual(merged[0].comments[0].replies.map(r => r.id), ['y', 'x'])
  assert.deepEqual(merged[0].comments[1].replies, [])
  assert.deepEqual(merged[1].comments[0].replies.map(r => r.id), ['z'])
})

test('mergeRepliesIntoReviews: a resolution in a reply file overrides the review file; the last one wins', () => {
  const reviews = [review('r1', [{ id: 'c1' }, { id: 'c2', resolved: true }, { id: 'c3', resolved: true }])]
  const resolutions: ResolutionEntry[] = [
    { reviewId: 'r1', commentId: 'c1', resolved: true },
    { reviewId: 'r1', commentId: 'c2', resolved: false },
    { reviewId: 'r1', commentId: 'c1', resolved: false },
    { reviewId: 'other', commentId: 'c3', resolved: false },
  ]
  const merged = mergeRepliesIntoReviews(reviews, [], resolutions)
  assert.deepEqual(merged[0].comments.map(c => c.resolved), [false, false, true])
})

test('mergeRepliesIntoReviews: nothing to merge returns the same array', () => {
  const reviews = [review('r1', [{ id: 'c1' }])]
  assert.equal(mergeRepliesIntoReviews(reviews, [], []), reviews)
})

test('findTextInMarkdown: exact match gives the source offsets', () => {
  const md = '# 提案書\n\n来期のご提案です。'
  assert.deepEqual(findTextInMarkdown(md, '来期のご提案'), { start: 7, end: 13 })
  assert.equal(findTextInMarkdown(md, '存在しない'), null)
  assert.deepEqual(findTextInMarkdown('同じ 同じ', '同じ'), { start: 0, end: 2 }, 'first occurrence')
})

test('findTextInMarkdown: a selection across collapsed whitespace maps both ends back to the source', () => {
  const md = '前文\n\n  本文の  一節です'
  assert.deepEqual(findTextInMarkdown(md, '本文の 一節です'), { start: 6, end: md.length })
  const two = 'a\n\nb c'
  const found = findTextInMarkdown(two, 'a b')
  assert.deepEqual(found, { start: 0, end: 4 })
  assert.equal(two.slice(found!.start, found!.end), 'a\n\nb')
  // Surrounding whitespace in the selection is not part of the match.
  assert.deepEqual(findTextInMarkdown('x  y\tz', ' y z '), { start: 3, end: 6 })
})

test('markOrphanedComments: completed reviews only, in memory; unknown document text keeps the file\'s value', () => {
  const done = review('r1', [{ id: 'c1' }])
  const open: Review = { ...review('r2', [{ id: 'c2' }]), status: 'in_progress', completedAt: null }
  const [d, o] = markOrphanedComments([done, open], '# 提案書\n\n別の文章')
  assert.equal(d.comments[0].orphaned, true)
  assert.equal(o, open, 'an in-progress review is left as it is')
  assert.equal(markOrphanedComments([done], '来期の数字')[0].comments[0].orphaned, false)
  assert.equal(done.comments[0].orphaned, undefined, 'the loaded review object is not modified')
  const unknown = [done]
  assert.equal(markOrphanedComments(unknown, null), unknown)
})

test('mergeReviewEdits: the reviewer\'s file changed elsewhere', () => {
  const base: Review = { ...review('r1', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), status: 'in_progress', completedAt: null }
  const mine: Review = { ...base, comments: [...base.comments.filter(c => c.id !== 'c'), { ...base.comments[0], id: 'new-here' }] }
  assert.equal(mergeReviewEdits(base, base, mine), mine, 'unchanged on disk: this app\'s version')

  const edited = { ...base.comments[1], body: '書き直した' }
  const onDisk: Review = { ...base, comments: [base.comments[0], { ...base.comments[2] }, { ...base.comments[0], id: 'new-there' }] }
  // there: b removed, new-there added; here: c removed, new-here added
  assert.deepEqual(mergeReviewEdits(base, onDisk, mine).comments.map(c => c.id), ['a', 'new-here', 'new-there'])
  // b removed there but edited here: the edit wins
  const mineEdited: Review = { ...mine, comments: [base.comments[0], edited] }
  assert.deepEqual(mergeReviewEdits(base, onDisk, mineEdited).comments.map(c => c.id), ['a', 'b', 'new-there'])

  const completedThere: Review = { ...onDisk, status: 'completed', completedAt: '2026-10-29T09:00:00.000Z', snapshot: '全文' }
  const merged = mergeReviewEdits(base, completedThere, mine)
  assert.equal(merged.status, 'completed')
  assert.equal(merged.completedAt, '2026-10-29T09:00:00.000Z')
  assert.equal(merged.snapshot, '全文')
})

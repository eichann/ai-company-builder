// How the review's saves survive what goes wrong on a member's computer: a
// half-written file, a busy or refused write, an unreadable file, two saves at
// once, and the reviewer's file changed underneath (sync, the AI).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ReviewSaveError, deleteReviewFile, saveReview, updateMyReplies, type ReviewFiles } from './api'
import type { Review, ReviewComment } from './model'

const DOC = '/c/営業部/提案書.md'
const REVIEW_PATH = `${DOC}.review.r1.json`
const REPLY_PATH = `${DOC}.reply.k1.json`

let disk: Map<string, string>
let log: string[]
let failWrites: number
let failRenames: number
let failDeletes: number
let unreadable: Set<string>
/** The read + write ports the module gets: no window, no other method. */
let files: ReviewFiles

beforeEach(() => {
  disk = new Map()
  log = []
  failWrites = 0
  failRenames = 0
  failDeletes = 0
  unreadable = new Set()
  const api = {
    readFile: async (p: string) => (unreadable.has(p) ? null : disk.get(p) ?? null),
    exists: async (p: string) => disk.has(p),
    writeFile: async (p: string, content: string) => {
      log.push(`write ${p}`)
      if (failWrites > 0) { failWrites--; return false }
      disk.set(p, content)
      return true
    },
    renameItem: async (from: string, to: string) => {
      log.push(`rename ${from} -> ${to}`)
      if (failRenames > 0) { failRenames--; return { success: false, error: 'EBUSY' } }
      disk.set(to, disk.get(from)!)
      disk.delete(from)
      return { success: true, newPath: to }
    },
    deleteItem: async (p: string) => {
      log.push(`delete ${p}`)
      if (failDeletes > 0) { failDeletes--; return { success: false, error: 'EBUSY' } }
      if (!disk.delete(p)) return { success: false, error: 'ENOENT: no such file' }
      return { success: true }
    },
    readDirectory: async () => [] as Array<{ name: string; isDirectory: boolean; path: string }>,
  }
  files = api
})

const comment = (id: string, body = id): ReviewComment => ({
  id, authorName: '山田', severity: 'note', selectedText: '来期', startOffset: 0, endOffset: 2,
  body, createdAt: '2026-10-29T00:00:00.000Z', resolved: false, replies: [],
})
const review = (comments: ReviewComment[], extra: Partial<Review> = {}): Review => ({
  id: 'r1', reviewerName: '山田', reviewerEmail: 'demo@example.com', status: 'in_progress',
  createdAt: '2026-10-29T00:00:00.000Z', completedAt: null, comments, ...extra,
})
const fileOf = (r: Review) => JSON.stringify({ version: 1, review: r }, null, 2)
const temps = () => [...disk.keys()].filter(p => p.includes('.acb-tmp-'))

test('a save writes a temporary file next to the target and renames it over, leaving no temporary file', async () => {
  const saved = await saveReview(DOC, review([comment('c1')]), null, files)
  assert.equal(disk.get(REVIEW_PATH), fileOf(saved))
  assert.ok(!log.includes(`write ${REVIEW_PATH}`), 'the target itself is never written in place')
  assert.match(log.find(l => l.startsWith('rename'))!, /^rename \/c\/営業部\/\.提案書\.md\.review\.r1\.json\.acb-tmp-[0-9a-z]+ -> \/c\/営業部\/提案書\.md\.review\.r1\.json$/)
  assert.deepEqual(temps(), [])
})

test('a failed write or rename is retried; the temporary file is cleaned up each time', async () => {
  failWrites = 1
  failRenames = 1
  await saveReview(DOC, review([comment('c1')]), null, files)
  assert.equal(JSON.parse(disk.get(REVIEW_PATH)!).review.comments[0].id, 'c1')
  assert.equal(log.filter(l => l.startsWith('write')).length, 3)
  assert.deepEqual(temps(), [])
})

test('a write that keeps failing ends in ReviewSaveError and leaves the file as it was', async () => {
  disk.set(REVIEW_PATH, fileOf(review([])))
  failWrites = 99
  await assert.rejects(saveReview(DOC, review([comment('c1')]), review([]), files), ReviewSaveError)
  assert.equal(disk.get(REVIEW_PATH), fileOf(review([])))
  assert.equal(log.filter(l => l.startsWith('write')).length, 3, 'three tries')
  assert.deepEqual(temps(), [])
})

test('the reviewer\'s file changed underneath (sync, the AI): edits on both sides are kept', async () => {
  const base = review([comment('c1')])
  disk.set(REVIEW_PATH, fileOf(review([comment('c1'), comment('elsewhere')])))
  const saved = await saveReview(DOC, review([comment('c1'), comment('mine')]), base, files)
  assert.deepEqual(saved.comments.map(c => c.id), ['c1', 'mine', 'elsewhere'])
  assert.equal(disk.get(REVIEW_PATH), fileOf(saved))
})

test('a review file that is there but cannot be read or parsed is never overwritten', async () => {
  disk.set(REVIEW_PATH, '{ broken')
  await assert.rejects(saveReview(DOC, review([comment('c1')]), null, files), ReviewSaveError)
  assert.equal(disk.get(REVIEW_PATH), '{ broken')
  disk.set(REPLY_PATH, '{"version":1}')
  unreadable.add(REPLY_PATH)
  await assert.rejects(updateMyReplies(DOC, 'k1', { authorName: '山田', authorEmail: 'demo@example.com' }, d => { d.replies.push() }, files), ReviewSaveError)
  assert.equal(disk.get(REPLY_PATH), '{"version":1}')
})

test('two quick changes to the reply file both land (one at a time, each on what is on disk)', async () => {
  const author = { authorName: '山田', authorEmail: 'demo@example.com' }
  const reply = (id: string) => ({ id, authorName: '山田', body: id, createdAt: '2026-10-29T00:00:00.000Z', reviewId: 'r1', commentId: 'c1' })
  await Promise.all([
    updateMyReplies(DOC, 'k1', author, d => { d.replies.push(reply('a')) }, files),
    updateMyReplies(DOC, 'k1', author, d => { d.resolutions = [...(d.resolutions ?? []), { reviewId: 'r1', commentId: 'c1', resolved: true }] }, files),
    updateMyReplies(DOC, 'k1', author, d => { d.replies.push(reply('b')) }, files),
  ])
  const data = JSON.parse(disk.get(REPLY_PATH)!)
  assert.deepEqual(Object.keys(data), ['version', 'authorName', 'authorEmail', 'replies', 'resolutions'])
  assert.deepEqual(data.replies.map((r: { id: string }) => r.id), ['a', 'b'])
  assert.equal(data.resolutions.length, 1)
})

test('a reply change after a failed one still runs', async () => {
  const author = { authorName: '山田', authorEmail: 'demo@example.com' }
  failWrites = 99
  await assert.rejects(updateMyReplies(DOC, 'k1', author, d => { d.replies.push() }, files), ReviewSaveError)
  failWrites = 0
  await updateMyReplies(DOC, 'k1', author, () => {}, files)
  assert.ok(disk.has(REPLY_PATH))
})

test('cancelling: a missing file counts as deleted; one that stays is an error', async () => {
  await deleteReviewFile(DOC, 'r1', files)
  disk.set(REVIEW_PATH, fileOf(review([])))
  failDeletes = 99
  await assert.rejects(deleteReviewFile(DOC, 'r1', files), ReviewSaveError)
  assert.ok(disk.has(REVIEW_PATH))
  failDeletes = 1
  await deleteReviewFile(DOC, 'r1', files)
  assert.ok(!disk.has(REVIEW_PATH))
})

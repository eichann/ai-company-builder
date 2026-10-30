// Two quick 「ダウンロード」 clicks (two not-downloaded folders) must both stay
// downloaded: each change is built from the list as it is when its turn comes
// (exclusionChanges.ts), never from the list the view saw when clicked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createExclusionQueue } from './exclusionChanges'

/** Main's list, applied slowly (a download takes a while), with the calls it saw. */
function fakeMain(initial: string[]) {
  let list = [...initial]
  const applied: string[][] = []
  let failNext = false
  return {
    deps: {
      read: async () => [...list],
      apply: async (_root: string, next: string[]) => {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (failNext) { failNext = false; throw new Error('offline') }
        applied.push(next)
        list = [...next]
        return { success: true, excluded: [...list] }
      },
    },
    list: () => list,
    applied,
    failOnce: () => { failNext = true },
  }
}

test('two downloads started together both stay downloaded', async () => {
  const main = fakeMain(['営業部', '開発部', '総務'])
  const queue = createExclusionQueue(main.deps)
  await Promise.all([
    queue.change('/co', current => current.filter(f => f !== '営業部')),
    queue.change('/co', current => current.filter(f => f !== '開発部')),
  ])
  assert.deepEqual(main.list(), ['総務'])
  assert.deepEqual(main.applied, [['開発部', '総務'], ['総務']])
})

test('a change that fails does not stop the next one, which starts from what is really there', async () => {
  const main = fakeMain(['営業部', '開発部'])
  const queue = createExclusionQueue(main.deps)
  main.failOnce()
  const [first, second] = await Promise.allSettled([
    queue.change('/co', current => current.filter(f => f !== '営業部')),
    queue.change('/co', current => current.filter(f => f !== '開発部')),
  ])
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'fulfilled')
  assert.deepEqual(main.list(), ['営業部'])
})

test('different company folders do not wait for each other', async () => {
  const order: string[] = []
  const queue = createExclusionQueue({
    read: async () => [],
    apply: async (root: string) => {
      await new Promise(resolve => setTimeout(resolve, root === '/slow' ? 40 : 1))
      order.push(root)
      return root
    },
  })
  await Promise.all([queue.change('/slow', c => c), queue.change('/fast', c => c)])
  assert.deepEqual(order, ['/fast', '/slow'])
})

// The HTML viewer's rules (htmlViewer.ts): an app overlay of usable size anywhere over the document
// is noticed (the native view would hide it); which file changes reload the document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedBandShown, changeShowsIn, COVER_STEP, rebuildRequestOf, samplePoints } from './htmlViewer'

test('the band shows while the page wanted something from the internet, until each host was dismissed; a new host brings it back', () => {
  const parts = { count: 3, hosts: ['cdn.example.com', 'fonts.example.net'], hostCount: 2 }
  const dismissed = (hosts: string[], hostCount = hosts.length) => ({ hosts: new Set(hosts), hostCount })
  assert.equal(blockedBandShown(null, null), false)
  assert.equal(blockedBandShown({ count: 0, hosts: [], hostCount: 0 }, null), false, 'the page loaded again and wanted nothing yet')
  assert.equal(blockedBandShown(parts, null), true)
  assert.equal(blockedBandShown(parts, dismissed(['cdn.example.com'])), true, 'one host still not dismissed')
  assert.equal(blockedBandShown(parts, dismissed(parts.hosts)), false, 'an auto refresh asking the same again stays quiet')
  assert.equal(blockedBandShown({ count: 4, hosts: [...parts.hosts, 'new.example'], hostCount: 3 }, dismissed(parts.hosts)), true)
  // Past the named hosts' cap the list stays the same: one more host in all still brings it back.
  const capped = Array.from({ length: 20 }, (_, i) => `h${i}.example`)
  assert.equal(blockedBandShown({ count: 21, hosts: capped, hostCount: 21 }, dismissed(capped, 20)), true)
  assert.equal(blockedBandShown({ count: 22, hosts: capped, hostCount: 21 }, dismissed(capped, 21)), false, 'more addresses of known hosts stay quiet')
})

test('［AI に直してもらう］ names the file by its company path (never the absolute one) and asks for one file without internet parts', () => {
  const text = rebuildRequestOf('/Users/m/Company/営業/報告.html', '/Users/m/Company/')
  assert.match(text, /^「営業\/報告\.html」を、インターネットの部品/)
  assert.doesNotMatch(text, /Users/)
  assert.match(text, /1 つのファイルにまとめて/)
  assert.match(rebuildRequestOf('/elsewhere/x.html', '/Users/m/Company'), /^「x\.html」/)
})

test('every overlay at least COVER_STEP wide and tall, anywhere over the area, is hit by a sample point; a 4K area keeps a grid of at most 3 steps', () => {
  for (const [area, most] of [[{ x: 0, y: 0, width: 300, height: 200 }, COVER_STEP], [{ x: 260, y: 120, width: 1400, height: 900 }, COVER_STEP], [{ x: 0, y: 0, width: 3800, height: 2100 }, 3 * COVER_STEP]] as const) {
    const points = samplePoints(area)
    assert.ok(points.length <= 700, `${points.length} points`)
    // The grid gets coarser on a huge area: the guarantee is for its actual spacing.
    const xs = [...new Set(points.map(p => p[0]))].sort((a, b) => a - b)
    const ys = [...new Set(points.map(p => p[1]))].sort((a, b) => a - b)
    const stepX = Math.max(COVER_STEP, ...xs.slice(1).map((x, i) => x - xs[i]))
    const stepY = Math.max(COVER_STEP, ...ys.slice(1).map((y, i) => y - ys[i]))
    assert.ok(stepX <= most && stepY <= most, `grid ${stepX}×${stepY} on ${area.width}×${area.height}`)
    for (let left = area.x; left + stepX <= area.x + area.width; left += 7) {
      for (let top = area.y; top + stepY <= area.y + area.height; top += 7) {
        const hit = points.some(([x, y]) => x >= left && x <= left + stepX && y >= top && y <= top + stepY)
        assert.ok(hit, `an overlay at ${left},${top} slipped between the points`)
      }
    }
  }
})

test('a change reloads the document only when it shows in it: the file, or a served file of its folder or below', () => {
  const doc = '/c/営業部/報告/売上.html'
  for (const p of [doc, '/c/営業部/報告/style.css', '/c/営業部/報告/images/graph.png', '/c/営業部/報告/page2.htm', 'C:\\c\\営業部\\報告\\app.js'.replace(/^C:/, '')]) {
    assert.equal(changeShowsIn(doc, p), true, p)
  }
  for (const p of ['/c/営業部/報告/売上.csv', '/c/営業部/報告/notes.md', '/c/営業部/style.css', '/c/営業部/報告', '/c/営業部/報告2/style.css']) {
    assert.equal(changeShowsIn(doc, p), false, p)
  }
})

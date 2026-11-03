/**
 * Folders moved or renamed as a whole (lib/record-files.ts `folderMoves`,
 * records.md "Links to files"): the renames git reports file by file become
 * one rename per folder, so links to a folder follow it.
 *
 * Guards:
 * - a whole folder renamed or moved gives its own rename, and each folder
 *   inside it too (a link to a subfolder follows);
 * - a rename inside the folder (its files renamed in place) is no move of it;
 * - a folder whose renamed files went to two different places is not moved;
 * - the folders above the moved one are not moved, nor is the repository root.
 * Whether the folder is gone at the tip (a partial move keeps the link) is
 * checked by readRecordFiles: tests/integration/record-links.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { folderMoves } from '../../src/lib/record-files'

const moves = (renames: Array<[string, string]>) =>
  folderMoves(renames.map(([from, to]) => ({ from, to }))).map(m => `${m.from} → ${m.to}`).sort()

describe('folderMoves', () => {
  it('a folder renamed as a whole, with the folders inside it', () => {
    expect(moves([
      ['営業部/見積/a.md', '営業部/見積2024/a.md'],
      ['営業部/見積/図/b.png', '営業部/見積2024/図/b.png'],
    ])).toEqual(['営業部/見積 → 営業部/見積2024', '営業部/見積/図 → 営業部/見積2024/図'])
  })

  it('a folder moved to another department', () => {
    expect(moves([['営業部/見積/a.md', '総務/見積/a.md']])).toEqual(['営業部 → 総務', '営業部/見積 → 総務/見積'])
  })

  it('files renamed inside the folder are no move of it', () => {
    expect(moves([['営業部/見積/a.md', '営業部/見積/b.md']])).toEqual([])
  })

  it('renames that leave the folder’s shape say nothing; two different places mean no move', () => {
    expect(moves([
      ['営業部/見積/a.md', '営業部/見積2024/a.md'],
      ['営業部/見積/c.md', '営業部/ほか/z.md'],
    ])).toEqual(['営業部/見積 → 営業部/見積2024'])
    expect(moves([
      ['営業部/見積/a.md', '営業部/見積2024/a.md'],
      ['営業部/見積/b.md', '営業部/古い/b.md'],
    ])).toEqual([])
  })

  it('never the folders above the moved one, nor the root', () => {
    expect(moves([['a.md', 'b/a.md']])).toEqual([])
    expect(moves([['x/a.md', 'a.md']])).toEqual([])
  })
})

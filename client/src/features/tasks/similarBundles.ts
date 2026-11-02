// 「似た〇〇があります」 before 「新しい〇〇にする」 makes one (pure): an existing 案件・プロジェクト the
// member reads whose name shares a word with the new name (ignoring width, case and spaces). The
// server's own similarity check (#466, the same 相手 too) answers only inside an approval.
import type { BundleChoice } from '../../../shared/tasks'

const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\u3000・、。,.\-－ー（）()「」『』［］[\]]/g, '')

/** Runs of 2+ characters of `name` (its "words" without a dictionary): どれか1つでも含めば似ている. */
function pieces(name: string): string[] {
  const words = name.normalize('NFKC').split(/[\s\u3000・、。,（）()「」『』［］[\]\-－]+/).map(fold).filter(w => w.length >= 2)
  return [...new Set(words)]
}

export function similarBundles(name: string, choices: readonly BundleChoice[], max = 3): BundleChoice[] {
  const ws = pieces(name)
  if (ws.length === 0) return []
  return choices.filter(c => { const t = fold(c.title); return ws.some(w => t.includes(w)) }).slice(0, max)
}

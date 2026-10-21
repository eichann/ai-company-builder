import type { SimpleGit } from 'simple-git'


// Split the unmerged index entries into the conflicts whose server version
// still exists and the ones the server deleted.
//
// `git checkout --ours <path>` extracts stage 2 of the index. A modify/delete
// conflict — the server deleted a file the member had edited (status `DU`) —
// has stage 1 and stage 3 but no stage 2, so the command fails, and it fails
// *atomically*: every other path passed in the same call stays unresolved too.
// Classifying first lets each group get the operation it can actually take.
//
// -z because department folders use Japanese names: without it git quotes
// non-ASCII paths as "\345\226\266..." unless core.quotePath happens to be off.
export async function classifyConflicts(git: SimpleGit): Promise<{ take: string[]; drop: string[] }> {
  const raw = await git.raw(['ls-files', '-u', '-z'])
  // path -> set of stage numbers (1 = base, 2 = ours/server, 3 = theirs/local)
  const stages = new Map<string, Set<number>>()
  for (const entry of (raw || '').split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const stage = Number(entry.slice(0, tab).split(' ')[2])
    const file = entry.slice(tab + 1)
    if (!stages.has(file)) stages.set(file, new Set())
    stages.get(file)!.add(stage)
  }
  const take: string[] = []
  const drop: string[] = []
  for (const [file, s] of stages) (s.has(2) ? take : drop).push(file)
  return { take, drop }
}

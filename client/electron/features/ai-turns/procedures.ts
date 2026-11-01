// A business plugin's step's procedure on this PC (plan C5, .claude/rules/plugin-steps.md): the
// text the automatic run's first message carries, read from what the work is pinned to —
//   - the plugin's: `<userData>/plugins/<id>@<version>/<steps/…md>`, the package C2 keeps and
//     verified against the policy's fingerprint (`pluginPackages.folderOf`); only a package
//     this company lists now, only a file named `steps/<name>.md` inside its folder;
//   - a company Skill's: SKILL.md of the pinned tree in the member's company folder (the tree
//     id the server pinned: the same on every clone with that content). Read from git objects,
//     so a later change of the Skill on disk does not change the procedure of pinned work.
// Not here (not fetched / synced yet, a lazy object) → null: the run is given back for later.

import { readFile } from 'fs/promises'
import path from 'path'
import { isValidSkillName } from '../../../../shared/core/names'
import { STEP_FILE_RE } from '../../../../shared/core/plugin-flow-declaration'
import type { PluginProcedurePin } from '../../../shared/ai-turn-steps/plugin'

/** The longest procedure handed to the AI (a procedure is a page of instructions, not a document store). */
const PROCEDURE_MAX_BYTES = 200_000
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export interface ProcedureReaderDeps {
  folderOf: (companyId: string, pluginId: string, version: string) => string | null
  /** git in the company folder (no lazy fetch: a missing object is "not here", never a download). */
  git: (root: string, args: string[]) => Promise<string>
}

export function createProcedureReader(deps: ProcedureReaderDeps) {
  return async function readProcedure(companyId: string, pin: PluginProcedurePin, file: string, companyRoot: string | null): Promise<string | null> {
    if (pin.source === 'plugin') {
      if (!STEP_FILE_RE.test(file)) return null
      const folder = deps.folderOf(companyId, pin.pluginId, pin.version)
      if (!folder) return null
      const target = path.resolve(folder, file)
      if (!target.startsWith(path.resolve(folder) + path.sep)) return null
      const bytes = await readFile(target).catch(() => null)
      return bytes && bytes.length <= PROCEDURE_MAX_BYTES ? bytes.toString('utf8') : null
    }
    if (!companyRoot || !isValidSkillName(pin.skill) || !TREE_RE.test(pin.fingerprint)) return null
    const text = await deps.git(companyRoot, ['cat-file', 'blob', `${pin.fingerprint}:SKILL.md`]).catch(() => null)
    return text !== null && Buffer.byteLength(text) <= PROCEDURE_MAX_BYTES ? text : null
  }
}

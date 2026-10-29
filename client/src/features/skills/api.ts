// The skills' access to the main process, as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts), one per capability. Every function takes its
// port as the last parameter, defaulting to window.electronAPI.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** Reading on this computer: the skill list of a folder, a skill's files. */
export type SkillReads = ElectronPort<'listSkills' | 'readFile'>
/** Running a skill's tool (a local dev server under `.claude/skills/<skill>/tools/`). */
export type SkillToolRuns = ElectronPort<'startTool' | 'stopTool'>
/** Leaving the app: opening a URL in the member's browser. */
export type SkillOutbound = ElectronPort<'openExternal'>

type ListSkillsArgs = Parameters<ElectronAPI['listSkills']>

export function listSkills(
  rootPath: ListSkillsArgs[0],
  departmentFolder: ListSkillsArgs[1],
  departmentId: ListSkillsArgs[2],
  departmentName?: ListSkillsArgs[3],
  options?: ListSkillsArgs[4],
  reads: SkillReads = window.electronAPI,
) {
  return reads.listSkills(rootPath, departmentFolder, departmentId, departmentName, options)
}

/** A skill file's text (SKILL.md for the preview), or null. */
export function readSkillFile(filePath: string, reads: SkillReads = window.electronAPI) {
  return reads.readFile(filePath)
}

export function startSkillTool(toolPath: string, startCommand?: string, runs: SkillToolRuns = window.electronAPI) {
  return runs.startTool(toolPath, startCommand)
}

export function stopSkillTool(toolPath: string, runs: SkillToolRuns = window.electronAPI) {
  return runs.stopTool(toolPath)
}

/** Opens the tool's local page in the member's browser. */
export function openInBrowser(url: string, outbound: SkillOutbound = window.electronAPI) {
  return outbound.openExternal(url)
}

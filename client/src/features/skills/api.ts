// The skills' access to the main process, as small ports over the IPC contract
// (src/shared/ipc/electron-api.ts), one per capability. Every function takes its
// port as the last parameter, defaulting to window.electronAPI.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** Reading on this computer: the skill list of a folder, a skill's files, whether a folder name is taken. */
export type SkillReads = ElectronPort<'listSkills' | 'readFile' | 'exists'>
/** Running a skill's tool (a local dev server under `.claude/skills/<skill>/tools/`). */
export type SkillToolRuns = ElectronPort<'startTool' | 'stopTool'>
/** Leaving the app: opening a URL in the member's browser. */
export type SkillOutbound = ElectronPort<'openExternal'>
/** Making or changing a skill's files on this computer: new skill, copy, 育成中 mark. */
export type SkillWrites = ElectronPort<'createDirectory' | 'createFile' | 'writeFile' | 'copyItem' | 'toggleSkillNurturing'>
/**
 * Marking a skill private or shared (the company .gitignore): written on this
 * computer, but it decides whether the next sync sends the skill to everyone.
 */
export type SkillSharingWrites = ElectronPort<'makeSkillPrivate' | 'publishSkill'>

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

/** Starts a skill's tool; with the company, it gets that company's API key broker variables (key-broker.md). */
export function startSkillTool(toolPath: string, startCommand?: string, companyId?: string, runs: SkillToolRuns = window.electronAPI) {
  return runs.startTool(toolPath, startCommand, companyId)
}

export function stopSkillTool(toolPath: string, runs: SkillToolRuns = window.electronAPI) {
  return runs.stopTool(toolPath)
}

/** Opens the tool's local page in the member's browser. */
export function openInBrowser(url: string, outbound: SkillOutbound = window.electronAPI) {
  return outbound.openExternal(url)
}

/** Something (a skill folder, a file) is already at `path` on this computer. */
export function pathExists(path: string, reads: SkillReads = window.electronAPI) {
  return reads.exists(path)
}

export function createSkillDirectory(dirPath: string, writes: SkillWrites = window.electronAPI) {
  return writes.createDirectory(dirPath)
}

/** A new file: never replaces one that exists (`code: 'name_taken'`). */
export function createSkillFile(filePath: string, content: string, writes: SkillWrites = window.electronAPI) {
  return writes.createFile(filePath, content)
}

export function writeSkillFile(filePath: string, content: string, writes: SkillWrites = window.electronAPI) {
  return writes.writeFile(filePath, content)
}

/** Copies a whole skill folder; never onto an existing one (`code: 'name_taken'`). */
export function copySkill(sourcePath: string, destPath: string, writes: SkillWrites = window.electronAPI) {
  return writes.copyItem(sourcePath, destPath)
}

export function setSkillNurturing(skillMdPath: string, makeNurturing: boolean, writes: SkillWrites = window.electronAPI) {
  return writes.toggleSkillNurturing(skillMdPath, makeNurturing)
}

/** Keeps the skill out of the next sync (`.gitignore`); refused (`already_shared`) for a skill the company has. */
export function makeSkillPrivate(rootPath: string, skillRelativePath: string, sharing: SkillSharingWrites = window.electronAPI) {
  return sharing.makeSkillPrivate(rootPath, skillRelativePath)
}

/** One way: the next sync shares the skill with everyone. */
export function publishSkill(rootPath: string, skillRelativePath: string, sharing: SkillSharingWrites = window.electronAPI) {
  return sharing.publishSkill(rootPath, skillRelativePath)
}

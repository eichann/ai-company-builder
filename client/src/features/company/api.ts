// Choosing a company and setting its folder up on this computer (the company
// selector, restoring the last company in App.tsx), as small ports over the
// IPC contract (src/shared/ipc/electron-api.ts). Every function takes its port
// as the last parameter, defaulting to window.electronAPI.
import type { ElectronAPI, ElectronPort } from '../../shared/ipc/electron-api'

/** The companies the member belongs to, from the company server (sends only who the member is). */
export type CompanyListReads = ElectronPort<'getCompanies'>
/** Creating a company: the typed name is sent and the server creates its repository. */
export type CompanyCreateOutbound = ElectronPort<'createCompany'>
/**
 * The system's folder dialog. The folder the member picks becomes reachable by
 * the app's file operations, so this widens what the app may touch here.
 */
export type CompanyFolderChoiceWrites = ElectronPort<'selectDirectory'>
/**
 * Reading a company folder on this computer: what it is (asks the company
 * server only whether its repository has anything yet), what is in it, and
 * how far a download has got.
 */
export type CompanyFolderReads = ElectronPort<'gitInspectCompanyFolder' | 'readDirectory' | 'exists' | 'onSetupProgress'>
/**
 * Setting the folder up: creating it and downloading the company (the picked
 * departments) into it. Sends nothing but who the member is and which
 * departments to download; the member's files go out at the next sync.
 */
export type CompanySetupWrites = ElectronPort<'createDirectory' | 'gitSetupCompanyRemote'>

export function getCompanies(reads: CompanyListReads = window.electronAPI) {
  return reads.getCompanies()
}

export function createCompany(name: string, outbound: CompanyCreateOutbound = window.electronAPI) {
  return outbound.createCompany(name)
}

/** The picked folder, or null when the member cancelled. */
export function chooseFolder(writes: CompanyFolderChoiceWrites = window.electronAPI) {
  return writes.selectDirectory()
}

export function inspectCompanyFolder(folder: string, companyId: string, reads: CompanyFolderReads = window.electronAPI) {
  return reads.gitInspectCompanyFolder(folder, companyId)
}

export function readCompanyFolder(folder: string, reads: CompanyFolderReads = window.electronAPI) {
  return reads.readDirectory(folder)
}

/** Answers only inside folders the app may touch (registerCompanyFolder first). */
export function companyPathExists(target: string, reads: CompanyFolderReads = window.electronAPI) {
  return reads.exists(target)
}

/** Bytes received during the first download; returns the unsubscribe. */
export function onSetupProgress(
  callback: Parameters<ElectronAPI['onSetupProgress']>[0],
  reads: CompanyFolderReads = window.electronAPI,
) {
  return reads.onSetupProgress(callback)
}

export function createCompanyFolder(folder: string, writes: CompanySetupWrites = window.electronAPI) {
  return writes.createDirectory(folder)
}

/** `selectedFolders` undefined downloads every department. */
export function setUpCompanyFolder(folder: string, companyId: string, selectedFolders: string[] | undefined, writes: CompanySetupWrites = window.electronAPI) {
  return writes.gitSetupCompanyRemote(folder, companyId, selectedFolders)
}

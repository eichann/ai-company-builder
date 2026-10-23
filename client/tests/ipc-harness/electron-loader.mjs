// Module resolve hook (node:module register) for the IPC characterization
// tests: `electron` resolves to ./fake-electron.ts instead of the npm package
// (which, outside Electron, only exports the path of the Electron binary).
// tsx, registered before this hook, still loads the TypeScript.
const FAKE = new URL('./fake-electron.ts', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: FAKE, shortCircuit: true }
  return nextResolve(specifier, context)
}

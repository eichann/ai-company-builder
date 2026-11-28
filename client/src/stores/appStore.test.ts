// The company on screen is the boundary of everything started for it (tasks-ui.md "Working through a list"): another
// company or a sign-out ends its era, so an answer still on its way lands nowhere; the same company keeps it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CompanyView } from '../types'

const memory = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v) }, removeItem: (k: string) => { memory.delete(k) } },
})
const { currentCompanyEra, inEra } = await import('../shared/lib/companyEra')
const { useAppStore } = await import('./appStore')

const company = (id: string) => ({ id, name: id }) as CompanyView

test('another company, a sign-out or a company added and shown ends the era; the same company again keeps it', () => {
  const store = useAppStore.getState()
  store.setCurrentCompany(company('A'))
  const inA = currentCompanyEra()
  store.setCurrentCompany(company('A'))
  assert.equal(inEra(inA), true, 'the same company')

  store.setCurrentCompany(company('B'))
  assert.equal(inEra(inA), false, 'another company')
  const inB = currentCompanyEra()
  store.setCurrentCompany(null)
  assert.equal(inEra(inB), false, 'a sign-out')
  const signedOut = currentCompanyEra()
  store.addCompany(company('C'))
  assert.equal(inEra(signedOut), false, 'a company added and shown')
  const inC = currentCompanyEra()
  store.chooseCompany('D')
  assert.equal(inEra(inC), false, 'choosing another company')
})

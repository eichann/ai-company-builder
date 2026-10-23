/**
 * Per-company serialization of working-clone operations
 * (`data/workdirs/<companyId>`): department create / rename / delete, private
 * folder creation, company seeding. A run registers itself before awaiting
 * the previous one, so two queued requests can never wake up together and run
 * git in the same working directory concurrently.
 */
const companyLocks = new Map<string, Promise<void>>()

export async function withCompanyLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const previous = companyLocks.get(companyId) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(() => new Promise<void>(resolve => { release = resolve }))
  companyLocks.set(companyId, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (companyLocks.get(companyId) === current) companyLocks.delete(companyId)
  }
}

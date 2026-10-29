/**
 * Per-company serialization of the server's own changes to a company's
 * repositories: department create / rename / delete and company seeding
 * (commits built in the bare repository, lib/bare-commit.ts), private folder
 * creation. A run registers itself before awaiting the previous one, so two
 * queued requests can never wake up together and both build on the same
 * branch tip. Members' pushes are not serialized here: a commit that lost
 * that race is rebuilt on the new tip (lib/bare-commit.ts).
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

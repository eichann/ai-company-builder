/**
 * Erase content of the content store (中身の箱) — the operator's procedure,
 * outside the product (owner decision 2026-11-01; runbook:
 * `.claude/rules/records.md` "The content store").
 *
 *   node --import tsx src/cli/erase-content.ts list    <companyId> <recordId>
 *   node --import tsx src/cli/erase-content.ts record  <companyId> <recordId> <reason>
 *   node --import tsx src/cli/erase-content.ts content <companyId> <reason> <contentId>...
 *   node --import tsx src/cli/erase-content.ts expired
 *
 * Uses DATA_DIR as the server does. `reason` is a short word (`request`,
 * `ticket-123`): never the person's name — the request itself belongs in the
 * erasure log kept outside the product. Every erased id is printed as
 * `erased <companyId> <contentId>`: keep these lines in that log, because a
 * restore from a backup brings the text back and the same ids must be erased
 * again (`content <companyId> restore-reapply <ids…>`). Nothing here prints a
 * text.
 */
async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  const { db, initDatabase } = await import('../db')
  initDatabase(db)
  const { sqliteCompanyData } = await import('../adapters/sqlite/company-data')
  const { sqliteCompanyRepository } = await import('../adapters/sqlite/companies')
  const { sqliteRecordContentEraser } = await import('../adapters/sqlite/record-contents')
  const { sqliteTransactions } = await import('../adapters/sqlite/transactions')
  const { systemClock } = await import('../adapters/system')
  const { createRecordContentErasure } = await import('../services/record-contents')
  const companies = sqliteCompanyRepository(db)
  const erasure = createRecordContentErasure({
    eraser: sqliteRecordContentEraser(db), companyData: sqliteCompanyData(db), transactions: sqliteTransactions(db), clock: systemClock,
    companyIds: () => companies.allIds(),
  })
  const known = (companyId: string) => companies.allIds().includes(companyId)

  if (command === 'list' && args.length === 2 && known(args[0])) {
    for (const c of erasure.list(args[0], args[1])) {
      console.log(`${c.id} ${c.retention} created=${c.createdAt} expires=${c.expiresAt ?? '-'} erased=${c.erasedAt ?? '-'}${c.erasedReason ? ` (${c.erasedReason})` : ''}`)
    }
    return 0
  }
  if (command === 'record' && args.length === 3 && known(args[0])) {
    const r = erasure.eraseRecord(args[0], args[1], args[2])
    for (const id of r.erased) console.log(`erased ${args[0]} ${id}`)
    console.log(`Erased ${r.erased.length} content(s) of record ${args[1]}; cleared the text of ${r.fixedPayloadsCleared} fixed content version(s).`)
    return 0
  }
  if (command === 'content' && args.length >= 3 && known(args[0])) {
    const ids = args.slice(2)
    if (!ids.every(id => /^[0-9a-f]{32}$/.test(id))) { console.error('A content id is 32 hex characters.'); return 2 }
    const r = erasure.eraseContents(args[0], ids, args[1])
    for (const id of r.erased) console.log(`erased ${args[0]} ${id}`)
    console.log(`Erased ${r.erased.length} of ${ids.length} (the rest were already erased or are not this company's).`)
    return 0
  }
  if (command === 'expired' && args.length === 0) {
    const r = erasure.eraseExpired()
    for (const e of r.erased) console.log(`erased ${e.companyId} ${e.id}`)
    console.log(`Erased ${r.erased.length} expired content(s).`)
    return 0
  }
  console.error([
    'Usage:',
    '  erase-content.ts list    <companyId> <recordId>',
    '  erase-content.ts record  <companyId> <recordId> <reason>',
    '  erase-content.ts content <companyId> <reason> <contentId>...',
    '  erase-content.ts expired',
    '(an unknown company id is refused with this text)',
  ].join('\n'))
  return 2
}

main(process.argv.slice(2)).then(code => { process.exitCode = code }, (err: unknown) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})

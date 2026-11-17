/**
 * What createServices hands every service as `shared` (src/composition.ts): the company handles,
 * accounts, transactions, the clock and ids. The feature parts of the composition root under
 * composition/ take it as is and spread it where composition.ts spread it before.
 */
import type { AccountDirectory } from '../ports/accounts'
import type { Clock, IdGenerator } from '../ports/clock'
import type { CompanyDataSource } from '../ports/company-data'
import type { Transactions } from '../ports/transactions'

export interface CompositionShared {
  companyData: CompanyDataSource
  accounts: AccountDirectory
  transactions: Transactions
  clock: Clock
  ids: IdGenerator
}

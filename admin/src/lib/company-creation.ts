// Who is offered 「会社を作成」: creating a company is the server operators' work
// (COMPANY_CREATION_POLICY=operator; the first company of a fresh server is the
// exception). The server answers it per account in GET /api/me
// (`canCreateCompany`, the same check POST /api/companies makes); the console
// only hides what the server would refuse.
import type { User } from './api'

/** Hidden only when the server says this account may not; an older server's answer lacks the field. */
export function offersCompanyCreation(user: User | null): boolean {
  return user?.canCreateCompany !== false
}

/** For someone who may not create a company: how to get into one. */
export const NOT_A_MEMBER_YET =
  '会社に参加するには、届いた招待リンクを開いてください。招待が届いていない場合は、会社の管理者かサービスの運用担当者にお問い合わせください。'

/**
 * The fake HubSpot's starting data: a sales pipeline like div's corporate
 * sales, with made-up companies, people and deals (no real company or person
 * names — design 節目3 §3-1). Ids are numeric strings like HubSpot's.
 */

export interface SeedOwner {
  id: string
  email: string
  firstName: string
  lastName: string
  userId: number
}

export interface SeedCompany {
  id: string
  properties: Record<string, string>
}

export interface SeedDeal {
  id: string
  properties: Record<string, string>
  companyIds: string[]
}

export interface Seed {
  owners: SeedOwner[]
  companies: SeedCompany[]
  deals: SeedDeal[]
}

export const SEED_OWNER_IDS = ['75123001', '75123002', '75123003'] as const

export function defaultSeed(): Seed {
  const owners: SeedOwner[] = [
    { id: '75123001', email: 'sales-one@example.com', firstName: '太郎', lastName: '見本', userId: 9100001 },
    { id: '75123002', email: 'sales-two@example.com', firstName: '花子', lastName: '試験', userId: 9100002 },
    { id: '75123003', email: 'sales-three@example.com', firstName: '次郎', lastName: '架空', userId: 9100003 },
  ]
  const companies: SeedCompany[] = [
    { id: '2000000001', properties: { name: '株式会社サンプル', domain: 'sample.example.com' } },
    { id: '2000000002', properties: { name: '見本商事株式会社', domain: 'mihon-shoji.example.com' } },
    { id: '2000000003', properties: { name: '架空ラーニング株式会社', domain: 'kakuu-learning.example.com' } },
    { id: '2000000004', properties: { name: '例示製作所', domain: 'reiji.example.com' } },
    { id: '2000000005', properties: { name: 'テスト物産株式会社', domain: 'test-bussan.example.com' } },
  ]
  const deal = (n: number, name: string, stage: string, amount: string, close: string, owner: string, kakudo: string, nextStep: string, companyIds: string[]): SeedDeal => ({
    id: String(1000000000 + n),
    properties: {
      dealname: name,
      pipeline: 'default',
      dealstage: stage,
      amount,
      closedate: close,
      hubspot_owner_id: owner,
      juchu_kakudo: kakudo,
      hs_next_step: nextStep,
    },
    companyIds,
  })
  const deals: SeedDeal[] = [
    deal(1, '研修導入（株式会社サンプル）', 'qualifiedtobuy', '1200000', '2026-12-15T00:00:00.000Z', '75123001', 'medium', '資料送付', ['2000000001']),
    deal(2, '生成AI研修 2期（株式会社サンプル）', 'appointmentscheduled', '800000', '2027-01-31T00:00:00.000Z', '75123001', 'low', '初回面談の日程調整', ['2000000001']),
    deal(3, '新人研修パッケージ（見本商事株式会社）', 'presentationscheduled', '2400000', '2026-11-30T00:00:00.000Z', '75123002', 'high', '見積の最終確認', ['2000000002']),
    deal(4, '管理職研修（見本商事株式会社）', 'decisionmakerboughtin', '1800000', '2026-11-20T00:00:00.000Z', '75123002', 'high', '稟議の結果待ち', ['2000000002']),
    deal(5, 'eラーニング導入（架空ラーニング株式会社）', 'qualifiedtobuy', '3600000', '2027-02-28T00:00:00.000Z', '75123003', 'medium', 'デモの準備', ['2000000003']),
    deal(6, 'AI活用ワークショップ（例示製作所）', 'appointmentscheduled', '500000', '2026-12-25T00:00:00.000Z', '75123003', 'low', 'ヒアリング', ['2000000004']),
    deal(7, 'DX研修 年間契約（テスト物産株式会社）', 'contractsent', '4800000', '2026-11-15T00:00:00.000Z', '75123001', 'high', '契約書の返送待ち', ['2000000005']),
    deal(8, '営業研修（テスト物産株式会社）', 'closedwon', '900000', '2026-10-01T00:00:00.000Z', '75123002', 'high', '', ['2000000005']),
    deal(9, 'リーダー研修（例示製作所）', 'closedlost', '700000', '2026-09-30T00:00:00.000Z', '75123003', 'low', '', ['2000000004']),
    deal(10, 'プロンプト研修（架空ラーニング株式会社）', 'presentationscheduled', '600000', '2026-12-10T00:00:00.000Z', '75123001', 'medium', '提案書の修正', ['2000000003']),
  ]
  return { owners, companies, deals }
}

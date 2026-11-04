// A meeting's or a 来た連絡's 案件・プロジェクト field on the record card: `RecordBundleFieldBox.tsx`.
import type { BundleKind } from '../../../shared/types/records'
import type { BundleFieldContext } from '../features/records/components/RecordCard'
import { RecordBundleFieldBox } from './RecordBundleFieldBox'

/** `kind`: what the department on screen makes (`tasks:bundleKinds`); null until known (no 「新しい〇〇にする」). */
export function renderRecordBundleField(companyId: string, ctx: BundleFieldContext, kind: BundleKind | null, folder: string | null) {
  return <RecordBundleFieldBox key={ctx.record.id} companyId={companyId} ctx={ctx} kind={kind} folder={folder} />
}


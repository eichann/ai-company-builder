import { useContext } from 'react'
import { OpenConsultationContext } from '../consultation-context'
import type { ConsultationReference } from '../../../../shared/consultation-reference'
export function ConsultationReferenceLink({ reference }: { reference: ConsultationReference }) {
  const open = useContext(OpenConsultationContext)
  return <button className="my-1 block text-xs text-accent hover:underline text-left" onClick={() => open(reference.id)}>参照した相談：{reference.title}</button>
}

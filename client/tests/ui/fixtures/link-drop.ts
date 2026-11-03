// A fake `tasks:dropLink` for preview pages that decides with the real `dropLinkPlan` over the core
// types (plus a business plugin's 案件 `deal`), so a refusal or a choice reads as in the app. A
// record's type is its id's prefix; each linked drop logs `drop <target> <dropped>[ <link>]`.
import { coreTypeDefinitions } from '../../../../shared/core/core-types'
import type { TypeDefinition } from '../../../../shared/core/record-types'
import { dropLinkPlan, type DropLinkResult, type DroppedThing } from '../../../shared/link-drop'

const defs = new Map<string, TypeDefinition>(coreTypeDefinitions().map(d => [d.name, d]))
defs.set('deal', { ...defs.get('project')!, name: 'deal', label: '案件' })
const typeOf = (id: string) => id.slice(0, id.lastIndexOf('-'))

export function fakeDropLink(log: (line: string) => void) {
  return async (_companyId: string, targetId: string, dropped: DroppedThing, link?: string): Promise<DropLinkResult> => {
    const type = typeOf(targetId)
    const plan = dropLinkPlan({ type, def: defs.get(type) }, dropped.kind === 'path' ? 'file' : { type: typeOf(dropped.id), def: defs.get(typeOf(dropped.id)) })
    if ('refused' in plan) return { success: false, offline: false, error: plan.refused }
    const what = dropped.kind === 'path' ? dropped.path : dropped.id
    if (!link && plan.choices.length > 1) return { success: true, choose: plan.choices, question: `「${what}」を、どのつながりにしますか？` }
    const pick = plan.choices.find(c => c.link === (link ?? plan.choices[0].link))!
    log(`drop ${targetId} ${what} ${pick.source}:${pick.link}`)
    const holder = pick.source === 'target' || dropped.kind === 'path' ? targetId : dropped.id
    return { success: true, done: { text: `「${what.split('/').pop()}」をつなぎました`, undo: { recordId: holder, version: 9 } } }
  }
}

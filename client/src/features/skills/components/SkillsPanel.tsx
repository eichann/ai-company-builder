import { SkillGrid } from './SkillGrid'
import { SkillDetailPanel, type CompanyShelfActions } from './SkillDetailPanel'
import { shelfRuleClashNote } from '../../../../shared/skill-shelf'
import type { Skill, SkillTool } from '../model'

interface Props {
  skills: Skill[]
  isLoading: boolean
  color: string
  selectedSkill: Skill | undefined
  selectedSkillId: string | null
  onSelectSkill: (id: string) => void
  onCloseSkill: () => void
  onExecuteSkill: (id: string) => void
  onAddSkill: () => void
  /** Absent on 全社 (copying goes into a department). */
  onCopySkill?: () => void
  onEditFile: (filePath: string) => void
  onOpenTool: (tool: SkillTool, port: number) => void
  /** Absent for a company without the shared folder: skills stay on this PC (no 共有 section). */
  onPublish?: (skill: Skill) => Promise<string | null>
  onToggleNurturing: (skill: Skill) => Promise<string | null>
  /** A company without the shared folder: 「会社に公開」 and 「手元で直す」. */
  companyShelf?: CompanyShelfActions
  /** Delivered rule files not placed: the member has a file of that name. */
  ruleClashes?: string[]
}

/** The スキル tab: the department's skills, and the chosen one's details beside them. */
export function SkillsPanel(props: Props) {
  const { skills, isLoading, color, selectedSkill, selectedSkillId } = props
  return (
    <>
      <div className={`${selectedSkillId ? 'w-1/2' : 'w-full'} transition-all overflow-hidden flex flex-col`}>
        {!!props.ruleClashes?.length && (
          <div role="status" className="m-3 mb-0 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-700 dark:text-amber-400">{shelfRuleClashNote(props.ruleClashes)}</div>
        )}
        <SkillGrid
          skills={skills}
          color={color}
          selectedSkillId={selectedSkillId}
          onSelectSkill={props.onSelectSkill}
          onExecuteSkill={props.onExecuteSkill}
          onAddSkill={props.onAddSkill}
          onCopySkill={props.onCopySkill}
          isLoading={isLoading}
        />
      </div>
      {selectedSkillId && selectedSkill && (
        <div className="w-1/2 border-l border-gray-200 dark:border-zinc-800 overflow-hidden">
          <SkillDetailPanel
            skill={selectedSkill}
            color={color}
            onClose={props.onCloseSkill}
            onExecute={() => props.onExecuteSkill(selectedSkillId)}
            onEditFile={props.onEditFile}
            onOpenTool={props.onOpenTool}
            onPublish={props.onPublish}
            onToggleNurturing={props.onToggleNurturing}
            companyShelf={props.companyShelf}
          />
        </div>
      )}
    </>
  )
}

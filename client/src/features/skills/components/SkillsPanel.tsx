import { SkillGrid } from '../../../components/skill-ui/SkillGrid'
import { SkillDetailPanel } from '../../../components/skill-ui/SkillDetailPanel'
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
  onPublish: (skill: Skill) => void
  onToggleNurturing: (skill: Skill) => void
}

/** The スキル tab: the department's skills, and the chosen one's details beside them. */
export function SkillsPanel(props: Props) {
  const { skills, isLoading, color, selectedSkill, selectedSkillId } = props
  return (
    <>
      <div className={`${selectedSkillId ? 'w-1/2' : 'w-full'} transition-all overflow-hidden`}>
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
          />
        </div>
      )}
    </>
  )
}

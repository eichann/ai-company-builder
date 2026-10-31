import { useState } from 'react'
import type { AuthMode, CodexStatus } from '../../../../shared/agent'
import { agentCan } from '../../../../shared/agents/registry'
import { useAppStore } from '../../../stores/appStore'

const CODEX_MODEL_KEY = 'acb-codex-model'
const CODEX_EFFORT_KEY = 'acb-codex-effort'

/**
 * The model and effort the next request uses, per agent: a static model list
 * (Claude Code: the app store's choice, saved per member) or the agent's live
 * catalog (Codex `model/list`, registry capability `liveModelCatalog`: the
 * choice is kept in localStorage, falling back to the catalog's default).
 */
export function useAgentModelSelection(authMode: AuthMode, codexStatus: CodexStatus) {
  const aiModel = useAppStore((state) => state.aiModel)
  const setAIModel = useAppStore((state) => state.setAIModel)
  const aiEffort = useAppStore((state) => state.aiEffort)
  const setAIEffort = useAppStore((state) => state.setAIEffort)
  const [codexModelId, setCodexModelId] = useState(() => localStorage.getItem(CODEX_MODEL_KEY) || '')
  const [codexEffort, setCodexEffort] = useState(() => localStorage.getItem(CODEX_EFFORT_KEY) || '')
  const codexModel = codexStatus.models.find(m => m.id === codexModelId) || codexStatus.models.find(m => m.isDefault) || codexStatus.models[0]
  const selectedCodexEffort = codexModel?.efforts.includes(codexEffort) ? codexEffort : codexModel?.defaultEffort || ''
  const liveCatalog = agentCan(authMode, 'liveModelCatalog')
  const selectedModel = liveCatalog ? codexModel?.id : aiModel
  const selectedEffort = liveCatalog ? selectedCodexEffort : aiEffort

  // The store keeps the effort valid for the model (appStore setAIModel).
  const chooseCodexModel = (id: string) => { setCodexModelId(id); localStorage.setItem(CODEX_MODEL_KEY, id) }
  const chooseCodexEffort = (effort: string) => { setCodexEffort(effort); localStorage.setItem(CODEX_EFFORT_KEY, effort) }

  // A live-catalog agent that is not signed in or offers no model cannot take a message (the input is disabled, a banner says why).
  const agentUnavailable = liveCatalog && (!codexStatus.authenticated || !codexModel)

  return { aiModel, setAIModel, aiEffort, setAIEffort, codexModel, selectedCodexEffort, chooseCodexModel, chooseCodexEffort, selectedModel, selectedEffort, agentUnavailable }
}

export type AgentModelSelection = ReturnType<typeof useAgentModelSelection>

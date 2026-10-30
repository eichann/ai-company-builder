'use client'

import { createContext, useContext, type ReactNode } from 'react'

import { agentStopApi, type AgentStopView } from '@/lib/api'
import { useCompany } from '@/lib/company-context'
import { useQuery, type QueryResult } from '@/lib/use-query'

/**
 * The company's emergency stop view, shared by the bar on every page and the
 * 「AI の緊急停止」 page, so a stop made in one place shows in the other at once.
 * Owners and admins only (nobody else may read it).
 */
const AgentStopContext = createContext<QueryResult<AgentStopView> | null>(null)

export function AgentStopProvider({ children }: { children: ReactNode }) {
  const { companyId, isAdmin } = useCompany()
  const view = useQuery(isAdmin && companyId ? `agent-stops:${companyId}` : null, () => agentStopApi.get(companyId))
  return <AgentStopContext.Provider value={view}>{children}</AgentStopContext.Provider>
}

export function useAgentStops(): QueryResult<AgentStopView> | null {
  return useContext(AgentStopContext)
}

import { createContext } from 'react'
export const OpenConsultationContext = createContext<(id: string) => void>(() => {})

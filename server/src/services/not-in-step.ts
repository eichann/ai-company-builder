/**
 * The step gate's one answer (plugins.md "The gate of a step's run", ai-turns.md): a run's step
 * does not allow this operation, call, route or created type, whatever the reason (another plugin,
 * another company's, stopped, undeclared…). It names nothing.
 *
 * A leaf on purpose: the record engine's create (a core step's created types), the plugin
 * operation checks, AI runs, threads and the AI-token route all give it, and the operation checks
 * themselves use the record engine, so keeping it there made an import cycle.
 */
import { refuse } from './outcome'

export const NOT_IN_STEP = { error: 'この手順では使えない操作です', code: 'NOT_IN_STEP' } as const
export const notInStep = () => refuse('forbidden', NOT_IN_STEP.error, { code: NOT_IN_STEP.code })

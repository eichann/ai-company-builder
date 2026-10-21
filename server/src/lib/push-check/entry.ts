/**
 * Push checker entry point — run by the pre-receive hook
 * (server/src/templates/pre-receive-hook.sh, installed by lib/git-server):
 *
 *   "$node" --import <tsx loader> <this file>   (stdin: "<old> <new> <ref>" lines)
 *
 * Exit status: 0 accept, REJECT_EXIT (10) reject with the message already
 * written to stderr. Anything else — node or tsx failing to start, an
 * uncaught exception (exit 1) — makes the hook print [HOOK_ERROR] and reject:
 * a push is never accepted unchecked.
 */
import { readFileSync } from 'fs'
import { isRunnable, runPushCheck } from './check'
import { parsePushPolicy, writeGateFor, type WriteGate } from './policy'
import { hookErrorLine } from './report'

export const REJECT_EXIT = 10

function writeGateFromEnv(env: NodeJS.ProcessEnv): WriteGate | Buffer {
  const policyPath = env.ACB_PUSH_POLICY
  if (policyPath !== undefined) {
    // A push through git-http: always checked against its snapshot.
    try {
      return writeGateFor(parsePushPolicy(readFileSync(policyPath, 'utf8')))
    } catch (err) {
      console.error('[push-check] cannot read the push policy:', err instanceof Error ? err.message : err)
      return hookErrorLine('権限情報を読み込めませんでした')
    }
  }
  // ACB_INTERNAL_PUSH=1 (the server's own pushes) or no request context
  // (local transport on the server host): no pusher to check — see policy.ts.
  return { kind: 'allow-all' }
}

async function main(): Promise<number> {
  const env = process.env
  const gate = writeGateFromEnv(env)
  if (Buffer.isBuffer(gate)) {
    process.stderr.write(gate)
    return REJECT_EXIT
  }
  // ACB_NODE is the runtime the server expects the content checks to run
  // under. If it cannot be run, the hook started this checker on a fallback
  // runtime; skill/agent/command contents then count as uninspectable and
  // fail closed, as they did when the shell hook's embedded check could not run.
  const contentCheckAvailable = env.ACB_NODE === undefined || env.ACB_NODE === '' || isRunnable(env.ACB_NODE)
  const result = await runPushCheck(readFileSync(0), {
    pusherRole: env.ACB_PUSHER_ROLE,
    writeGate: gate,
    contentCheckAvailable,
  })
  if (!result.rejected) return 0
  await new Promise<void>((resolve) => process.stderr.write(result.output, () => resolve()))
  return REJECT_EXIT
}

main().then(
  (code) => { process.exitCode = code },
  (err) => {
    console.error('[push-check] failed:', err instanceof Error ? err.stack : err)
    process.exitCode = 2
  },
)

/**
 * The core app asks for a role, never for Google (`.claude/rules/connector-roles.md`
 * "Role providers", plan §5-2): a core service does not import a Google module —
 * `services/google-*.ts`, `shared/core/google*.ts`, `shared/types/google*.ts` —
 * but takes the role's port (`ports/calendar.ts`, `ports/meeting-records.ts`,
 * `ports/mail.ts`) wired in `composition/connectors.ts`. Google's own modules
 * (the connector boundary) are the `google-*` files themselves.
 *
 * A file listed in GOOGLE_BOUNDARY may name Google with its reason; a new core
 * service that reaches for Google directly fails here.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'

const SRC = resolve(__dirname, '../../src')
const SERVICES = join(SRC, 'services')

/** Services outside the google-* files that may import a Google module, with the reason. */
const GOOGLE_BOUNDARY: Record<string, string> = {
  'services/slack-connector.ts': 'another connector\'s own module, not a core service: it uses only the email comparison (sameEmail)',
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
}

const isGoogleModule = (spec: string) => /(^|\/)google(-[^/]*)?$/.test(spec)

describe('connector boundary', () => {
  it('core services reach Google only through the role ports', () => {
    const files = readdirSync(SERVICES, { recursive: true, encoding: 'utf8' })
      .filter(f => f.endsWith('.ts'))
      .map(f => join(SERVICES, f))
      .filter(f => !/(^|\/)google-[^/]*\.ts$/.test(relative(SERVICES, f)))
    expect(files.length).toBeGreaterThan(20)
    const offenders: string[] = []
    for (const file of files) {
      const name = relative(SRC, file)
      if (GOOGLE_BOUNDARY[name]) continue
      for (const spec of importsOf(file)) if (isGoogleModule(spec)) offenders.push(`${name}: ${spec}`)
    }
    expect(offenders).toEqual([])
  })

  it('the check sees a Google import (the pattern is not blind)', () => {
    for (const spec of ['./google-client', './google-meetings', '../../shared/core/google', '../../shared/core/google-drive', '../../shared/types/google']) {
      expect(isGoogleModule(spec), spec).toBe(true)
    }
    for (const spec of ['./connector-roles', '../ports/mail', '../../shared/core/mail']) expect(isGoogleModule(spec), spec).toBe(false)
  })
})

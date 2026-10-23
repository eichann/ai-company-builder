/**
 * Check a JSON value against a TypeScript type declared in another package,
 * at runtime, with the TypeScript compiler's own view of that type.
 *
 * Used by the admin contract test: admin/src/lib/api.ts declares the shapes
 * the admin console expects by hand (its Docker build cannot import the
 * server), so real server responses are checked against those declarations.
 *
 * Supported: string / number / boolean / null / undefined, literal types and
 * unions of them, arrays, object types (interfaces, type literals,
 * intersections), optional properties, `unknown` / `any`. Properties the
 * value has but the type does not declare are reported separately (`extra`):
 * they do not break the admin, but show where its types lag behind.
 */
import ts from 'typescript'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface ShapeReport {
  /** Mismatches: the admin would read a field that is missing or of another type. */
  errors: string[]
  /** Fields the server sends that the admin type does not declare. */
  extra: string[]
}

export interface TypeShapes {
  check(typeName: string, value: unknown): ShapeReport
}

/**
 * Compile `source` (TypeScript; `import type` from absolute paths is fine)
 * and return a checker for its exported type aliases `T_<name>`.
 */
export function loadTypeShapes(source: string): TypeShapes {
  const dir = mkdtempSync(join(tmpdir(), 'acb-type-shape-'))
  const file = join(dir, 'shapes.ts')
  writeFileSync(file, source)
  const program = ts.createProgram([file], {
    strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  })
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === file)
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'))
  }
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(file)!
  const aliases = new Map<string, ts.Type>()
  sf.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, checker.getTypeAtLocation(node.name))
  })
  rmSync(dir, { recursive: true, force: true })

  const show = (t: ts.Type) => checker.typeToString(t)

  function validate(type: ts.Type, value: unknown, at: string, report: ShapeReport): boolean {
    const f = type.flags
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
    if (type.isUnion()) {
      // Try each member; report the closest one's errors if none fits.
      let best: ShapeReport | null = null
      for (const member of type.types) {
        const r: ShapeReport = { errors: [], extra: [] }
        if (validate(member, value, at, r)) {
          report.extra.push(...r.extra)
          return true
        }
        if (!best || r.errors.length < best.errors.length) best = r
      }
      if (best && best.errors.length > 0 && typeof value === 'object' && value !== null) report.errors.push(...best.errors)
      else report.errors.push(`${at}: ${JSON.stringify(value)} is not ${show(type)}`)
      return false
    }
    const fail = () => { report.errors.push(`${at}: ${JSON.stringify(value)?.slice(0, 80)} is not ${show(type)}`); return false }
    if (f & ts.TypeFlags.StringLiteral) return value === (type as ts.StringLiteralType).value || fail()
    if (f & ts.TypeFlags.NumberLiteral) return value === (type as ts.NumberLiteralType).value || fail()
    if (f & ts.TypeFlags.BooleanLiteral) return value === (show(type) === 'true') || fail()
    if (f & ts.TypeFlags.String) return typeof value === 'string' || fail()
    if (f & ts.TypeFlags.Number) return typeof value === 'number' || fail()
    if (f & ts.TypeFlags.Boolean) return typeof value === 'boolean' || fail()
    if (f & ts.TypeFlags.Null) return value === null || fail()
    if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return value === undefined || fail()
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      if (!Array.isArray(value)) return fail()
      const [element] = checker.getTypeArguments(type as ts.TypeReference)
      let ok = true
      value.forEach((v, i) => { ok = validate(element, v, `${at}[${i}]`, report) && ok })
      return ok
    }
    if (f & ts.TypeFlags.Object || type.isIntersection()) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail()
      const obj = value as Record<string, unknown>
      const props = checker.getPropertiesOfType(type)
      const indexType = checker.getIndexTypeOfType(type, ts.IndexKind.String)
      let ok = true
      for (const prop of props) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0]
        const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getDeclaredTypeOfSymbol(prop)
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0
        if (!(prop.name in obj)) {
          if (!optional) { report.errors.push(`${at}.${prop.name}: missing (admin expects ${show(propType)})`); ok = false }
          continue
        }
        if (obj[prop.name] === undefined && optional) continue
        ok = validate(propType, obj[prop.name], `${at}.${prop.name}`, report) && ok
      }
      const declared = new Set(props.map(p => p.name))
      for (const key of Object.keys(obj)) {
        if (declared.has(key)) continue
        if (indexType) ok = validate(indexType, obj[key], `${at}.${key}`, report) && ok
        else report.extra.push(`${at}.${key}`)
      }
      return ok
    }
    return fail()
  }

  return {
    check(typeName, value) {
      const type = aliases.get(`T_${typeName}`)
      if (!type) throw new Error(`no type alias T_${typeName}`)
      const report: ShapeReport = { errors: [], extra: [] }
      validate(type, value, typeName, report)
      report.extra = [...new Set(report.extra.map(e => e.replace(/\[\d+\]/g, '[]')))]
      report.errors = [...new Set(report.errors)]
      return report
    },
  }
}

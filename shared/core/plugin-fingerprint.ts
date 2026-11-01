/**
 * A package's fingerprint and its signature slot (plan C1, design 節目5 §3-1,
 * 統合版 §10-3). One copy for the server's shelf and, later, the app that
 * checks what it received (C2) — so both compute the same value.
 *
 * - **v1** (contract 1, unchanged so existing installs keep matching): sha256
 *   over `path \0 text \0` of every file, in the shelf's reading order. Kept
 *   in `adapters/plugin-shelf.ts`.
 * - **v2** (contract 2): each file's sha256 over its bytes, listed one per line
 *   as `<sha256 hex>  <path>\n` in name order (UTF-16 code unit order of the
 *   relative `/` path), after the header `acb-plugin-fingerprint-v2\n`; the
 *   fingerprint is the sha256 of that listing. One byte changed, a file added,
 *   removed or renamed → another fingerprint. `signature.yaml` is not part of
 *   it (it signs the fingerprint).
 *
 * The hash itself is injected (shared/core imports no Node built-ins).
 *
 * The signature slot (`signature.yaml`, §5-12): the package's place for a
 * signature over `pluginSignedMessage(id, version, fingerprint)`. Read and
 * checked for shape only; **nothing verifies it yet** and nothing trusts it
 * (before packages go to outside companies, the app verifies it with a public
 * key it carries). The signer is div's key (`div`) or, later, one company's own
 * key (`company:<id>`) for a package only that company may use.
 */
import { COMPANY_ID_RE, unknownKeys } from './plugin-declaration-rules'
import type { PluginManifest, PluginParsed } from './plugin-declaration'
import { isYamlMap, parseYamlLite } from './yaml-lite'

export const PLUGIN_FINGERPRINT_V2_HEADER = 'acb-plugin-fingerprint-v2\n'
/** The signature slot's file, at the package root; never part of the fingerprint. */
export const PLUGIN_SIGNATURE_FILE = 'signature.yaml'
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

/** The listing whose sha256 is the v2 fingerprint. `files`: each relative path with the sha256 (hex) of its bytes. */
export function pluginFingerprintV2Listing(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  const sorted = files.filter(f => f.path !== PLUGIN_SIGNATURE_FILE).slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]
    if (!SHA256_HEX_RE.test(f.sha256)) throw new Error('a file hash must be sha256 hex')
    if (f.path === '' || /[\n\0\\]/.test(f.path) || f.path.startsWith('/') || f.path.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) throw new Error('a package path must be relative and plain')
    if (i > 0 && sorted[i - 1].path === f.path) throw new Error('a path is listed twice')
  }
  return PLUGIN_FINGERPRINT_V2_HEADER + sorted.map(f => `${f.sha256}  ${f.path}\n`).join('')
}

/** The v2 fingerprint of a package's files (bytes), with the caller's sha256 (hex). */
export function pluginFingerprintV2(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, sha256Hex: (data: Uint8Array | string) => string): string {
  return sha256Hex(pluginFingerprintV2Listing(files.map(f => ({ path: f.path, sha256: sha256Hex(f.bytes) }))))
}

export interface PluginSignature {
  /** `div` (the operator's key) or `company:<id>` (that company's own key, for its own package). */
  signer: string
  algorithm: 'ed25519'
  /** Which of the signer's keys (keys are rotated). */
  keyId: string
  /** The signature, base64. */
  value: string
}

/** What a signature signs: the package's id, version and fingerprint (v2). */
export const pluginSignedMessage = (id: string, version: string, fingerprint: string): string =>
  `acb-plugin-signature-v1\n${id}\n${version}\n${fingerprint}\n`

const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BASE64_RE = /^[A-Za-z0-9+/]{4,684}={0,2}$/

/**
 * Read the signature slot. Shape only — the caller must not treat a parsed
 * signature as verified. A company's key signs only a package that company
 * alone may use (`available_to: [<that id>]`).
 */
export function parsePluginSignature(text: string, manifest: Pick<PluginManifest, 'contract' | 'availableTo' | 'kind'>): PluginParsed<PluginSignature> {
  if (manifest.contract < 2) return { ok: false, errors: [`${PLUGIN_SIGNATURE_FILE} は contract: 2 の包みだけに置けます`] }
  const yaml = parseYamlLite(text)
  if (!yaml.ok) return { ok: false, errors: [`${PLUGIN_SIGNATURE_FILE} ${yaml.line} 行目: ${yaml.error}`] }
  const raw = yaml.value
  if (!isYamlMap(raw)) return { ok: false, errors: [`${PLUGIN_SIGNATURE_FILE} は「項目名: 値」の形で書いてください`] }
  const errors: string[] = []
  const err = (m: string) => { errors.push(m) }
  unknownKeys(`${PLUGIN_SIGNATURE_FILE}: `, raw, ['signer', 'algorithm', 'key_id', 'value'], err)
  const signer = raw.signer
  if (signer === 'div') { /* the operator's key */ } else if (typeof signer === 'string' && signer.startsWith('company:') && COMPANY_ID_RE.test(signer.slice(8))) {
    const company = signer.slice(8)
    if (manifest.kind !== 'company' || manifest.availableTo?.length !== 1 || manifest.availableTo[0] !== company) {
      err(`${PLUGIN_SIGNATURE_FILE}: 会社の鍵で署名できるのは、その会社だけが使う包み（kind: company、available_to: [${company}]）だけです`)
    }
  } else err(`${PLUGIN_SIGNATURE_FILE} の signer は div か company:<会社の id> です`)
  if (raw.algorithm !== 'ed25519') err(`${PLUGIN_SIGNATURE_FILE} の algorithm は ed25519 です`)
  if (typeof raw.key_id !== 'string' || !KEY_ID_RE.test(raw.key_id)) err(`${PLUGIN_SIGNATURE_FILE} の key_id は鍵の名前です`)
  if (typeof raw.value !== 'string' || !BASE64_RE.test(raw.value)) err(`${PLUGIN_SIGNATURE_FILE} の value は署名（base64）です`)
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { signer: signer as string, algorithm: 'ed25519', keyId: raw.key_id as string, value: raw.value as string } }
}

/**
 * SQLite storage of a business plugin's steps (ports/plugin-steps.ts), limited
 * to one company: every statement binds `company_id = ?`.
 */
import type Database from 'better-sqlite3'
import type { PluginStepProcedurePin } from '../../../shared/core/plugins'
import type { PluginStepPinRow, PluginStepRepository } from '../../ports/plugin-steps'

interface PinDbRow {
  record_id: string; plugin_id: string; step: string; source: string
  version: string | null; skill: string | null; fingerprint: string; pinned_at: string; updated_at: string
}

function pinOf(r: PinDbRow): PluginStepProcedurePin | null {
  if (r.source === 'plugin' && r.version) return { source: 'plugin', pluginId: r.plugin_id, version: r.version, fingerprint: r.fingerprint }
  if (r.source === 'company_skill' && r.skill) return { source: 'company_skill', skill: r.skill, fingerprint: r.fingerprint }
  return null
}

/** The stored columns of a pin: (source, version, skill, fingerprint). */
const columnsOf = (p: PluginStepProcedurePin): [string, string | null, string | null, string] =>
  p.source === 'plugin' ? ['plugin', p.version, null, p.fingerprint] : ['company_skill', null, p.skill, p.fingerprint]

export function sqlitePluginStepRepository(conn: Database.Database, companyId: string): PluginStepRepository {
  return {
    pin(recordId, pluginId, step) {
      const r = conn.prepare('SELECT * FROM plugin_step_pins WHERE company_id = ? AND record_id = ? AND plugin_id = ? AND step = ?')
        .get(companyId, recordId, pluginId, step) as PinDbRow | undefined
      const pin = r ? pinOf(r) : null
      return r && pin ? { recordId: r.record_id, pluginId: r.plugin_id, step: r.step, pin, pinnedAt: r.pinned_at, updatedAt: r.updated_at } : null
    },
    insertPin(row: PluginStepPinRow) {
      const [source, version, skill, fingerprint] = columnsOf(row.pin)
      return conn.prepare(`INSERT OR IGNORE INTO plugin_step_pins
        (company_id, record_id, plugin_id, step, source, version, skill, fingerprint, pinned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(companyId, row.recordId, row.pluginId, row.step, source, version, skill, fingerprint, row.pinnedAt, row.updatedAt).changes === 1
    },
    movePin(recordId, pluginId, step, from, to, at) {
      const [fs, fv, fk, ff] = columnsOf(from)
      const [ts, tv, tk, tf] = columnsOf(to)
      return conn.prepare(`UPDATE plugin_step_pins SET source = ?, version = ?, skill = ?, fingerprint = ?, updated_at = ?
        WHERE company_id = ? AND record_id = ? AND plugin_id = ? AND step = ? AND source = ? AND version IS ? AND skill IS ? AND fingerprint = ?`)
        .run(ts, tv, tk, tf, at, companyId, recordId, pluginId, step, fs, fv, fk, ff).changes === 1
    },
    pluginPins(pluginId) {
      const rows = conn.prepare(`SELECT record_id, version, fingerprint FROM plugin_step_pins
        WHERE company_id = ? AND plugin_id = ? AND source = 'plugin' AND version IS NOT NULL ORDER BY record_id, step`)
        .all(companyId, pluginId) as Array<{ record_id: string; version: string; fingerprint: string }>
      return rows.map(r => ({ recordId: r.record_id, version: r.version, fingerprint: r.fingerprint }))
    },
    stepSkills(pluginId) {
      const rows = conn.prepare('SELECT step, skill FROM plugin_step_skills WHERE company_id = ? AND plugin_id = ? ORDER BY step')
        .all(companyId, pluginId) as Array<{ step: string; skill: string }>
      return Object.fromEntries(rows.map(r => [r.step, r.skill]))
    },
    setStepSkill(pluginId, step, skill, at, by) {
      if (skill === null) {
        conn.prepare('DELETE FROM plugin_step_skills WHERE company_id = ? AND plugin_id = ? AND step = ?').run(companyId, pluginId, step)
        return
      }
      conn.prepare(`INSERT INTO plugin_step_skills (company_id, plugin_id, step, skill, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (company_id, plugin_id, step) DO UPDATE SET skill = excluded.skill, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(companyId, pluginId, step, skill, at, by)
    },
  }
}

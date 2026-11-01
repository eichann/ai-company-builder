/**
 * Lane C (the plugin foundation) wiring: the services this lane adds, built
 * here so the lane does not edit the shared body of src/composition.ts
 * (.claude/rules/server.md "Lane markers"). createServices calls this once and
 * spreads what it returns into the services. Like composition.ts, this module
 * may import adapters.
 *
 * Add what the lane needs to PluginsLaneDeps and pass it at this lane's one
 * call line in composition.ts.
 */
import type Database from 'better-sqlite3'

export interface PluginsLaneDeps {
  conn: Database.Database
}

export function wirePluginsLane(deps: PluginsLaneDeps) {
  void deps // nothing wired yet
  return {}
}

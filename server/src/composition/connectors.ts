/**
 * Lane A (connectors) wiring: the services this lane adds, built here so the
 * lane does not edit the shared body of src/composition.ts
 * (.claude/rules/server.md "Lane markers"). createServices calls this once and
 * spreads what it returns into the services. Like composition.ts, this module
 * may import adapters.
 *
 * Add what the lane needs to ConnectorsLaneDeps and pass it at this lane's one
 * call line in composition.ts.
 */
import type Database from 'better-sqlite3'

export interface ConnectorsLaneDeps {
  conn: Database.Database
}

export function wireConnectorsLane(deps: ConnectorsLaneDeps) {
  void deps // nothing wired yet
  return {}
}

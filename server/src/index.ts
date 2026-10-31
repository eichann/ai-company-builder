// Must be the first import: loads .env before lib/auth checks AUTH_SECRET
import './env'
import { serve } from '@hono/node-server'
import { authDb } from './lib/auth'
import { initDatabase } from './db'
import { configureAllBareRepos } from './routes/git'
import { scheduleAgentEventRetention } from './lib/agent-event-retention'
import { services } from './composition'
import { PRACTICE_UPSTREAMS } from './lib/config'
import { app } from './app'

// Initialize database
initDatabase()

// Bring existing company repos up to the current standard configuration
// (force-push protection, HTTP push, latest pre-receive hook)
{
  const { total, failed } = configureAllBareRepos()
  console.log(`Configured ${total - failed}/${total} bare repositories${failed > 0 ? ` (${failed} failed)` : ''}`)
}

// The key broker (API keys): on only with a usable key-encryption key file.
{
  const broker = services.brokerVault.status()
  console.log(broker.enabled ? `Key broker: on (key-encryption key ${broker.kekId})` : `Key broker: off — ${broker.detail}`)
  // Staging only (lib/config.ts): say loudly where HubSpot / Google go, or why the setting was not used.
  if (PRACTICE_UPSTREAMS.state === 'on') {
    for (const service of new Set(PRACTICE_UPSTREAMS.upstreams.map(u => u.service))) {
      const list = PRACTICE_UPSTREAMS.upstreams.filter(u => u.service === service)
      const t = list[0].target
      const label = service === 'google' ? 'Google' : 'HubSpot'
      console.warn(`Key broker: 練習用の ${label} につながっています — ${service} (${list.map(u => u.host).join(', ')}) → ${t.protocol}//${t.hostname}:${t.port}`)
    }
  } else if (PRACTICE_UPSTREAMS.state === 'ignored') {
    console.warn(`Key broker: practice upstream setting ignored — ${PRACTICE_UPSTREAMS.reason}`)
  }
}

// The plugin shelf (PLUGINS_DIR): packages that do not pass the rules are not used (folder name + reason only).
void services.pluginShelf.load().then(({ loaded, refused }) => {
  console.log(`Plugin shelf: ${loaded.length > 0 ? loaded.join(', ') : 'no packages'}`)
  for (const r of refused) console.warn(`Plugin shelf: not used — ${r.dir}: ${r.reason}`)
}, () => console.warn('Plugin shelf: could not be read'))

// Clean up expired sessions on startup (lib/auth.ts's one connection, kept open)

// Ensure Better Auth tables exist (created here so a fresh install boots without
// a manual migration step — mirrors initDatabase() for app.sqlite).
authDb.exec(`
  CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    expiresAt TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TEXT,
    refreshTokenExpiresAt TEXT,
    scope TEXT,
    password TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const deleted = authDb.prepare('DELETE FROM session WHERE expiresAt < ?').run(new Date().toISOString())
if (deleted.changes > 0) {
  console.log(`Cleaned up ${deleted.changes} expired session(s)`)
}

// Start server
const port = Number(process.env.PORT) || 3001

console.log(`Server starting on port ${port}...`)

const server = serve({
  fetch: app.fetch,
  port,
})

// Git pushes/clones send the whole pack as one long request. Node's default
// requestTimeout (300s) severs uploads that take longer than 5 minutes on
// slow links, so raise the cap to 1 hour.
;(server as import('node:http').Server).requestTimeout = 60 * 60 * 1000

console.log(`Server is running on http://localhost:${port}`)

// The AI action log: delete events past each company's retention (shortly
// after start, then daily).
scheduleAgentEventRetention(() => services.agentEvents.prune())

import { Hono } from 'hono'
import { db, generateId, now } from '../db'
import { getUserFromRequest } from '../lib/auth'
import { createHash } from 'crypto'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// SSH authorized_keys path
const SSH_DIR = join(homedir(), '.ssh')
const AUTHORIZED_KEYS_PATH = join(SSH_DIR, 'authorized_keys')
const MARKER_START = '### AI-COMPANY-BUILDER-KEYS-START ###'
const MARKER_END = '### AI-COMPANY-BUILDER-KEYS-END ###'

export const sshKeysRoute = new Hono()

// Calculate SSH key fingerprint
function calculateFingerprint(publicKey: string): string {
  // Extract the key data (remove ssh-rsa/ssh-ed25519 prefix and comment)
  const parts = publicKey.trim().split(' ')
  if (parts.length < 2) {
    throw new Error('Invalid SSH public key format')
  }
  const keyData = parts[1]
  const buffer = Buffer.from(keyData, 'base64')
  const hash = createHash('sha256').update(buffer).digest('base64')
  return `SHA256:${hash.replace(/=+$/, '')}`
}

// Sync authorized_keys file with database
function syncAuthorizedKeys(): void {
  try {
    // Ensure .ssh directory exists
    if (!existsSync(SSH_DIR)) {
      mkdirSync(SSH_DIR, { mode: 0o700 })
    }

    // Get all active keys from database
    const keys = db.prepare(`
      SELECT public_key FROM ssh_keys WHERE is_active = 1
    `).all() as { public_key: string }[]

    // Build the managed keys section
    const managedKeys = keys.length > 0
      ? `${MARKER_START}\n${keys.map(k => k.public_key).join('\n')}\n${MARKER_END}`
      : `${MARKER_START}\n${MARKER_END}`

    // Read existing authorized_keys
    let existingContent = ''
    if (existsSync(AUTHORIZED_KEYS_PATH)) {
      existingContent = readFileSync(AUTHORIZED_KEYS_PATH, 'utf-8')
    }

    // Check if our managed section exists
    const startIndex = existingContent.indexOf(MARKER_START)
    const endIndex = existingContent.indexOf(MARKER_END)

    let newContent: string
    if (startIndex !== -1 && endIndex !== -1) {
      // Replace existing managed section
      newContent = existingContent.substring(0, startIndex) +
        managedKeys +
        existingContent.substring(endIndex + MARKER_END.length)
    } else {
      // Append managed section
      newContent = existingContent.trim() + '\n\n' + managedKeys + '\n'
    }

    // Write back
    writeFileSync(AUTHORIZED_KEYS_PATH, newContent.trim() + '\n', { mode: 0o600 })
    console.log('Synced authorized_keys with', keys.length, 'keys')
  } catch (error) {
    console.error('Failed to sync authorized_keys:', error)
  }
}

// Validate SSH public key format
function isValidSSHPublicKey(key: string): boolean {
  const trimmed = key.trim()
  // Must start with a valid key type
  const validPrefixes = ['ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']
  return validPrefixes.some(prefix => trimmed.startsWith(prefix + ' '))
}

// List user's SSH keys
sshKeysRoute.get('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const keys = db.prepare(`
    SELECT id, public_key, fingerprint, device_name, is_active, last_used_at, created_at
    FROM ssh_keys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(user.id) as Array<{
    id: string
    public_key: string
    fingerprint: string
    device_name: string | null
    is_active: number
    last_used_at: string | null
    created_at: string
  }>

  // Convert to camelCase
  const formattedKeys = keys.map(k => ({
    id: k.id,
    publicKey: k.public_key,
    fingerprint: k.fingerprint,
    deviceName: k.device_name,
    isActive: k.is_active === 1,
    lastUsedAt: k.last_used_at,
    createdAt: k.created_at,
  }))

  return c.json({
    success: true,
    data: formattedKeys,
  })
})

// Register a new SSH public key
sshKeysRoute.post('/', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json()
  const { publicKey, deviceName, name } = body
  const keyName = deviceName || name // Accept either field name

  if (!publicKey || typeof publicKey !== 'string') {
    return c.json({ error: 'publicKey is required' }, 400)
  }

  const trimmedKey = publicKey.trim()

  if (!isValidSSHPublicKey(trimmedKey)) {
    return c.json({ error: 'Invalid SSH public key format' }, 400)
  }

  let fingerprint: string
  try {
    fingerprint = calculateFingerprint(trimmedKey)
  } catch (e) {
    return c.json({ error: 'Failed to calculate key fingerprint' }, 400)
  }

  // Check if key already exists
  const existing = db.prepare(`
    SELECT id, user_id FROM ssh_keys WHERE fingerprint = ?
  `).get(fingerprint) as { id: string; user_id: string } | undefined

  if (existing) {
    if (existing.user_id === user.id) {
      return c.json({ error: 'This key is already registered' }, 409)
    } else {
      return c.json({ error: 'This key is registered by another user' }, 409)
    }
  }

  // Check key limit (max 5 keys per user)
  const keyCount = db.prepare(`
    SELECT COUNT(*) as count FROM ssh_keys WHERE user_id = ?
  `).get(user.id) as { count: number }

  if (keyCount.count >= 5) {
    return c.json({ error: 'Maximum of 5 SSH keys allowed per user' }, 400)
  }

  const id = generateId()
  const timestamp = now()

  db.prepare(`
    INSERT INTO ssh_keys (id, user_id, public_key, fingerprint, device_name, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, user.id, trimmedKey, fingerprint, keyName || null, timestamp)

  // Sync authorized_keys file
  syncAuthorizedKeys()

  return c.json({
    success: true,
    data: {
      id,
      fingerprint,
      deviceName: keyName || null,
      isActive: true,
      createdAt: timestamp,
    },
  }, 201)
})

// Delete an SSH key
sshKeysRoute.delete('/:id', async (c) => {
  const user = await getUserFromRequest(c.req.raw)
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const keyId = c.req.param('id')

  // Check if key belongs to user
  const key = db.prepare(`
    SELECT id FROM ssh_keys WHERE id = ? AND user_id = ?
  `).get(keyId, user.id)

  if (!key) {
    return c.json({ error: 'Key not found' }, 404)
  }

  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(keyId)

  // Sync authorized_keys file
  syncAuthorizedKeys()

  return c.json({
    success: true,
    message: 'Key deleted',
  })
})

// Get all active SSH keys (for future AuthorizedKeysCommand use)
// DISABLED: Currently unused. Keys are synced via syncAuthorizedKeys() file write.
// Re-enable when implementing SSH isolation (#3) with AuthorizedKeysCommand.
// sshKeysRoute.get('/authorized', async (c) => { ... })

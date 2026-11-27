/**
 * 「ブラウザ操作」 の記録 (agent-browser.md "Recording"). Rules: services/browser-recordings.ts; shapes:
 * shared/types/browser-recordings.ts. A person's session only (no record-token route; no AI tool calls these: an owner / admin
 * reads everyone's here — the sender's own AI reads the sender's own through routes/browser-skill-drafts.ts).
 *
 * Mounted at /api/companies/:companyId:
 *   POST   /browser-recordings                 + this PC's key header; { domain, content }: send one recording
 *   GET    /browser-recordings                 the sender's own; an owner / admin: every recording of the company
 *   GET    /browser-recordings/:recordingId    open one (the sender or an owner / admin)
 *   DELETE /browser-recordings/:recordingId    delete one, content included (the sender or an owner / admin)
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { BROWSER_RECORDING_LIMITS } from '../../shared/core/browser-recording'
import { services } from '../composition'
import { BROWSER_RECORDING_SERVER_WORDS } from '../services/browser-recordings'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserRecordingsRoute = new Hono()
const { browserRecordings } = services

/** The recording's own limit plus room for the envelope. */
const sendBodyLimit = bodyLimit({
  maxSize: BROWSER_RECORDING_LIMITS.bytes + 4096,
  onError: c => c.json({ error: BROWSER_RECORDING_SERVER_WORDS.tooLarge, code: 'BROWSER_RECORDING_TOO_LARGE' }, 413),
})

browserRecordingsRoute.post('/browser-recordings', companyMember, sendBodyLimit, serviceBody, (c) => {
  const r = browserRecordings.send(c.var.member, c.req.header(BROWSER_DEVICE_HEADER), c.var.body)
  return r.ok ? c.json({ success: true, data: r.value }, 201) : refusal(c, r)
})

browserRecordingsRoute.get('/browser-recordings', companyMember, (c) => {
  const r = browserRecordings.list(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserRecordingsRoute.get('/browser-recordings/:recordingId', companyMember, (c) => {
  const r = browserRecordings.get(c.var.member, c.req.param('recordingId'))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserRecordingsRoute.delete('/browser-recordings/:recordingId', companyMember, (c) => {
  const r = browserRecordings.remove(c.var.member, c.req.param('recordingId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

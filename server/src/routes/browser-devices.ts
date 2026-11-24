/**
 * The PCs used for 「ブラウザ操作」 (agent-browser.md "This PC's registration"). Rules: services/browser-devices.ts; shapes:
 * shared/types/browser-devices.ts. A person's session only (no record-token route exists). The PC's key travels only in
 * its header (`X-ACB-Browser-Device`), never in a URL or a body, and is never answered.
 *
 * Mounted at /api/companies/:companyId:
 *   POST   /browser-devices                     + the PC's key header; { label }: this member registers this PC (pending)
 *   GET    /browser-devices-me                  + the PC's key header: this member's registration of this PC (or none)
 *   DELETE /browser-devices-me                  + the PC's key header: 取り下げる / この PC での利用をやめる
 *   GET    /browser-devices                     owner/admin: every registration and the history
 *   POST   /browser-devices/:deviceId/enable    owner/admin: 使えるようにする
 *   POST   /browser-devices/:deviceId/revoke    owner/admin: 止める
 */
import { Hono } from 'hono'
import { BROWSER_DEVICE_HEADER } from '../../shared/core/browser-device'
import { services } from '../composition'
import { refusal } from './respond'
import { companyMember, serviceBody } from './guards'

export const browserDevicesRoute = new Hono()
const { browserDevices } = services

browserDevicesRoute.post('/browser-devices', companyMember, serviceBody, (c) => {
  const r = browserDevices.register(c.var.member, c.req.header(BROWSER_DEVICE_HEADER), c.var.body)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value.device }, r.value.created ? 201 : 200)
})

// Its own segment (not /browser-devices/me beside /browser-devices/:deviceId): keeps Hono's RegExpRouter (server.md).
browserDevicesRoute.get('/browser-devices-me', companyMember, (c) => {
  const r = browserDevices.mine(c.var.member, c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserDevicesRoute.delete('/browser-devices-me', companyMember, (c) => {
  const r = browserDevices.withdraw(c.var.member, c.req.header(BROWSER_DEVICE_HEADER))
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserDevicesRoute.get('/browser-devices', companyMember, (c) => {
  const r = browserDevices.list(c.var.member)
  if (!r.ok) return refusal(c, r)
  c.header('Cache-Control', 'no-store')
  return c.json({ success: true, data: r.value })
})

browserDevicesRoute.post('/browser-devices/:deviceId/enable', companyMember, (c) => {
  const r = browserDevices.enable(c.var.member, c.req.param('deviceId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

browserDevicesRoute.post('/browser-devices/:deviceId/revoke', companyMember, (c) => {
  const r = browserDevices.revoke(c.var.member, c.req.param('deviceId'))
  return r.ok ? c.json({ success: true, data: r.value }) : refusal(c, r)
})

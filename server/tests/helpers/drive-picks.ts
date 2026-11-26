/**
 * Keeps Drive picks the way the app makes them (google-drive.md "Picker and its token"): a pick ticket with the member's
 * session, the Picker page's config and result (the ticket is the proof), then the app reads the result and closes the
 * ticket. `POST …/me/google/drive/picks` fails closed ("Viewing a video"), so a test that needs picks makes them here.
 *
 * Answers in the old route's shape (`{ status, body: { data: { picks, refused } } }`) so a setup reads as before. The
 * Google side (the member pressed 選択 on these ids) is the fake's `pick(clientId, email, ids)`, as before.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any
type Call = (opts: { user?: string | null; method: string; path: string; body?: unknown }) => Promise<{ status: number; body: Json; text: string }>

export async function keepDrivePicks(
  call: Call, companyId: string, user: string, pick: { mode: 'folder' | 'files'; ids: string[]; purpose?: 'read' | 'link' },
): Promise<{ status: number; body: Json; text: string }> {
  const base = `/api/companies/${companyId}/me/google/drive/pick-tickets`
  const started = await call({ user, method: 'POST', path: base, body: { mode: pick.mode, ...(pick.purpose ? { purpose: pick.purpose } : {}) } })
  if (started.status !== 200) return started
  const { ticket, ticketId } = started.body.data
  try {
    const cfg = await call({ method: 'POST', path: '/api/google-picker/config', body: { ticket } })
    if (cfg.status !== 200) return cfg
    const result = await call({ method: 'POST', path: '/api/google-picker/result', body: { ticket, mode: pick.mode, action: 'picked', ids: pick.ids } })
    if (result.status !== 200) return result
    const state = await call({ user, method: 'GET', path: `${base}/${ticketId}` })
    if (state.status !== 200 || state.body.data.state !== 'picked') return { ...state, status: state.status === 200 ? 500 : state.status }
    const data = { picks: state.body.data.picks, refused: state.body.data.refused }
    return { status: 200, body: { success: true, data }, text: JSON.stringify({ success: true, data }) }
  } finally {
    await call({ user, method: 'DELETE', path: `${base}/${ticketId}` })
  }
}

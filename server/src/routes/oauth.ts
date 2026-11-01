/**
 * Where Google sends the member's browser back after 「Google で許可」
 * (milestone 4 G3, `.claude/rules/google-connector.md`), mounted at /api/oauth:
 *
 *   GET /google/callback?code&state[&error]   public: no ACB session (it is the browser, not the app)
 *
 * The company comes from the state (`<companyId>.<random>`), and the start is
 * looked for only inside that company (services/google-connector.ts
 * `callback`). The answer is a small Japanese page — one sentence, no secret,
 * nobody's email — and the request log never prints the query (the code and
 * the state). The app learns the result by asking GET …/me/google.
 */
import { Hono } from 'hono'
import { services } from '../composition'

export const oauthRoute = new Hono()

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

function page(granted: boolean, message: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>AI Company Builder</title>
<style>body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;background:#f7f7f5;color:#222;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
main{background:#fff;border-radius:12px;padding:32px 28px;max-width:480px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{line-height:1.7;margin:0}</style></head>
<body><main><h1>${granted ? 'Google の許可' : 'Google の許可（保存していません）'}</h1><p>${escapeHtml(message)}</p></main></body></html>`
}

oauthRoute.get('/google/callback', async (c) => {
  const result = await services.googleConnector.callback({
    state: c.req.query('state'),
    code: c.req.query('code'),
    error: c.req.query('error'),
  })
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  return c.html(page(result.granted, result.message), result.granted ? 200 : 400)
})

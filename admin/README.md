# AI Company Builder — admin console

The Next.js console where owners and admins manage companies, members, departments, folder
permissions, private folders and the AI settings. Every call goes to the API server
(`server/`); `/api/*` is forwarded by `src/proxy.ts` to `API_PROXY_URL`
(default `http://localhost:3001`).

## Develop

From the repository root (pnpm only):

```bash
pnpm install
pnpm dev:server   # API on http://localhost:3001
pnpm dev:admin    # console on http://localhost:3100, hot reload
```

```bash
cd admin
npx vitest run    # tests (seconds)
pnpm typecheck
```

## Production

`admin/Dockerfile` builds a standalone `next build` (no dev server in the image), served on port
3100; `docker compose up -d` at the repository root runs it with the API. Self-hosting:
`docs/self-hosting/`.

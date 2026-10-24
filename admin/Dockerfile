# Build context is the repo root — see docker-compose.yml.
#
# Production image: `next build` with standalone output, served by Node with
# no dev server, no source and no dev dependencies. The admin is
# internet-facing behind Caddy, so it must not run `next dev` (verbose error
# overlays, on-demand compilation, a much larger attack surface).
#
# For hot reload, run `pnpm dev:admin` on the host (README "Develop"), or build
# the `dev` stage: docker build --target dev -f admin/Dockerfile .

# ---------------------------------------------------------------------------
# deps: install the admin's dependencies from the committed lockfile
# ---------------------------------------------------------------------------
FROM node:20-slim AS deps

WORKDIR /app

# pnpm 9 on purpose, exactly like CI (.github/actions/setup/action.yml):
# pnpm-lock.yaml is written by pnpm 9. An unpinned `npm install -g pnpm`
# pulls pnpm 10+, which also reads patchedDependencies from
# pnpm-workspace.yaml and fails (ERR_PNPM_PATCH_NOT_FOUND / outdated lockfile).
RUN npm install -g pnpm@9.15.9

# patches/ is referenced by patchedDependencies and must exist at install time.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY admin/package.json ./admin/

# Install exactly the versions in the committed lockfile. The pnpm store is
# only needed during install; dropping it in the same layer keeps ~0.5GB of
# duplicate package files out of the image.
RUN pnpm install --frozen-lockfile --filter @ai-company-builder/admin... \
    && rm -rf "$(pnpm store path)"

# ---------------------------------------------------------------------------
# dev: `next dev` with the source baked in (opt-in via --target dev)
# ---------------------------------------------------------------------------
FROM deps AS dev
COPY shared ./shared
COPY admin ./admin
WORKDIR /app/admin
EXPOSE 3100
CMD ["pnpm", "dev"]

# ---------------------------------------------------------------------------
# build: compile the production bundle
# ---------------------------------------------------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
# The admin imports the shared rules (shared/core: folder names, path
# comparisons) by relative path; they are compiled into the bundle, so only
# the build needs them — the runtime image stays the standalone server.
COPY shared ./shared
COPY admin ./admin
WORKDIR /app/admin
RUN pnpm build

# ---------------------------------------------------------------------------
# runtime (default target): the standalone server only
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# .next/standalone mirrors the workspace layout (admin/server.js plus the
# traced node_modules); static assets and public/ are not part of it.
COPY --from=build --chown=node:node /app/admin/.next/standalone ./
COPY --from=build --chown=node:node /app/admin/.next/static ./admin/.next/static
COPY --from=build --chown=node:node /app/admin/public ./admin/public

USER node
EXPOSE 3100

# API_PROXY_URL (where /api/* is forwarded when no reverse proxy sits in
# front) is read per request by src/proxy.ts, so it is set at `docker run` /
# compose time, not baked in here.
CMD ["node", "admin/server.js"]

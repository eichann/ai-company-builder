# Build context is the repo root — see docker-compose.yml.
#
# Dependencies come from the committed pnpm-lock.yaml (--frozen-lockfile), so
# the image runs exactly the versions CI tested. The previous single-stage
# image ran `npm install` against server/package.json alone — no lockfile —
# and floated to whatever the semver ranges resolved to on build day.

# ---------------------------------------------------------------------------
# deps: install the server's dependencies from the lockfile
# ---------------------------------------------------------------------------
FROM node:20-slim AS deps

# Toolchain for better-sqlite3 in case no prebuilt binary matches (it normally
# downloads one; node-gyp compiling from source is the fallback). Build stage
# only — none of it reaches the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pnpm 9 on purpose, exactly like CI (.github/actions/setup/action.yml):
# pnpm-lock.yaml is written by pnpm 9. pnpm 10+ also reads patchedDependencies
# from pnpm-workspace.yaml and refuses the frozen install.
RUN npm install -g pnpm@9.15.9

# Lay the workspace out under /app — the same directory the runtime stage
# uses — so the root node_modules built here is exactly the /app/node_modules
# that /app/src resolves packages from at runtime.
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY server/package.json ./server/

# --filter installs only the server's part of the lockfile (no Electron,
# client or admin-only packages). Dev dependencies are included on purpose:
# the server runs from TypeScript through tsx (CMD below), a devDependency.
#
# pnpm's default layout puts the server's own dependencies in
# server/node_modules, which the runtime layout (/app/src, not
# /app/server/src) never sees. shamefully-hoist links every installed package
# into /app/node_modules as well (symlinks into /app/node_modules/.pnpm, so
# copying that one directory carries everything).
#
# Hoisting keeps one version per name, so the loop then fails the build if
# any direct dependency of the server resolves differently from /app than
# from /app/server — i.e. if the runtime would load a version other than the
# one the lockfile assigns to the server.
RUN pnpm install --frozen-lockfile \
      --filter @ai-company-builder/server \
      --config.shamefully-hoist=true \
    && for dep in $(node -p "const p=require('./server/package.json'); Object.keys({...p.dependencies, ...p.devDependencies}).join(' ')"); do \
         a=$(readlink -f "node_modules/$dep"); b=$(readlink -f "server/node_modules/$dep"); \
         if [ -z "$a" ] || [ "$a" != "$b" ]; then \
           echo "hoisted $dep ($a) differs from the server's ($b)" >&2; exit 1; \
         fi; \
       done \
    && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()" \
    && test -x node_modules/.bin/tsx

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:20-slim

WORKDIR /app

# git: the server hosts the company repositories (smart HTTP + pre-receive hook)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global user.email "system@ai-company-builder" \
    && git config --global user.name "AI Company Builder" \
    && git config --global safe.directory '*' \
    && git config --global init.defaultBranch main

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json server/tsconfig.json ./
# The code the server runs is the code baked in here: compose mounts only
# ./data, so a change on the host's server/src or shared/ does nothing until
# the image is rebuilt (`docker compose up -d --build api`). Whoever can write
# the checkout cannot change what the running server — which will hold the
# members' API keys — executes on its next request.
COPY server/src ./src
# The server imports ../../shared (types and the shared rules, shared/core).
COPY shared ./shared

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 3001

# Run the TypeScript sources through tsx's loader, once — no watch, no npx.
# Still TypeScript at run time on purpose: the pre-receive hook runs
# src/lib/push-check/entry.ts with this node and tsx loader
# (lib/git-server/hook.ts). One process, so `docker stop` signals the server.
CMD ["node", "--import", "tsx", "src/index.ts"]

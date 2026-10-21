FROM node:20-slim

WORKDIR /app

# pnpm 9 on purpose, exactly like CI (.github/actions/setup/action.yml):
# pnpm-lock.yaml is written by pnpm 9. An unpinned `npm install -g pnpm`
# pulls pnpm 10+, which also reads patchedDependencies from
# pnpm-workspace.yaml and fails (ERR_PNPM_PATCH_NOT_FOUND / outdated lockfile).
RUN npm install -g pnpm@9.15.9

# Copy workspace files (build context is the repo root — see docker-compose.yml).
# patches/ is referenced by patchedDependencies and must exist at install time.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY admin/package.json ./admin/

# Install exactly the versions in the committed lockfile. The pnpm store is
# only needed during install; dropping it in the same layer keeps ~0.5GB of
# duplicate package files out of the image.
RUN pnpm install --frozen-lockfile --filter @ai-company-builder/admin... \
    && rm -rf "$(pnpm store path)"

# Copy source code
COPY admin ./admin

WORKDIR /app/admin

# Expose port
EXPOSE 3100

# Start the dev server
CMD ["pnpm", "dev"]

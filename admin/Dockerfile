FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY admin/package.json ./admin/

# Install dependencies
RUN pnpm install --filter @ai-company-builder/admin...

# Copy source code
COPY admin ./admin

WORKDIR /app/admin

# Expose port
EXPOSE 3100

# Start the dev server
CMD ["pnpm", "dev"]

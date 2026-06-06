FROM node:20-slim

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global user.email "system@ai-company-builder" \
    && git config --global user.name "AI Company Builder" \
    && git config --global safe.directory '*' \
    && git config --global init.defaultBranch main

# Copy package files (build context is the repo root — see docker-compose.yml)
COPY server/package.json ./

# Install dependencies using npm (allows build scripts by default)
RUN npm install

# Copy source code
COPY server/src ./src
COPY server/tsconfig.json ./

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 3001

# Start the server with npx tsx
CMD ["npx", "tsx", "watch", "src/index.ts"]

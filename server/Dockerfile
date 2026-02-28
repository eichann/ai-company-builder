FROM node:20-slim

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json ./

# Install dependencies using npm (allows build scripts by default)
RUN npm install

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p data

# Expose port
EXPOSE 3001

# Start the server with npx tsx
CMD ["npx", "tsx", "watch", "src/index.ts"]

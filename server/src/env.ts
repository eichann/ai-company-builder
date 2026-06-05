import { config as loadEnv } from 'dotenv'

// Load .env for the non-Docker dev path (`pnpm dev:server`). Looks in the
// server dir first, then the repo root (first file found wins per key).
// Real environment variables always take precedence — in Docker the compose
// `environment:` injection is used and these files simply don't exist.
loadEnv({ path: ['.env', '../.env'] })

# CLAUDE.md - AI Company Builder

This file provides project-specific guidance for Claude Code.

---

## Project Structure

```
ai-company-builder/
├── server/     # Hono API (port 3001)
├── admin/      # Next.js admin panel (port 3100)
├── client/     # Electron desktop app (port 5173)
├── shared/     # Shared type definitions
└── data/       # SQLite databases (gitignored)
```

---

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+

### Quick Start

```bash
# Install dependencies
pnpm install

# Start the server (development)
cd server && pnpm dev

# Start the client (development)
cd client && pnpm dev

# Start the admin panel (development)
cd admin && pnpm dev
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `AUTH_SECRET` — Secret key for session signing (generate with `openssl rand -base64 32`)
- `PUBLIC_URL` — Public URL of the server (e.g., `https://your-domain.com`)

---

## Deployment

See `docs/self-hosting/` for full self-hosting guides (English and Japanese).

### Docker Compose

```bash
docker compose up -d
```

### Docker Volume Mounts

The docker-compose.yml mounts the following:
- `./server/src:/app/src`
- `./shared:/app/shared`
- `./data:/app/data`
- `./admin/src:/app/admin/src`

When adding new directories, update docker-compose.yml accordingly.

---

## Technical Notes

### Import Paths

Server references shared types via:
```typescript
import { ... } from '../../shared/types'  // Path inside container
```

### Database

- SQLite (`data/app.sqlite` for app, `data/auth.sqlite` for auth)
- Migrations use `CREATE TABLE IF NOT EXISTS` (auto-applied)

### File Naming Rules

- Folder/file names must be ASCII only (no CJK characters)
- Pattern: `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`

---

## API Endpoints

```
GET    /api/companies/:companyId/departments       # List departments
POST   /api/companies/:companyId/departments       # Create department
PUT    /api/companies/:companyId/departments/:id   # Update department
DELETE /api/companies/:companyId/departments/:id   # Delete department
POST   /api/companies/:companyId/departments/reorder    # Reorder
```

---

## Architecture: Department Management

### Principles

```
File system = Source of Truth
DB = Display settings (order, icon, color, display name)
Admin UI = Can also perform file operations
```

### Data Flow

1. **List departments**: Read folders from filesystem, merge DB settings
2. **Create department**: mkdir → git add → save to DB
3. **Edit department**: git mv (if renamed) → update DB
4. **Delete department**: Confirm → rm -rf + git rm -r → delete from DB

---

## Architecture: Client Sync (git:sync)

### Value Proposition

Uses Git behind the scenes so non-engineers can **share files, folders, and AI skills across the entire team instantly**.

Users only need to remember **one rule**:

> **"When you've made changes you want to share, press the sync button."**

### Sync Flow

```
1. git fetch origin
2. Department folder protection check
3. git add . → git commit → record localHash
4. git pull --rebase origin main
   ├─ Success → git push → done
   └─ Conflict:
      a. Backup local version of conflicted files
      b. git checkout --ours (adopt server version)
      c. git add → git rebase --continue
      d. git push → done
```

### Conflict Resolution Strategy

- Server version wins for conflicted files
- Local version is automatically backed up to `.backups/`
- Non-conflicting changes are preserved via Git's native 3-way merge
- Uses `rebase --continue` (not abort) to preserve auto-merged files

### Backup Structure

```
{company-folder}/
├── .backups/                    ← Added to .gitignore
│   └── 2026-02-21_14-30/
│       ├── sales/proposal.md    ← Local version of conflicted file
│       └── _metadata.json       ← Conflict metadata
└── .git/
```

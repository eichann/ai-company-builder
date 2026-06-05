# AI Company Builder

**Share AI skills across your team — just put files in a folder.**

**Press "Sync" — that's it.** No Git, no CLI, no merge conflicts to resolve. Your team's AI skills, files, and folders are shared instantly.

> An alternative to: Notion + Dropbox + manual AI prompt sharing

[日本語版はこちら](README.ja.md)

## What is this?

A desktop app + self-hosted server that lets teams share AI agent skills, files, and context through a simple folder-based convention. No Git knowledge required — press "Sync" and everything is shared.

**Convention over Configuration** — folder structure *is* the configuration.

### Launch custom tools from within a skill

![Skill Tools](docs/images/skill-tools.png)

### Edit SKILL.md and manage files in a built-in editor

![Skill Editor](docs/images/skill-editor.png)

### Create new skills from GUI — no terminal needed

![Skill Create](docs/images/skill-create.png)

## Features

- **Skill Sharing** — Drop AI skill files into a department folder; your whole team gets them instantly
- **Zero-Config Sync** — One-button sync powered by Git (users never see Git)
- **Self-Hosted** — Your data stays on your server. No third-party dependencies
- **Bundled Git** — Works even if Git is not installed on the user's machine
- **Department Management** — Organize skills and files by team/department
- **Personal Workspace** — `.personal/` folders are never synced, giving each user a private space
- **HTTPS Git Transport** — No SSH keys to manage; authentication piggybacks on web login
- **Conflict Resolution** — Server wins, local changes are auto-backed up

## Architecture

```
┌─────────────────┐         HTTPS          ┌─────────────────┐
│  Desktop App    │◄──────────────────────►│  Self-Hosted     │
│  (Electron)     │    Git Smart HTTP      │  Server (Hono)   │
│                 │    + REST API           │                 │
│  - File browser │                        │  - Git bare repos│
│  - AI chat      │                        │  - SQLite DB     │
│  - Skill runner │                        │  - Auth (Better  │
│  - Sync button  │                        │    Auth)         │
└─────────────────┘                        └─────────────────┘
```

![System Overview](docs/images/system-overview.png)

## Quick Start

```bash
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
```

### 1. Run it locally

For when you want to see the whole product working — API server, admin panel, and data — before touching any code. Docker is all you need; no other setup required.

```bash
cp .env.example .env
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

This starts two containers: the API server (http://localhost:3001) and the admin panel (http://localhost:3100). Open http://localhost:3100 in your browser, sign up (this becomes the first account), and create a company — the full server-side experience now runs on your machine.

To also try the desktop client (Electron), keep the server running and run the following from the repository root (requires Node.js 20+ and pnpm 9+):

```bash
pnpm install   # first time only
pnpm dev       # launches the client
```

On first launch the client asks for a server URL — enter `http://localhost:3001`.

### 2. Develop

For when you want to change the code. Each process runs directly with hot reload, so edits are reflected immediately. Requires Node.js 20+ and pnpm 9+.

```bash
pnpm install
cp .env.example .env
echo "AUTH_SECRET=$(openssl rand -base64 32)" >> .env

# Terminal 1: API server (http://localhost:3001)
pnpm dev:server

# Terminal 2: admin panel (http://localhost:3100)
pnpm dev:admin

# Terminal 3: desktop client (Electron)
pnpm dev
```

> **Note**: Use 1 *or* 2, not both at once — they bind the same ports (3001/3100). They also store data in different places (`./data` for Docker, `server/data` for `pnpm dev:server`), so accounts created in one are not visible in the other.

### 3. Self-host in production

For when you want to run AI Company Builder for your team on a real server, with your own domain and HTTPS. See the self-hosting guide:

- [English](docs/self-hosting/README.md)
- [日本語](docs/self-hosting/README.ja.md)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop App | Electron + React + Vite |
| Server | Hono (Node.js) |
| Database | SQLite (better-sqlite3) |
| Auth | Better Auth |
| Git | dugite (bundled) + Git Smart HTTP |
| Admin Panel | Next.js |
| Package Manager | pnpm (monorepo) |

## Project Structure

```
ai-company-builder/
├── client/     # Electron desktop app
├── server/     # Hono API server
├── admin/      # Next.js admin panel
├── shared/     # Shared TypeScript types
└── docs/       # Documentation
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[AGPL-3.0](LICENSE)

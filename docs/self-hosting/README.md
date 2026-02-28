# Self-Hosting Guide

> **Language**: [日本語版はこちら](./README.ja.md)

This guide walks you through deploying AI Company Builder on your own server. By the end, you will have a fully working instance with HTTPS, user authentication, Git-based file sync, and an admin panel.

**Estimated time**: 30–60 minutes (assuming a fresh Ubuntu server).

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Quick Start (5 Steps)](#quick-start-5-steps)
- [Detailed Setup Guide](#detailed-setup-guide)
  - [Step 1: Prepare the Server](#step-1-prepare-the-server)
  - [Step 2: Deploy the Application](#step-2-deploy-the-application)
  - [Step 3: Set Up the Reverse Proxy (Caddy)](#step-3-set-up-the-reverse-proxy-caddy)
  - [Step 4: Connect the Electron Client](#step-4-connect-the-electron-client)
  - [Step 5: Create Your First Company](#step-5-create-your-first-company)
- [Configuration Reference](#configuration-reference)
- [Security Hardening](#security-hardening)
- [Backup & Restore](#backup--restore)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
Internet
  │
  └── :443 → Caddy (automatic HTTPS via Let's Encrypt)
              ├── /api/*          → Docker: Hono API     (localhost:3001)
              ├── /api/git-http/* → Docker: Hono API     (Git Smart HTTP)
              └── /*              → Docker: Next.js Admin (localhost:3100)

Data:
  ./data/
  ├── app.sqlite       ← Application database (companies, members, departments)
  ├── auth.sqlite      ← Authentication database (users, sessions)
  ├── repos/           ← Git bare repositories (one per company)
  └── workdirs/        ← Git working directories
```

**How it works**: The Electron desktop app connects to your server entirely over **HTTPS**:
1. **REST API** — for authentication, company management, and API calls
2. **Git Smart HTTP** — for Git push/pull (file synchronization via `git http-backend`)

No SSH is required for Git operations. Users authenticate with their web login credentials — the session token is automatically passed to Git via `GIT_ASKPASS`.

Caddy handles TLS termination and routes HTTP traffic to the appropriate Docker container. Docker ports are bound to `127.0.0.1` only, so they are never directly exposed to the internet.

---

## Prerequisites

| Requirement | Minimum | Recommended | Why |
|-------------|---------|-------------|-----|
| **OS** | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 LTS | Tested and supported |
| **CPU** | 2 cores | 4 cores | Docker build + Next.js SSR |
| **RAM** | 2 GB | 4 GB | Docker + Node.js + SQLite |
| **Disk** | 20 GB | 50 GB+ | Git repos grow over time |
| **Domain** | Required | — | Caddy needs a domain for automatic HTTPS |
| **Ports** | 80, 443 | — | HTTP (redirect), HTTPS |

**Software that will be installed during setup:**
- Docker Engine 24+ and Docker Compose v2
- Caddy 2.x (web server / reverse proxy)

> **Note**: A static public IP address is required. Dynamic DNS may work but is not tested.

---

## Quick Start (5 Steps)

For experienced users who want to get running fast. Each step links to the detailed section below.

```bash
# 1. SSH into your server and create a deploy user
ssh root@your-server-ip
useradd -m -s /bin/bash -G sudo deploy
# ... (see Step 1 for full setup)

# 2. Clone the repo and configure
su - deploy
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
cp docs/self-hosting/.env.example .env
sed -i "s|AUTH_SECRET=|AUTH_SECRET=$(openssl rand -hex 32)|" .env
# Edit .env with your domain

# 3. Build and start
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build

# 4. Set up Caddy for HTTPS
sudo apt install -y caddy
# Configure /etc/caddy/Caddyfile (see Step 3)
sudo systemctl reload caddy

# 5. Verify
curl https://your-domain.com/api/me
# Expected: {"error":"Unauthorized"}  ← This means the API is running!
```

---

## Detailed Setup Guide

### Step 1: Prepare the Server

#### 1.1 System Update

```bash
ssh root@your-server-ip
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
```

#### 1.2 Create a Deploy User

Create a dedicated user to run the application. Never run Docker containers as root.

```bash
# Create user with sudo access
useradd -m -s /bin/bash -G sudo deploy

# Set up SSH key authentication (copy your public key)
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Allow passwordless sudo (needed for Docker setup)
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
```

Verify you can SSH in as `deploy`:

```bash
# From your local machine
ssh deploy@your-server-ip
```

#### 1.3 Harden SSH

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

> **What this does**: Disables root login and password-based authentication. Only SSH key authentication is allowed for server administration.

#### 1.4 Configure the Firewall

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH (server administration only)
sudo ufw allow 80/tcp    # HTTP (Caddy redirect to HTTPS)
sudo ufw allow 443/tcp   # HTTPS (Caddy)
sudo ufw --force enable
```

> **Why port 22?** SSH is only used for server administration (not for Git). Git sync is entirely over HTTPS (port 443).

#### 1.5 Install Docker

```bash
# Install Docker using the official convenience script
curl -fsSL https://get.docker.com | sudo sh

# Add deploy user to docker group (avoids needing sudo for docker commands)
sudo usermod -aG docker deploy

# Apply group change (log out and back in, or run:)
newgrp docker
```

Verify:

```bash
docker --version
docker compose version
```

---

### Step 2: Deploy the Application

#### 2.1 Get the Source Code

```bash
# As the deploy user
cd ~
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
```

#### 2.2 Configure Environment Variables

```bash
# Copy the example environment file
cp docs/self-hosting/.env.example .env

# Generate a secure AUTH_SECRET (this signs user sessions)
sed -i "s|AUTH_SECRET=|AUTH_SECRET=$(openssl rand -hex 32)|" .env
```

Now edit `.env` with your values:

```bash
nano .env
```

Required changes:

```ini
# Your domain with https://
PUBLIC_URL=https://your-domain.com

# Environment mode (enables secure cookies)
NODE_ENV=production
```

> **AUTH_SECRET** is critical. If you change it after users have logged in, all existing sessions will be invalidated. Keep it safe.

#### 2.3 Create the Data Directory

```bash
mkdir -p data/repos data/workdirs
```

#### 2.4 Build and Start

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build
```

This will take 2–5 minutes on first run (downloading base images and installing dependencies).

Verify:

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml ps
```

Test the API internally:

```bash
curl http://127.0.0.1:3001/api/me
```

Expected output: `{"error":"Unauthorized"}` — this confirms the API is running correctly.

---

### Step 3: Set Up the Reverse Proxy (Caddy)

Caddy serves two purposes:
1. **Automatic HTTPS** — obtains and renews Let's Encrypt certificates with zero configuration
2. **Reverse proxy** — routes `/api/*` to the API server and everything else to the admin panel

#### 3.1 Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

#### 3.2 Configure Caddy

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
your-domain.com {
    handle /api/* {
        reverse_proxy localhost:3001
    }

    handle {
        reverse_proxy localhost:3100
    }
}
EOF
```

Replace `your-domain.com` with your actual domain.

#### 3.3 Point Your Domain to the Server

Before reloading Caddy, make sure your domain's DNS A record points to your server's IP:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | your-server-ip | 3600 |

#### 3.4 Start Caddy

```bash
sudo systemctl reload caddy
```

Caddy will automatically obtain a TLS certificate, set up HTTPS redirects, and renew certificates before they expire.

Verify:

```bash
curl -sI https://your-domain.com/api/me 2>&1 | head -5
```

Expected: `HTTP/2 401` — the API is running behind HTTPS.

> **Troubleshooting**: If the certificate fails, check: (1) DNS A record is correct, (2) ports 80 and 443 are open, (3) `sudo journalctl -u caddy --since '5 min ago'` for details.

---

### Step 4: Connect the Electron Client

1. Download the Electron app (or build from source: `cd client && pnpm install && pnpm build && npx electron-builder --mac`)
2. Launch the app
3. On first launch, enter your server URL: `https://your-domain.com`
4. Sign up to create the first admin account
5. The app handles Git authentication automatically — no SSH keys or tokens to configure

> **How Git auth works**: The app uses your web login session to authenticate Git operations. When you press "Sync", the app passes your session token to Git via `GIT_ASKPASS`. No additional setup is needed.

---

### Step 5: Create Your First Company

1. Log in to the admin panel at `https://your-domain.com`
2. Click **Create Company** — this will:
   - Create a company record in the database
   - Initialize a bare Git repository
   - Create default departments
3. Go to the company detail page and click **Create Invitation Link**
4. Share the invitation link with your team members

When team members open the invitation link, they can register a new account and join the company.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_SECRET` | **Yes** | — | Session signing key. Generate with `openssl rand -hex 32`. |
| `PUBLIC_URL` | **Yes** | — | Your full domain URL (e.g., `https://example.com`). Used for CORS, cookies, and admin panel. |
| `NODE_ENV` | **Yes** | `development` | Set to `production` for secure cookies and HTTPS. |
| `PORT` | No | `3001` | API server port. |
| `DATA_DIR` | No | `./data` | Directory for SQLite databases. |
| `REPOS_DIR` | No | `${DATA_DIR}/repos` | Directory for Git bare repositories. |

### Ports

| Port | Service | Binding | Purpose |
|------|---------|---------|---------|
| 22 | SSH | Public | Server administration only |
| 80 | Caddy | Public | HTTP → HTTPS redirect |
| 443 | Caddy | Public | HTTPS (API + Git Smart HTTP + Admin panel) |
| 3001 | API (Hono) | 127.0.0.1 only | REST API + Git HTTP backend |
| 3100 | Admin (Next.js) | 127.0.0.1 only | Web admin panel |

### Databases

Both databases are SQLite files created automatically on first startup. No manual migration is needed.

| File | Purpose |
|------|---------|
| `data/app.sqlite` | Application data (companies, memberships, departments, invitations) |
| `data/auth.sqlite` | Authentication (users, sessions — managed by Better Auth) |

---

## Security Hardening

### Checklist

- [ ] SSH: Root login disabled, password authentication disabled
- [ ] Firewall: Only ports 22, 80, 443 open
- [ ] Docker: Ports bound to `127.0.0.1` (not `0.0.0.0`)
- [ ] Caddy: HTTPS with automatic certificate renewal
- [ ] `AUTH_SECRET`: Unique, randomly generated, at least 32 characters
- [ ] `NODE_ENV=production`: Enables secure cookies

### Optional but Recommended

**fail2ban** — Protects against SSH brute-force attacks:

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

**Automatic security updates**:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## Backup & Restore

### What to Back Up

| Item | Path | Criticality |
|------|------|-------------|
| Application database | `data/app.sqlite` | **Critical** |
| Authentication database | `data/auth.sqlite` | **Critical** |
| Git repositories | `data/repos/` | **Critical** |
| Environment file | `.env` | **Critical** |
| Working directories | `data/workdirs/` | Low — can be regenerated |

### Backup Script

```bash
#!/bin/bash
# backup.sh - Run daily via cron
BACKUP_DIR="/home/deploy/backups/$(date +%Y-%m-%d_%H%M%S)"
DATA_DIR="/home/deploy/ai-company-builder/data"

mkdir -p "$BACKUP_DIR"

# SQLite: Use .backup command for consistency (handles WAL mode correctly)
sqlite3 "$DATA_DIR/app.sqlite" ".backup '$BACKUP_DIR/app.sqlite'"
sqlite3 "$DATA_DIR/auth.sqlite" ".backup '$BACKUP_DIR/auth.sqlite'"

# Git repositories
cp -r "$DATA_DIR/repos" "$BACKUP_DIR/repos"

# Environment
cp /home/deploy/ai-company-builder/.env "$BACKUP_DIR/.env"

# Clean up backups older than 30 days
find /home/deploy/backups -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

echo "Backup completed: $BACKUP_DIR"
```

> **Important**: Do not use `cp` for SQLite files while the server is running. Always use `sqlite3 ... ".backup"` for reliable backups.

Set up automated daily backups:

```bash
chmod +x backup.sh
crontab -e
# Add: 0 3 * * * /home/deploy/ai-company-builder/backup.sh >> /home/deploy/backups/backup.log 2>&1
```

### Restore

```bash
cd ~/ai-company-builder
docker compose -f docs/self-hosting/docker-compose.production.yml down
cp /path/to/backup/app.sqlite data/app.sqlite
cp /path/to/backup/auth.sqlite data/auth.sqlite
cp -r /path/to/backup/repos data/repos
docker compose -f docs/self-hosting/docker-compose.production.yml up -d
```

---

## Updating

```bash
cd ~/ai-company-builder
git pull origin main
./backup.sh
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build
curl -s https://your-domain.com/api/me
# Expected: {"error":"Unauthorized"}
```

Database migrations run automatically on startup (`CREATE TABLE IF NOT EXISTS`).

---

## Troubleshooting

### "Invalid origin" error when logging in

Make sure `PUBLIC_URL` in your `.env` matches the exact domain you're accessing (including `https://`). After changing, restart the API container.

### Caddy fails to obtain SSL certificate

1. **DNS not propagated**: `dig +short your-domain.com A` should return your server IP
2. **Ports blocked**: Ensure ports 80 and 443 are open in your firewall and cloud provider security group
3. **Check Caddy logs**: `sudo journalctl -u caddy --since '10 min ago' --no-pager`

### Docker containers keep restarting

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml logs --tail=50 api
```

Common causes:
- Missing `AUTH_SECRET` in `.env`
- Data directory permissions (`chown -R deploy:deploy data/`)
- Port already in use

### Git sync fails from Electron client

Git sync uses HTTPS with session token authentication. Common issues:

1. **Session expired**: Log out and log back in to refresh the session
2. **CORS error**: Check `PUBLIC_URL` matches your domain exactly
3. **Certificate issue**: Ensure Caddy is running and HTTPS is working

### "useSecureCookies" error

If you previously ran the server over HTTP and switched to HTTPS, clear your browser cookies for the domain. Ensure `NODE_ENV=production` is set in your `.env`.

---

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/eichann/ai-company-builder/issues)
- **Discussions**: [GitHub Discussions](https://github.com/eichann/ai-company-builder/discussions)

When reporting an issue, please include:
1. Your OS and Docker version
2. Relevant container logs (`docker compose logs --tail=50 api`)
3. Steps to reproduce the problem

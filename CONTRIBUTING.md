# Contributing to AI Company Builder

Thank you for your interest in contributing! This guide will help you get started.

[日本語版](#日本語)

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose (for running the full stack)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder

# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env and set AUTH_SECRET (generate with: openssl rand -base64 32)
```

### Running in Development

```bash
# Terminal 1: Start the API server
pnpm dev:server

# Terminal 2: Start the Electron client
pnpm dev

# Optional — Start the admin panel
cd admin && pnpm dev
```

### Running with Docker

```bash
docker compose up -d
```

## Project Structure

| Directory | Description | Port |
|-----------|-------------|------|
| `client/` | Electron desktop app | 5173 |
| `server/` | Hono API server | 3001 |
| `admin/` | Next.js admin panel | 3100 |
| `shared/` | Shared TypeScript types | — |

## How to Contribute

### Reporting Bugs

- Open a [GitHub Issue](https://github.com/eichann/ai-company-builder/issues)
- Include steps to reproduce, expected behavior, and actual behavior
- Include your OS, Node.js version, and pnpm version

### Suggesting Features

- Open a [GitHub Issue](https://github.com/eichann/ai-company-builder/issues) with the "feature request" label
- Describe the use case and why the feature would be useful

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally (run both server and client)
5. Commit with a clear message
6. Push and open a Pull Request

### Commit Messages

Use clear, concise commit messages:

```
Add department folder protection on sync
Fix HTTPS auth token extraction for signed cookies
Update self-hosting guide with DNS configuration
```

## Code Style

- TypeScript for all source code
- pnpm as the package manager (do not use npm or yarn)
- No console.log in production code paths (use structured logging)

## File Naming

- ASCII only — no CJK characters in file/folder names
- Pattern: `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/`

---

## 日本語

### 開発環境のセットアップ

#### 前提条件

- Node.js 20+
- pnpm 9+
- Docker & Docker Compose（フルスタック実行時）

#### 始め方

```bash
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
pnpm install
cp .env.example .env
# .env を編集し AUTH_SECRET を設定
```

#### 開発サーバーの起動

```bash
# ターミナル 1: API サーバー
pnpm dev:server

# ターミナル 2: Electron クライアント
pnpm dev
```

### コントリビュート方法

- **バグ報告**: GitHub Issue を作成してください
- **機能提案**: GitHub Issue に「feature request」ラベルを付けて作成
- **プルリクエスト**: fork → feature branch → 変更 → PR

### コーディング規約

- TypeScript を使用
- パッケージマネージャは pnpm のみ
- ファイル名は ASCII のみ（日本語不可）

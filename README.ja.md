# AI Company Builder

**AI スキルをチームで共有 — フォルダに置くだけ。**
**AIが育つ組織を育てる。**

**「同期」を押すだけ。** Gitの知識もターミナルも不要。チームのAIスキル、ファイル、フォルダが一瞬で全員に共有されます。

> Notion + Dropbox + AIプロンプトの手動共有…の代替

[English](README.md)

## これは何？

デスクトップアプリ + セルフホストサーバーで構成される、チーム向け AI スキル共有プラットフォームです。AI エージェントのスキルファイル、ドキュメント、コンテキストを、フォルダに置くだけでチーム全員に共有できます。

Gitの知識は不要。「同期」ボタンを押すだけです。

**Convention over Configuration** — フォルダ構造がそのまま設定になります。

### スキル内のカスタムツールをワンクリックで起動

![Skill Tools](docs/images/skill-tools.png)

### 内蔵エディタで SKILL.md やファイルを編集

![Skill Editor](docs/images/skill-editor.png)

### GUI から新しいスキルを作成 — ターミナル不要

![Skill Create](docs/images/skill-create.png)

## 特徴

- **スキル共有** — 部署フォルダにスキルファイルを置くだけで、チーム全員に即座に共有
- **ワンボタン同期** — Gitは裏側で使用（ユーザーは Git を意識しない）
- **セルフホスト** — データは自社サーバーに。外部サービスへの依存なし
- **Git同梱** — Git 未インストール環境でも動作
- **部署管理** — チーム/部署ごとにスキルとファイルを整理
- **個人ワークスペース** — `.personal/` フォルダは同期されない個人用スペース
- **HTTPS Git 転送** — SSH 鍵の管理不要
- **シンプルなコンフリクト解決ルール** — サーバー版を優先、ローカルの変更は自動バックアップ

## アーキテクチャ

```
┌─────────────────┐         HTTPS          ┌─────────────────┐
│  デスクトップ     │◄──────────────────────►│  セルフホスト     │
│  アプリ          │    Git Smart HTTP      │  サーバー         │
│  (Electron)     │    + REST API           │  (Hono)         │
│                 │                        │                 │
│  - ファイル管理   │                        │  - Git bare repo│
│  - AI チャット    │                        │ - SQLite DB    │
│  - スキル実行     │                        │  - 認証          │
│  - 同期ボタン     │                        │                 │
└─────────────────┘                        └─────────────────┘
```

![システム概要](docs/images/system-overview.png)

## クイックスタート

### 前提条件

- Node.js 20+
- pnpm 9+

### 開発環境

```bash
# リポジトリをクローン
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder

# 依存関係をインストール
pnpm install

# 環境変数を設定
cp .env.example .env
# .env を編集し AUTH_SECRET を設定（生成: openssl rand -base64 32）

# サーバーを起動
pnpm dev:server

# 別のターミナルでクライアントを起動
pnpm dev
```

### セルフホスティング（本番環境）

セルフホスティングガイドを参照:

- [English](docs/self-hosting/README.md)
- [日本語](docs/self-hosting/README.ja.md)

## 技術スタック

| コンポーネント | 技術 |
|-------------|------|
| デスクトップアプリ | Electron + React + Vite |
| サーバー | Hono (Node.js) |
| データベース | SQLite (better-sqlite3) |
| 認証 | Better Auth |
| Git | dugite (同梱) + Git Smart HTTP |
| 管理画面 | Next.js |
| パッケージマネージャ | pnpm (monorepo) |

## プロジェクト構成

```
ai-company-builder/
├── client/     # Electron デスクトップアプリ
├── server/     # Hono API サーバー
├── admin/      # Next.js 管理画面
├── shared/     # 共通 TypeScript 型定義
└── docs/       # ドキュメント
```

## コントリビュート

[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## セキュリティ

[SECURITY.md](SECURITY.md) を参照してください。

## ライセンス

[AGPL-3.0](LICENSE)

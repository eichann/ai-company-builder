# セルフホスティングガイド

> **Language**: [English version](./README.md)

このガイドでは、AI Company Builder を自分のサーバーにデプロイする手順を解説します。完了すると、HTTPS対応・ユーザー認証・Gitファイル同期・管理パネルが全て動作する環境が手に入ります。

**所要時間**: 30〜60分（新規 Ubuntu サーバーの場合）

---

## 目次

- [アーキテクチャ概要](#アーキテクチャ概要)
- [前提条件](#前提条件)
- [クイックスタート（5ステップ）](#クイックスタート5ステップ)
- [詳細セットアップガイド](#詳細セットアップガイド)
  - [ステップ 1: サーバーの準備](#ステップ-1-サーバーの準備)
  - [ステップ 2: アプリケーションのデプロイ](#ステップ-2-アプリケーションのデプロイ)
  - [ステップ 3: リバースプロキシの設定（Caddy）](#ステップ-3-リバースプロキシの設定caddy)
  - [ステップ 4: Electronクライアントの接続](#ステップ-4-electronクライアントの接続)
  - [ステップ 5: 最初の会社を作成する](#ステップ-5-最初の会社を作成する)
- [設定リファレンス](#設定リファレンス)
- [セキュリティ強化](#セキュリティ強化)
- [バックアップと復元](#バックアップと復元)
- [アップデート方法](#アップデート方法)
- [トラブルシューティング](#トラブルシューティング)

---

## アーキテクチャ概要

```
インターネット
  │
  └── :443 → Caddy（Let's Encrypt で自動 HTTPS）
              ├── /api/*          → Docker: Hono API     (localhost:3001)
              ├── /api/git-http/* → Docker: Hono API     (Git Smart HTTP)
              └── /*              → Docker: Next.js Admin (localhost:3100)

データ構成:
  ./data/
  ├── app.sqlite       ← アプリDB（会社・メンバー・部署）
  ├── auth.sqlite      ← 認証DB（ユーザー・セッション）
  ├── repos/           ← Git ベアリポジトリ（会社ごとに1つ）
  └── workdirs/        ← Git 作業ディレクトリ
```

**仕組み**: Electronデスクトップアプリは、全て **HTTPS** 経由でサーバーに接続します：
1. **REST API** — 認証、会社管理、各種 API 呼び出し
2. **Git Smart HTTP** — ファイル同期（`git http-backend` 経由の Git push/pull）

Git 操作に SSH は不要です。ユーザーは Web ログインの認証情報をそのまま使用します。セッショントークンが `GIT_ASKPASS` を通じて Git に自動的に渡されます。

Caddy が TLS 終端とリバースプロキシを担当します。Docker のポートは `127.0.0.1` にのみバインドされるため、インターネットに直接公開されることはありません。

---

## 前提条件

| 要件 | 最低 | 推奨 | 理由 |
|------|------|------|------|
| **OS** | Ubuntu 22.04+ / Debian 12+ | Ubuntu 24.04 LTS | テスト済み |
| **CPU** | 2コア | 4コア | Docker ビルド + Next.js SSR |
| **RAM** | 2 GB | 4 GB | Docker + Node.js + SQLite |
| **ディスク** | 20 GB | 50 GB+ | Git リポジトリは時間とともに増加 |
| **ドメイン** | 必須 | — | Caddy の自動 HTTPS に必要 |
| **ポート** | 80, 443 | — | HTTP（リダイレクト）、HTTPS |

**セットアップ中にインストールされるソフトウェア:**
- Docker Engine 24+ および Docker Compose v2
- Caddy 2.x（Web サーバー / リバースプロキシ）

> **注意**: 固定のパブリック IP アドレスが必要です。ダイナミック DNS は未検証です。

---

## クイックスタート（5ステップ）

経験者向けの簡易手順です。各ステップの詳細は下のセクションを参照してください。

```bash
# 1. サーバーに SSH 接続し、deploy ユーザーを作成
ssh root@your-server-ip
useradd -m -s /bin/bash -G sudo deploy
# ...（ステップ 1 の詳細を参照）

# 2. リポジトリをクローンして設定
su - deploy
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
cp docs/self-hosting/.env.example .env
sed -i "s|AUTH_SECRET=|AUTH_SECRET=$(openssl rand -hex 32)|" .env
# .env をドメインに合わせて編集

# 3. ビルドと起動
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build

# 4. Caddy で HTTPS を設定
sudo apt install -y caddy
# /etc/caddy/Caddyfile を設定（ステップ 3 参照）
sudo systemctl reload caddy

# 5. 動作確認
curl https://your-domain.com/api/me
# 期待される出力: {"error":"Unauthorized"} ← API が動作しています！
```

---

## 詳細セットアップガイド

### ステップ 1: サーバーの準備

#### 1.1 システムアップデート

```bash
ssh root@your-server-ip
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
```

#### 1.2 deploy ユーザーの作成

アプリケーション実行専用のユーザーを作成します。Docker コンテナを root で実行しないでください。

```bash
# sudo 権限付きでユーザー作成
useradd -m -s /bin/bash -G sudo deploy

# SSH 鍵認証の設定（公開鍵をコピー）
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# パスワードなし sudo（Docker セットアップに必要）
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
```

deploy ユーザーで SSH 接続できることを確認：

```bash
ssh deploy@your-server-ip
```

#### 1.3 SSH の強化

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

> **補足**: root ログインとパスワード認証を無効化します。SSH 鍵認証のみ許可されます（サーバー管理用）。

#### 1.4 ファイアウォールの設定

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH（サーバー管理のみ）
sudo ufw allow 80/tcp    # HTTP（HTTPS へリダイレクト）
sudo ufw allow 443/tcp   # HTTPS（Caddy）
sudo ufw --force enable
```

> **ポート 22 について**: SSH はサーバー管理専用です。Git 同期は全て HTTPS（ポート 443）で行われます。

#### 1.5 Docker のインストール

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy
newgrp docker
```

確認：

```bash
docker --version
docker compose version
```

---

### ステップ 2: アプリケーションのデプロイ

#### 2.1 ソースコードの取得

```bash
cd ~
git clone https://github.com/eichann/ai-company-builder.git
cd ai-company-builder
```

#### 2.2 環境変数の設定

```bash
cp docs/self-hosting/.env.example .env
sed -i "s|AUTH_SECRET=|AUTH_SECRET=$(openssl rand -hex 32)|" .env
```

`.env` を編集：

```bash
nano .env
```

必須の変更：

```ini
# ドメイン（https:// 付き）
PUBLIC_URL=https://your-domain.com

# 本番モード（セキュア Cookie を有効化）
NODE_ENV=production
```

> **AUTH_SECRET** は非常に重要です。ユーザーがログインした後に変更すると、全セッションが無効化されます。安全に保管してください。

#### 2.3 データディレクトリの作成

```bash
mkdir -p data/repos data/workdirs
```

#### 2.4 ビルドと起動

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build
```

初回は 2〜5 分かかります。

確認：

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml ps
curl http://127.0.0.1:3001/api/me
```

期待される出力: `{"error":"Unauthorized"}` — API は正常に動作しています。

---

### ステップ 3: リバースプロキシの設定（Caddy）

Caddy の役割:
1. **自動 HTTPS** — Let's Encrypt 証明書の取得と更新を自動化
2. **リバースプロキシ** — `/api/*` を API サーバーに、それ以外を管理パネルにルーティング

#### 3.1 Caddy のインストール

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

#### 3.2 Caddy の設定

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

`your-domain.com` を実際のドメインに置き換えてください。

#### 3.3 DNS の設定

Caddy をリロードする前に、ドメインの A レコードがサーバーの IP を指していることを確認：

| タイプ | 名前 | 値 | TTL |
|--------|------|-----|-----|
| A | @ | your-server-ip | 3600 |

#### 3.4 Caddy の起動

```bash
sudo systemctl reload caddy
```

確認：

```bash
curl -sI https://your-domain.com/api/me 2>&1 | head -5
```

期待される出力: `HTTP/2 401` — HTTPS 経由で API が動作しています。

---

### ステップ 4: Electronクライアントの接続

1. Electron アプリをダウンロード（またはソースからビルド: `cd client && pnpm install && pnpm build && npx electron-builder --mac`）
2. アプリを起動
3. 初回起動時にサーバー URL を入力: `https://your-domain.com`
4. サインアップして最初の管理者アカウントを作成
5. Git 認証は自動的に処理されます — SSH 鍵やトークンの設定は不要

> **Git 認証の仕組み**: Web ログインのセッションを使って Git 操作を認証します。「同期」ボタンを押すと、セッショントークンが `GIT_ASKPASS` 経由で Git に渡されます。追加の設定は一切不要です。

---

### ステップ 5: 最初の会社を作成する

1. `https://your-domain.com` の管理パネルにログイン
2. **会社を作成** — 以下が自動的に行われます：
   - データベースに会社レコードを作成
   - Git ベアリポジトリを初期化
   - デフォルトの部署を作成
3. 会社の詳細ページで **招待リンクを作成**
4. チームメンバーに招待リンクを共有

---

## 設定リファレンス

### 環境変数

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `AUTH_SECRET` | **はい** | — | セッション署名キー。`openssl rand -hex 32` で生成。 |
| `PUBLIC_URL` | **はい** | — | ドメインの完全 URL（例: `https://example.com`）。CORS、Cookie、管理パネルで使用。 |
| `NODE_ENV` | **はい** | `development` | `production` でセキュア Cookie と HTTPS を有効化。 |
| `PORT` | いいえ | `3001` | API サーバーのポート。 |
| `DATA_DIR` | いいえ | `./data` | SQLite データベースのディレクトリ。 |
| `REPOS_DIR` | いいえ | `${DATA_DIR}/repos` | Git ベアリポジトリのディレクトリ。 |

### ポート

| ポート | サービス | バインド | 用途 |
|--------|---------|---------|------|
| 22 | SSH | パブリック | サーバー管理のみ |
| 80 | Caddy | パブリック | HTTP → HTTPS リダイレクト |
| 443 | Caddy | パブリック | HTTPS（API + Git Smart HTTP + 管理パネル） |
| 3001 | API (Hono) | 127.0.0.1 のみ | REST API + Git HTTP バックエンド |
| 3100 | Admin (Next.js) | 127.0.0.1 のみ | Web 管理パネル |

### データベース

両データベースは初回起動時に自動作成されます。手動マイグレーションは不要です。

| ファイル | 用途 |
|---------|------|
| `data/app.sqlite` | アプリデータ（会社・メンバー・部署・招待） |
| `data/auth.sqlite` | 認証（ユーザー・セッション — Better Auth が管理） |

---

## セキュリティ強化

### チェックリスト

- [ ] SSH: root ログイン無効、パスワード認証無効
- [ ] ファイアウォール: ポート 22, 80, 443 のみ開放
- [ ] Docker: ポートは `127.0.0.1` にバインド（`0.0.0.0` ではない）
- [ ] Caddy: 自動証明書更新付き HTTPS
- [ ] `AUTH_SECRET`: ユニーク、ランダム生成、32文字以上
- [ ] `NODE_ENV=production`: セキュア Cookie を有効化

### 推奨オプション

**fail2ban** — SSH ブルートフォース攻撃の防御:

```bash
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

**自動セキュリティアップデート**:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

---

## バックアップと復元

### バックアップ対象

| 項目 | パス | 重要度 |
|------|------|--------|
| アプリDB | `data/app.sqlite` | **最重要** |
| 認証DB | `data/auth.sqlite` | **最重要** |
| Git リポジトリ | `data/repos/` | **最重要** |
| 環境変数ファイル | `.env` | **最重要** |
| 作業ディレクトリ | `data/workdirs/` | 低（再生成可能） |

### バックアップスクリプト

```bash
#!/bin/bash
# backup.sh - cron で毎日実行
BACKUP_DIR="/home/deploy/backups/$(date +%Y-%m-%d_%H%M%S)"
DATA_DIR="/home/deploy/ai-company-builder/data"

mkdir -p "$BACKUP_DIR"

# SQLite: .backup コマンドで一貫性のあるバックアップ（WAL モード対応）
sqlite3 "$DATA_DIR/app.sqlite" ".backup '$BACKUP_DIR/app.sqlite'"
sqlite3 "$DATA_DIR/auth.sqlite" ".backup '$BACKUP_DIR/auth.sqlite'"

# Git リポジトリ
cp -r "$DATA_DIR/repos" "$BACKUP_DIR/repos"

# 環境変数
cp /home/deploy/ai-company-builder/.env "$BACKUP_DIR/.env"

# 30日以上前のバックアップを削除
find /home/deploy/backups -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

echo "バックアップ完了: $BACKUP_DIR"
```

> **重要**: サーバー稼働中の SQLite ファイルに `cp` を使わないでください。常に `sqlite3 ... ".backup"` を使用してください。

自動バックアップの設定:

```bash
chmod +x backup.sh
crontab -e
# 追加: 0 3 * * * /home/deploy/ai-company-builder/backup.sh >> /home/deploy/backups/backup.log 2>&1
```

### 復元

```bash
cd ~/ai-company-builder
docker compose -f docs/self-hosting/docker-compose.production.yml down
cp /path/to/backup/app.sqlite data/app.sqlite
cp /path/to/backup/auth.sqlite data/auth.sqlite
cp -r /path/to/backup/repos data/repos
docker compose -f docs/self-hosting/docker-compose.production.yml up -d
```

---

## アップデート方法

```bash
cd ~/ai-company-builder
git pull origin main
./backup.sh
docker compose -f docs/self-hosting/docker-compose.production.yml up -d --build
curl -s https://your-domain.com/api/me
# 期待される出力: {"error":"Unauthorized"}
```

データベースマイグレーションは起動時に自動実行されます（`CREATE TABLE IF NOT EXISTS`）。

---

## トラブルシューティング

### ログイン時に「Invalid origin」エラー

`.env` の `PUBLIC_URL` がアクセスしているドメインと完全一致しているか確認してください（`https://` を含む）。変更後は API コンテナを再起動。

### Caddy が SSL 証明書の取得に失敗する

1. **DNS 未反映**: `dig +short your-domain.com A` でサーバー IP が返ることを確認
2. **ポートがブロック**: ファイアウォールとクラウドプロバイダのセキュリティグループでポート 80, 443 が開放されているか確認
3. **Caddy ログ**: `sudo journalctl -u caddy --since '10 min ago' --no-pager`

### Docker コンテナが再起動を繰り返す

```bash
docker compose -f docs/self-hosting/docker-compose.production.yml logs --tail=50 api
```

よくある原因:
- `.env` に `AUTH_SECRET` がない
- データディレクトリの権限（`chown -R deploy:deploy data/`）
- ポートが使用中

### Electron クライアントから Git 同期が失敗する

Git 同期はセッショントークン認証付きの HTTPS を使用します。よくある問題:

1. **セッション切れ**: ログアウトして再ログインしてセッションを更新
2. **CORS エラー**: `PUBLIC_URL` がドメインと完全一致しているか確認
3. **証明書の問題**: Caddy が動作し HTTPS が有効であることを確認

### 「useSecureCookies」エラー

以前 HTTP でサーバーを動かし、その後 HTTPS に切り替えた場合、ブラウザの Cookie をクリアしてください。`.env` に `NODE_ENV=production` が設定されていることを確認。

---

## ヘルプ

- **Issues**: [GitHub Issues](https://github.com/eichann/ai-company-builder/issues)
- **Discussions**: [GitHub Discussions](https://github.com/eichann/ai-company-builder/discussions)

問題を報告する際は以下を含めてください：
1. OS と Docker のバージョン
2. 関連するコンテナログ（`docker compose logs --tail=50 api`）
3. 再現手順

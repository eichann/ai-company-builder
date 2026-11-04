# 検証キット（自分の Mac に検証環境をつくる）

本番と同じ版の AI Company Builder を、**自分の Mac の中だけ**で動かすための道具です。
本物の会社のデータ・本物の HubSpot / Google / Slack には一切つながりません。

- サーバーと管理画面（Docker の中で動きます。本番と同じ組み立て方）
- 練習用の HubSpot・Google・Slack（この Mac の中のにせもの。中身は架空の会社と人だけ）
- テスト用の会社「検証A社」（営業部・サポート部、オーナー／管理者／メンバー／営業部マネージャーのアカウント、見本のやること、練習用 HubSpot から取り込んだ案件）
- 検証用のデスクトップアプリ（普段のアプリとは設定・データが別）

`up` や `app` を実行するたびに、**本番で動いている版に自動で合わせます**（あなたが何かを pull する必要はありません）。
本番の版が変わっていたら、データを控えてから新しい版に組み立て直し、
「検証環境を本番と同じ版（11/4）に更新しました」と 1 行出します。テストのデータはそのまま残ります。

## 用意するもの

| もの | 確かめ方 |
|---|---|
| Mac（macOS 13 以降） | |
| Docker（[OrbStack](https://orbstack.dev/) か Docker Desktop）を起動しておく | `docker info` が動く |
| Node 22.12 以上 | `node -v` |
| pnpm 9 | `pnpm -v`（なければ `npm install -g pnpm@9`） |
| GitHub CLI にログイン | `gh auth login` のあと `gh auth status` |
| 社内向けの設定（オンボーディングで受け取る 1 行） | 下の「社内向けの設定」 |

### 社内向けの設定

社内のメンバー（FDE）は、オンボーディングのときに **1 行の設定**を受け取ります。
`~/.acb-staging-kit/config` というファイルを作って、受け取った行をそのまま書いてください。

```
ACB_KIT_PRIVATE=<受け取った値>
```

この設定があると、キットは本番で動いている版と、本番と同じ業務プラグイン（法人営業・HubSpot など）を
あなたの `gh` のログインで読み込みます。プラグインを読む権限がなければ、そのプラグインなしで動き、そう表示します。

設定がない場合は、公開されている最新版（main）で動き、
「追加の部品（非公開）は読み込んでいません」と表示します（業務プラグインは入りません）。

## 使い方

最初の 1 回は、このリポジトリのどこかの作業コピーから：

```bash
pnpm staging:setup
```

初回は 10〜20 分ほどかかります（キット用の作業コピー `~/acb-staging-kit/app` をつくり、組み立てます。
あなた自身の作業コピーには何も変更しません）。最後に**テスト用アカウントのパスワードを一度だけ**表示します。

そのあとは、どこからでも次のコマンドで使えます（`pnpm staging:<コマンド>` でも同じです）：

| コマンド | すること |
|---|---|
| `~/acb-staging-kit/acb-staging up` | 起動する（本番の版に合わせてから） |
| `~/acb-staging-kit/acb-staging app` | 検証用アプリを開く（サーバーが止まっていれば先に起動） |
| `~/acb-staging-kit/acb-staging down` | 止める（データは残ります） |
| `~/acb-staging-kit/acb-staging status` | いま動いているか・どの版か |
| `~/acb-staging-kit/acb-staging reset` | データをすべて消して「検証A社」を作り直す（確認があります） |
| `~/acb-staging-kit/acb-staging remove` | キットが作ったものをすべて消す（確認があります） |

- 管理画面: <http://localhost:14001/>（アプリの「サーバー」もこの URL です）
- 使う番号（ポート）: 14001（検証環境）、14010〜14012（練習用の HubSpot・Google・Slack）。
  ほかと重なるときは `ACB_STAGING_PORT=15001` のように変えられます（`ACB_STAGING_FAKE_HUBSPOT_PORT` / `_GOOGLE_PORT` / `_SLACK_PORT` も）。

## アカウントとパスワード

`~/acb-staging-kit/accounts.txt`（あなただけが読める設定のファイル）に、メール・パスワード・役割が書いてあります。

| メール | 役割 |
|---|---|
| a-owner@example.invalid | オーナー |
| a-admin@example.invalid | 管理者 |
| a-member@example.invalid | メンバー（練習用 Google・Slack ではこの人としてサインインします） |
| a-manager@example.invalid | メンバー＋営業部の部署マネージャー（法人営業の「営業の責任者」） |

パスワードはこの Mac で作った乱数で、ほかの人の検証環境とは違います。`reset` すると作り直されます。

## 検証用アプリ

```bash
~/acb-staging-kit/acb-staging app
```

- 普段のアプリとは別の設定（`~/acb-staging-kit/userdata`）で開くので、普段のアプリやデータには触れません。
- 初回はサインイン画面になります。上の表のアカウントでサインインしてください。
- 会社のフォルダの場所を聞かれたら `~/acb-staging-kit/folders` を選んでください。

## anken-sync（法人営業 × HubSpot）を試す流れ

社内向けの設定があり、法人営業と HubSpot のプラグインが読めた場合です。

1. セットアップで「検証A社」に次が入っています：練習用 HubSpot の鍵（「API キー」）、HubSpot（つなぎ先）と
   法人営業（業務）、読み替え表（HubSpot の担当者 → 検証A社の人）、練習用 HubSpot から取り込んだ案件。
   管理画面の「つなぎ先」で、HubSpot が「練習用の HubSpot につながっています」と出ていれば準備完了です。
2. 書き直した `anken-sync` の Skill を、検証用アプリで会社のフォルダの `営業部/.claude/skills/anken-sync/` に置いて同期します
   （a-owner か a-manager でサインインすると置けます）。
3. a-member（または a-manager）でサインインし、チャットで anken-sync を動かします。
   AI は法人営業の道具（`corporate-sales__…`：案件を読む・更新する・商談を記録する）だけで HubSpot に触れます。
4. 金額の変更など「先に確認」の書き込みは、チャットに**承認のカード**が出ます。
   金額は「営業の責任者」（a-manager）の承認が要ります。a-manager でサインインして承認すると、練習用 HubSpot に書き込まれます。
5. 結果は案件の画面と、管理画面の「つなぎ先」→ 法人営業の履歴・AI の動きの記録で確かめられます。
   練習用 HubSpot はキットを止めるたびに最初の中身に戻ります（`down` → `up`）。

本物の HubSpot には決して書き込みません（この環境では本物の鍵は登録できない仕組みです）。

## 練習用の Google と Slack

- **Google**: 「検証A社」に登録済みで、オンになっています。メンバーがアプリで「Google で許可」すると、
  練習用 Google が a-member としてサインインします。今日の会議（営業の商談など）が入っています。
- **Slack**: 自動では登録していません。試すときは管理画面の「つなぎ先」→「Slack」で、
  `~/acb-staging-kit/logs/fakes.log` に出ている練習用の値（`fake-slack-…`・`xoxb-fake-…`）を登録してください。

## 困ったとき

- **Docker が動いていません** → OrbStack か Docker Desktop を起動してから、もう一度。
- **ポートが使われています** → 上の「使う番号」を変えてください。
- **「本番の設定を読めませんでした」** → ネットワークか `gh auth status` を確かめてください。いまの版のまま動きます。
- **プラグインが読めない** → `gh auth status` と、プラグインを読む権限があるかを担当者に確かめてください。
- サーバーのログ: `docker compose -p acb-staging-kit logs api`、練習用サービスのログ: `~/acb-staging-kit/logs/fakes.log`、アプリのログ: `~/acb-staging-kit/logs/app.log`。
- 本番の版に更新する前のデータベースは `~/acb-staging-kit/backups/` に控えてあります。

## すべて消す

```bash
~/acb-staging-kit/acb-staging remove
```

コンテナ・組み立てたイメージ・`~/acb-staging-kit` のすべて（データ・パスワード・鍵・アプリの設定）を消します。
社内向けの設定（`~/.acb-staging-kit/config`）は残るので、要らなければ手で消してください。

---

## 運用する人へ（本番を出したあと）

本番に出したら、そのコミットを非公開のキット設定に記録します（キットの利用者が次に `up` したとき、自動でその版に合わさります）：

```bash
node staging/mark-production.mjs <本番に出したコミット>
```

場所は利用者と同じ設定（`ACB_KIT_PRIVATE` か `~/.acb-staging-kit/config`）から読み、書き込み権限のある `gh` のログインで更新します。
このリポジトリには非公開の場所を書きません。

非公開のキット設定は 1 つのテキストファイルです（`#` はコメント）：

```
production <本番で動いている main のコミット（40 文字）>
plugins-lock <同じ場所にある本番の plugins.lock のパス>     # どちらか一方：
<repo> <id>@<version> <fingerprint v2>                       # plugins.lock の行をそのまま書いてもよい
```

プラグインの行は本番が `collect-plugins.ts` で使う `plugins.lock` と同じ形式です（`.claude/rules/plugins.md`）。
本番の棚と検証キットの棚は、同じ一覧から同じ版を集めます。一覧が変わると、利用者の次の `up` で棚を集め直します。

開発中に試すとき：`ACB_STAGING_REMOTE=<ローカルの bare リポジトリ>`、`ACB_KIT_PRIVATE=file:<設定ファイルの絶対パス>`、
`ACB_STAGING_HOME=<別の場所>`、`ACB_STAGING_PROJECT=<別の名前>` で、普段のキットとぶつからずに動かせます。
キットのロジックのテスト: `cd server && npx vitest run tests/unit/staging-kit.test.ts`。

# AI Company Builder 改修計画

作成日: 2026-06-23(初版) / 2026-06-23(改訂1: 高重要度の再集計・着手前提・WP追加)
元資料: [`docs/code-review-2026-06-13.md`](./code-review-2026-06-13.md)(約90件の指摘)
前提: レビュー以降リポジトリに**コミットは**なく(HEAD=`692a40b`)、レビューの行番号・指摘はすべて現状有効。
ただし作業ツリーには未コミット変更があり、ベースブランチは main ではない(下記「着手前の前提条件」を参照)。

> **改訂1の要点**: 初版の付録Aが「高18件」を名乗りながら[中]項目の混入と[高]の取りこぼしがあったため、実集計の **[高]24件** に基づき付録Aを作り直した。あわせて高重要度なのに具体WPが無かった 1-13 / 1-12 を独立WP化し(WP-2.10 / WP-3.7)、既存不整合の是正(WP-3.8)を追加。CIのlintゲート方針と WP-3.1 の依存も修正した。

---

## この計画の方針

### 着手前の前提条件（必須・コード修正の前に確定する）

1. **作業ツリーのWIPを退避/確定する。** 現在ブランチ `feature/select-opus-46-48-with-effort`(main ではない)に未コミット変更あり: `client/electron/chat-server.ts` / `client/src/components/chat/ChatPanel.tsx` / `client/src/stores/appStore.ts`。**レビューの行番号はこのWIP込みの状態を指す**。着手前にこのWIPをコミットまたは stash し、各Phaseは main から切ったクリーンなブランチで進める(WIPの内容が本計画と衝突しないかも要確認)。
2. **`.env` 漏洩の過去分は「まず確認」。**(緊急度は現状低) 社員は現在 `claude -p`(サブスクプラン)運用で生APIキーを `.env` に入れていないため、実害は出ていない見込み。ただし断定はせず、各会社リポジトリに `.env` が既にコミット済みでないか確認する(`git ls-files '*.env'` 相当)。**万一キーが混入していた場合のみ**、`.gitignore` 追加では消えない(履歴・他クローン・サーバーリポジトリに残る)ため、`git rm --cached` + 履歴除去(`git filter-repo` 等)＋**該当鍵のローテーション**を実施する。コード側の再発防止は WP-0.1。
3. **既存本番データの不整合を把握する。** 稼働中インスタンスでは、既に「DB上にあるがリポジトリに無い部署」等の乖離(1-10起因)が生じている可能性がある。原因修正(WP-3.2)とは別に、既存不整合の棚卸し・修復(WP-3.8)が要る。

### 設計思想
1. **出血を先に止める** — 機密漏洩・クラッシュ・dev環境破壊は安全網を待たずに即修正(Phase 0)。小さく・回帰リスクが低いものに限定する。
2. **次に安全網を張る** — CI・lint・テストがない状態で大きな改修をすると壊れたことに気づけない。Phase 1 で品質ゲートを作り、以降の改修を保護する。
3. **テストとセットで直す** — Phase 2 以降の修正は「修正 + その回帰テスト」を1パッケージにする。特に同期・認可・データ整合性。
4. **大規模リファクタは最後** — Godコンポーネント分割や型一元化は価値が高いが破壊力も大きい。安全網と純粋ロジック抽出が前提になる。

### 作業単位
- **WP(Work Package)= 概ね1PRの粒度**。各WPに、含む指摘ID・目的・アプローチ・主な対象ファイル・規模・回帰リスク・検証方法・依存を記載。
- 規模: **S**(〜0.5日) / **M**(0.5〜2日) / **L**(2〜4日) / **XL**(1週間以上)。1人あたりの目安。
- 回帰リスク: **低/中/高**(既存挙動を壊す可能性)。

### 全体ボリュームの目安(1人換算)
- Phase 0(緊急): 約 **1〜2日**
- Phase 1(安全網): 約 **2〜3日**
- Phase 2(セキュリティ・認可): 約 **1週間**
- Phase 3(データ整合性): 約 **1〜1.5週間**
- Phase 4(パフォーマンス): 約 **1週間**
- Phase 5(構造改善): 約 **2〜4週間**(継続的に)
- **緊急〜重要(Phase 0〜2)で約2.5〜3週間**(client にテスト基盤ゼロの状態から Phase 2 各WPへテストを足す工数を含む。初版の「約2週間」は楽観だったため上方修正)。ここまででプロダクトの危険度は大きく下がる。

---

## 実行順序の全体像

```
Phase 0 (緊急ホットフィックス) ──┐
                                  ├─► 並行可。Phase 0 と Phase 1 は独立に着手できる
Phase 1 (安全網: CI/lint/test) ──┘
        │
        ▼
Phase 2 (セキュリティ・認可)  ← Phase 1 完了後が安全(CIで守られる)
        │
        ▼
Phase 3 (データ整合性・同期)  ← 最も慎重に。各WPはテスト必須
        │
        ├─► Phase 4 (パフォーマンス) ← Phase 3 と一部並行可
        ▼
Phase 5 (構造改善・テスタビリティ) ← 純粋ロジック抽出 → 分割の順
        │
        ▼
Phase 6 (継続改善: Electron更新ほか)
```

推奨: **Phase 0 を最優先で当日中に。Phase 1 をその週に。** 以降は Phase 2 → 3 を直列、4 は 3 と並行、5 は継続枠で。

---

# Phase 0 — 緊急ホットフィックス(当日〜2日)

> 高重要度かつ小さく・低リスク。安全網を待たずに即マージしてよいもの。

### WP-0.1 機密漏洩の遮断（.env を同期させない） 🔴最優先
- 指摘: 1-1(`.env` が同期対象でAPIキーが全社漏洩)
- **現状認識**: 社員は現在 `claude -p`(Claude Code サブスクプラン)経由でのみ利用しており、生APIキーを `.env` に入れていないため**実害(キー流出)は今のところ出ていない**見込み。ただし設定画面は依然としてキーを `{会社フォルダ}/.env` に書ける作りのため、**将来の再発防止を今のうちに入れる**。過去分の掃除は緊急ではなく“念のため確認”レベル(下記④)。
- **設計方針**: 「ユーザーは同期ボタンだけ押せばよい」という製品思想を守るため、`.gitignore` 手動設定をユーザーに要求しない。**安全な初期状態をアプリが用意し、多層で守る**。gitignore の `.env`(スラッシュ無し)は全階層に効くので、パターン自体は単純でよい。
- アプローチ(4層):
  1. **会社フォルダ作成時に seed(未来を守る)** — フォルダ作成時に生成する `.gitignore`(`main.ts:2013`, `:2628` の seed 箇所)へ最初から下記を含める:
     ```
     .env
     .env.*
     ```
     essentialPatterns(`main.ts:1993-2016`)にも `.env` / `.env.*` を追加し、既存フォルダでも同期時に補われるようにする。
  2. **キー保存時に自己修復** — `env:write`(`main.ts:936`)実行時に、対象フォルダの `.gitignore` に上記が無ければ足す(seed が無い古いフォルダ・行を消された場合の保険)。
  3. **UI 明記** — SettingsPanel(`:532-537`)の注意書きに「入力したキーを含む `.env` は**同期されません**(このPCにのみ保存)」を明示。
  4. **過去分の確認・掃除(念のため)** — 各会社リポジトリに `.env` が既にコミット済みでないか検出(`git ls-files '*.env'` 相当)。検出時のみ `git rm --cached` で追跡解除 + 該当キーのローテーション。**現状 claude -p 運用のため大半は該当なしの想定**だが、確認はしておく。
- **サーバー側の砦との連携**: 指摘 1-9(pre-receive の秘密検査が初回pushで働かないバグ)を **WP-2.6** で直すことで、クライアント側の4層をすべてすり抜けても**サーバーがキー入りpushを拒否する**最後の砦になる。WP-0.1(クライアント)と WP-2.6(サーバー)は「多層防御」として対で機能する。
- 対象: `client/electron/main.ts`(gitignore seed / essentialPatterns / env:write), `client/src/components/settings/SettingsPanel.tsx`
- 規模: S / 回帰リスク: 低
- 検証: (1)新規会社フォルダの初回 `.gitignore` に `.env` 系が入っている。(2)キー保存→同期しても `git status`/リモートに `.env` が現れない。(3)`.gitignore` の該当行を消しても env:write で復活する。(4)既存 `.env` コミットの検出・警告が出る。

### WP-0.2 編集クラッシュの修正
- 指摘: 1-11(ChatPanel の早期return後の useState = Hooks違反)
- アプローチ: `showAllFiles` の `useState`(`ChatPanel.tsx:497`)を関数先頭へ移動。
- 対象: `client/src/components/chat/ChatPanel.tsx`
- 規模: S / 回帰リスク: 低
- 検証: メッセージ編集ボタン押下でクラッシュしないこと。

### WP-0.3 テストの復旧 + 実装の真の検証
- 指摘: 4-2(path-traversalテストがレッド、かつ実装でなく自前リテラルを検証)
- アプローチ: `isValidFolderName` を `departments.ts` から export し、テストは実装を直接 import して検証。日本語許容後の境界(Windows予約名等)も追加。
- 対象: `server/src/routes/departments.ts`, `server/tests/security/path-traversal.test.ts`
- 規模: S / 回帰リスク: 低
- 検証: `cd server && npx vitest run` が全green。

### WP-0.4 dev環境の復旧(symlink)
- 指摘: 1-47(`server/shared` が開発機の絶対パスsymlink)
- アプローチ: symlink を相対(`../shared`)に張り替え、または廃止して tsconfig `paths` / pnpm workspace 参照へ。今回は最小の相対symlink化を推奨(WP-5.1で本格対応)。
- 対象: `server/shared`, `server/tsconfig.json`
- 規模: S / 回帰リスク: 低
- 検証: クリーンクローン相当(`git archive`展開)で `cd server && pnpm dev` が起動。

### WP-0.5 データ消失footgunの除去
- 指摘: 3-1の一部(旧Sidebarの単純push同期ボタンが競合解決を経ずデータ保護を壊す)
- アプローチ: **まず到達可能性を確認**(旧Sidebarが本当に描画経路外か)。到達不能なら“潜在”リスクなので、無理にPhase 0で切り出さず WP-5.5(旧UI一括削除)に統合してよい。到達可能なら本物のPhase 0バグとして同期ボタン経路を即撤去。
- 対象: `client/src/components/sidebar/Sidebar.tsx`
- 規模: S / 回帰リスク: 低(デッドコードのため)
- 検証: import 参照ゼロを確認。到達可能だった場合は撤去後にビルドが通ること。

### WP-0.6 セッション復活バグ
- 指摘: 1-14(削除したアクティブセッションが自動保存で蘇る)
- アプローチ: `deleteSession` 経由では `startNewChat` の保存をスキップ、または先に state をクリア。
- 対象: `client/src/components/chat/ChatPanel.tsx`
- 規模: S / 回帰リスク: 低
- 検証: アクティブセッション削除→履歴に残らないこと。

---

# Phase 1 — 安全網の構築(2〜3日)

> 投資対効果が最大。以降の全改修をここで守る。

### WP-1.1 ESLint 導入(client / server)
- 指摘: 3-3, 4-5
- アプローチ: flat config(`eslint.config.mjs`)+ eslint 依存を client/server に追加。`react-hooks`(exhaustive-deps)、`@typescript-eslint` を有効化。意図的なdeps省略には理由コメント付き disable を義務化。既存の admin 設定に揃える。
- 対象: `client/`, `server/` の eslint設定 + package.json、壊れた `--ext` スクリプト修正
- 規模: M / 回帰リスク: 低(コードは変えない、警告の洗い出しのみ)
- **注意**: 導入直後は本レビューのstale closure群等で**大量の指摘が出る**(exhaustive-deps 含む)。ここでの目標は「lintをゼラーにする」ことではなく、**設定を入れて指摘を可視化・棚卸しする**こと。exhaustive-deps は当面 `warn` で入れ、既存違反の解消は Phase 2〜5 のWPに割り振る。CIでの必須化は WP-1.3 の方針に従う。
- 検証: `pnpm -r lint` が最後まで走り(クラッシュしない)、本レビューのstale closure群が指摘として現れること。指摘件数のベースラインを記録する。

### WP-1.2 typecheck スクリプト整備
- 指摘: 4-6
- アプローチ: 各パッケージに `typecheck`(`tsc --noEmit`)を追加。admin は `.next` のstale対策。root に `pnpm -r typecheck`。
- 対象: 各 `package.json`, root `package.json`
- 規模: S / 回帰リスク: 低
- 検証: `pnpm -r typecheck` が完走。

### WP-1.3 CI パイプライン構築 🔴重要
- 指摘: 4-1
- アプローチ: `.github/workflows/ci.yml` を新設。corepack で pnpm 固定。**ゲートは2段階に分ける**:
  - **必須ゲート(赤で落とす)**: `pnpm -r typecheck` + `server: vitest run` + `admin: next build`。これらは Phase 0/1 完了時点で緑にできる(WP-0.3でtest緑、WP-1.2でtypecheck緑)。
  - **非必須(warning/情報表示のみ、当面は赤で落とさない)**: `pnpm -r lint`。理由: ESLint導入直後は既存 stale closure 等で**大量の指摘が出て緑にできない**(WP-1.1参照)。lintを最初から必須化すると Phase 1 でCIが永久にレッドになり、以降のPRが全てブロックされる。
  - **ラチェット運用**: 既存lint違反を「棚卸し済みベースライン」として許容し、**新規の違反だけを落とす**運用(lint baseline / `--max-warnings` の段階的引き下げ)へ移行。Phase 2〜5 で違反が減った領域から順にファイル/ルート単位で必須化を広げる。
- 対象: `.github/workflows/ci.yml`(新規)
- 規模: M / 回帰リスク: 低
- 依存: WP-0.3(test緑), WP-1.2(typecheck緑)が必須ゲートの前提。WP-1.1(lint導入)は非必須ジョブとして先行導入可。
- 検証: ダミーPRで、typecheck/test/build のレッドは正しく落ち、lint指摘だけのPRは(当面)マージ可能であること。

### WP-1.4 Docker再現性(任意・このフェーズ推奨)
- 指摘: 4-7
- アプローチ: server/admin の Dockerfile を `corepack` + `pnpm install --frozen-lockfile` に統一。workspace全manifestをCOPY。
- 対象: `server/Dockerfile`, `admin/Dockerfile`
- 規模: S / 回帰リスク: 中(ビルド手順変更)
- 検証: `docker compose build` 成功、lockfile通りの依存解決。

---

# Phase 2 — セキュリティ・認可(約1週間)

> Phase 1 完了後に着手するとCIで守られる。各WPは回帰テストを伴う。

### WP-2.1 認可の一元化 🔴重要
- 指摘: 1-7(git.ts 認可欠如), 3-6(認可重複), 1-68(sync.ts無認証)
- アプローチ: Hono ミドルウェア `requireMembership(role?)` を新設し、全テナント系ルートに付与。`git.ts` の GET/POST `/repos` 等、`sync.ts` に適用。保守系(hooks/install, migrate-http)は管理者専用化。
- 対象: `server/src/lib/`(新ミドルウェア), `server/src/routes/git.ts`, `sync.ts`, 既存ルートの置換
- 規模: M / 回帰リスク: 中(認可を締めるので既存の緩い動作が変わる)
- 検証: **非メンバーが403/404になる結合テストを追加**(4-10とセット)。既存メンバーは従来通り。

### WP-2.2 招待トークンと権限モデルの修正
- 指摘: 1-8(トークン未消費), 1-43(admin が owner 付与で権限昇格)
- アプローチ: サインアップ成功と原子的にトークンを single-use 消費(または1トークン1回上限)。`POST /:id/members` の付与可能ロールを呼び出し元ロール以下に制限、userId 実在検証。
- 対象: `server/src/index.ts`, `server/src/routes/invitations.ts`, `companies.ts`
- 規模: M / 回帰リスク: 中
- 検証: 同一リンク2回目のサインアップ拒否、admin が owner 付与不可、のテスト追加。

### WP-2.3 IPC 入力検証の統一
- 指摘: 1-2(companyId), 1-4(repoPath/引数injection), 1-37(openExternal/openFolder), 1-38(symlink), 3-16(判定3重複)
- アプローチ: `isWithinAllowedRoots(p)`(realpathベース)に許可判定を一本化し、**全 git/fs/shell ハンドラ先頭で強制**。`companyId` を `^[A-Za-z0-9_-]+$` 検証。ユーザー入力の ref/path は `--` の後へ、commitHash は正規表現検証。openExternal はスキームをホワイトリスト化。
- 対象: `client/electron/main.ts`, `chat-tools.ts`
- 規模: M / 回帰リスク: 中(厳格化で一部の入力が弾かれる)
- 検証: path traversal / symlink / `-`始まり引数 / 不正スキームの単体テスト(純関数化して WP-5.2 と連携)。

### WP-2.4 tools:start の信頼境界
- 指摘: 1-3(未検証パスで npm install = RCE経路), 1-41(コマンドブロックリスト回避可)
- アプローチ: `toolPath` を allowedRoots に限定。ツール起動前に明示同意ダイアログ。`--ignore-scripts` 検討、execAsync にタイムアウト。コマンド遮断は承認コールバック必須を主防御に。
- 対象: `client/electron/main.ts`(tools:start), `chat-tools.ts`
- 規模: M / 回帰リスク: 中(UXに同意ステップ追加)
- 検証: allowedRoots外のtoolPathが拒否されること、同意なしで起動しないこと。

### WP-2.5 外部リンクポリシー
- 指摘: 1-15(`target="_blank"` で子ウィンドウに載る、setWindowOpenHandler不在)
- アプローチ: リンクは `onClick` で `openExternal`(http/httpsのみ)。main 側に `setWindowOpenHandler(()=>({action:'deny'}))` と `will-navigate` ガード。
- 対象: `client/src/components/chat/MarkdownMessage.tsx`, `auth/LoginScreen.tsx`, `client/electron/main.ts`
- 規模: S / 回帰リスク: 低
- 検証: AI応答内リンク・サインアップリンクが既定ブラウザで開くこと。

### WP-2.6 pre-receive フックの完全化 + フックテスト
- 指摘: 1-9(初回push/ルートコミット未走査), 4-4の一部
- アプローチ: 初回push時は `git ls-tree -r "$new_sha"` で全ブロブを走査(または `--root` 付き diff-tree)。一時bareリポジトリでフックを実行する結合テストを追加(秘密混入push拒否、ルートコミット全走査、winpath拒否)。
- 対象: `server/src/templates/pre-receive-hook.sh`, `server/tests/`(新規)
- 規模: M / 回帰リスク: 中
- 検証: ルートコミットに秘密を仕込んだpushが拒否されるテスト。

### WP-2.7 chat-server の堅牢化 + ai:chat 廃止
- 指摘: 1-39(workingDirectory未検証), 1-40(ai:chat常時bypass), 3-13(機能重複・脆いパース)
- アプローチ: `/api/chat` の body を zod 検証、`workingDirectory` を許可ルートに制限。レガシー `ai:chat` 経路を廃止し chat-server に一本化(reasoning抽出も共通化)。
- 対象: `client/electron/chat-server.ts`, `main.ts`(ai:chat削除)
- 規模: M / 回帰リスク: 中(経路削除)
- 検証: 不正 workingDirectory 拒否、チャットが従来通り動作。

### WP-2.8 admin セキュリティ
- 指摘: 1-45(config直叩きで初回作成不能), 1-46(open redirect)
- アプローチ: `/api/config` を `apiClient` 経由(相対パス)に統一。`redirect` クエリを同一オリジンパスに検証。
- 対象: `admin/src/app/login/page.tsx`, `admin/src/lib/api.ts`
- 規模: S / 回帰リスク: 低
- 検証: LAN経由でサインアップフォームが出ること、外部URLへの redirect が無効化されること。

### WP-2.9 デッドコードの地雷除去
- 指摘: 1-69(permissions.ts が無認証で全許可を返す未マウントコード)
- アプローチ: `server/src/routes/permissions.ts` を削除(テストのコメントも整理)。
- 対象: `server/src/routes/permissions.ts`
- 規模: S / 回帰リスク: 低
- 検証: ビルド・テストが通ること。

### WP-2.10 ログアウト経路の単一化(クロスユーザー情報露出の遮断) 🔴高重要度
- 指摘: **1-13(高)** — ログアウトが authStore と appStore の片方しか初期化せず、共有端末でユーザーA→B切替時にA社ワークスペースがアクセスチェックなしで開き、`lastCompany` も汚染される
- 背景: 初版では具体WPが無く付録で「WP-3.x」と曖昧化していた。性質はクロスユーザーの情報露出=**セキュリティ**のため Phase 2 に格上げ・独立WP化する。
- アプローチ: 正規のログアウトアクションを**1経路に統一**。`authStore.signOut` 内で `appStore` の `currentCompany`(および openFiles 等のセッション派生状態)も必ずクリアし、UI(`SkillCentricLayout` 等の `electronAPI.signOut()` 直呼び)は全てこの store アクション経由に置換。`signOut` に catch を追加。`App.tsx:72-75` の `lastCompany` 永続化が user 切替時に旧会社を書き込まないようガード。
- 対象: `client/src/stores/authStore.ts`, `client/src/stores/appStore.ts`, `client/src/components/skill-ui/SkillCentricLayout.tsx`, `client/src/App.tsx`
- 規模: M / 回帰リスク: 中(ログアウトの状態遷移を変える)
- 検証: 共有端末シナリオ(A ログアウト→B ログイン)で、B のセッションに A 社が一切残らないこと。全ログアウト経路が同一アクションを通ること。

---

# Phase 3 — データ整合性・同期(約1〜1.5週間)

> 最も慎重に。「ファイルシステム=正」の原則を守る中核。各WPはテスト必須。

### WP-3.1 git:sync の堅牢化 🔴中核
- 指摘: 1-5(ロック競合), 1-6(リベース検出不正確), 4-11(syncテスト皆無)
- アプローチ:
  - ロックを「setしてからawait」へ。`syncLocks.set(repoPath, prev.then(doSync))`。
  - リベース判定を `.git/rebase-merge` / `.git/rebase-apply` ディレクトリ存在に変更。
  - **simple-git をモック(または tmp実リポジトリ)にした統合テスト**を追加(conflict→backup→ours→rebase --continue の一連)。
- 対象: `client/electron/main.ts`(git:sync一帯)、テスト新規
- 規模: L / 回帰リスク: 高(同期は中核)
- **依存(改訂): WP-5.2 の一部前倒しを推奨。** ロック解決・リベース状態判定・コンフリクト分類などの純粋ロジックを**先に Electron 非依存モジュールへ抽出**してから直す。「最小限inline化してでもテスト」だと Electron ランタイム依存の brittle な統合テストになりがちで、回帰リスク高のこのWPには不十分。sync関連の純関数抽出(WP-5.2のサブセット)を WP-3.1 の前段タスクとして明示的に切る。
- 検証: 抽出した純関数の単体テスト(ロック順序・リベース検出・コンフリクト分類)+ 統合テスト(同時sync2発でindex.lock競合しない、クラッシュ後の中断リベースから復旧、競合解決でローカル版が `.backups/` に残る)。

### WP-3.2 サーバー commit/push の整合性
- 指摘: 1-10(push失敗黙殺でDB/リポジトリ乖離), 1-44(作業ツリー未リセット/削除後始末欠如)
- アプローチ: `commitAndPush` の push を必須化し、失敗時はDB変更をロールバック(トランザクション境界)またはエラー応答。pre-receive拒否を呼び出し元へ伝搬。作業ツリーは利用前に `fetch + reset --hard origin/main`。DELETE /repos は会社/メンバーシップ/WORKDIRも整合処理。
- 対象: `server/src/routes/departments.ts`, `git.ts`
- 規模: M / 回帰リスク: 高
- 検証: pre-receive拒否名(`CON`等)の作成がDBに残らずエラーになるテスト。

### WP-3.3 エディタ未保存変更の保護
- 指摘: 1-22(複数経路で未保存編集が消える), skill-uiのsync調停
- アプローチ: dirtyバッファ全件を保存する `flushAll()` を用意し、部署切替・ログアウト・ウィンドウクローズ(beforeunload)で必ず await。自動保存を dirtyファイル単位で管理。sync開始前に flushAll、sync中は自動保存停止。
- 対象: `client/src/components/skill-ui/TabbedEditorPanel.tsx`, `SkillCentricLayout.tsx`
- 規模: M / 回帰リスク: 中
- 検証: 編集直後の部署切替・ログアウト・同期で内容が失われないこと。

### WP-3.4 レビュー sidecar の他者書き込み排除
- 指摘: 1-24(読込が他ユーザーのレビュー/返信を書換え・削除), 4-13, 1-28(loadReviews競合)
- アプローチ: orphaned は永続化せず表示時の導出値に。完了レビュー削除は作成者本人/明示操作に限定。`reconcileReviews(reviews, docContent)` 純関数に抽出してテスト。loadReviews に requestId ガード。
- 対象: `client/src/components/skill-ui/MarkdownReview.tsx`
- 規模: M / 回帰リスク: 中
- 検証: 他ユーザーのファイルを開いても変更されないこと、マージ規則の単体テスト。

### WP-3.5 me.ts 永続化 + レスポンス形式統一
- 指摘: 1-42(PATCHスタブ), 3-7(レスポンス形式不統一)
- アプローチ: Better Auth のユーザー更新で永続化(未対応なら501明示)。全ルートのエラー/成功形式を `{success, data?, error?}` ヘルパに統一。
- 対象: `server/src/routes/me.ts`, 共通レスポンスヘルパ
- 規模: S〜M / 回帰リスク: 中(クライアントのレスポンス解釈に影響)
- 検証: プロフィール更新が再読込後も残ること。

### WP-3.6 chat履歴の安全な永続化
- 指摘: 2-4(同期FS・非アトミック・多タブで消失)
- アプローチ: 非同期FS化、temp+rename のアトミック書込、デバウンス/キュー化。companyId検証(WP-2.3と連携)。
- 対象: `client/electron/main.ts`(chatHistory一帯)
- 規模: M / 回帰リスク: 中
- 検証: 多タブ同時保存で履歴が消えないこと。

### WP-3.7 破壊的操作の共通ガード(スキル上書きほか) 🔴高重要度
- 指摘: **1-12(高)** — スキル作成/コピーで同名フォルダの存在を確認せず既存スキルを無警告で上書き。あわせて横断テーマ「破壊的操作のガード不足」の **1-26**(ファイル操作のエラー握り潰し+入力検証なし), **1-30**(バックアップ復元が無確認上書き), **1-31**(公開確認状態の持ち越し), **1-32**(コピー二重実行・失敗無通知) を同じ共通パターンで潰す
- 背景: 初版では1-12に具体WPが無く付録で「WP-3.x/個別」と曖昧化。高重要度のため独立WP化し、破壊的操作の共通UX(存在チェック→確認ダイアログ→失敗通知)を横展開する土台とする。
- アプローチ: (a) スキル作成/コピー確定前に `exists(destPath)` チェック→重複はエラー/上書き確認。フォルダ名バリデーションを `utils/skillFolderName`(WP-5.4と連携)に共通化。(b) 破壊的操作(削除・復元・上書き)は共通の確認ダイアログ+失敗トーストを通す。`onCopy`/`onComplete` を `Promise<void>` 化して await、実行中は disabled 維持。
- 対象: `client/src/components/skill-ui/NewSkillWizard.tsx`, `CopySkillModal.tsx`, `BackupHistorySlideOver.tsx`, `SkillDetailPanel.tsx`, `FileTreePanel.tsx`, `SkillCentricLayout.tsx`
- 規模: M / 回帰リスク: 中
- 検証: 同名スキルのコピーが既存を上書きしないこと(確認orエラー)、復元前に確認が出ること、コピー二重クリックで二重実行しないこと。

### WP-3.8 既存データ不整合の棚卸し・修復(本番運用向け) 🔴運用
- 指摘: 1-10 の“既発生分”(WP-3.2は原因修正、こちらは既存の壊れた状態の是正)
- 背景: 稼働中インスタンスでは、既に「DBにあるがリポジトリに無い部署」「リポジトリにあるがDBに無いフォルダ」等の乖離が生じている可能性がある。原因を直しても既存不整合は自動では消えない。
- アプローチ: DB(表示設定)と各会社リポジトリ(=Source of Truth)を突き合わせる**照合スクリプト**を用意し、乖離を検出→レポート。安全な自動修復(FS優先で孤児DB行を掃除、未登録フォルダをDBに追記)と、人手確認が要るケースの切り分け。実行前にバックアップ。
- 対象: `server/`(一回性のメンテナンススクリプト or 管理APIエンドポイント)、運用手順
- 規模: M / 回帰リスク: 中(本番データを触るため要バックアップ・ドライラン)
- 依存: WP-3.2(原因修正)完了後に実施しないと、修復した先から再び乖離する
- 検証: ドライランで乖離が正しく列挙されること。修復後にDBとリポジトリが一致すること。

---

# Phase 4 — パフォーマンス(約1週間、Phase 3 と一部並行可)

### WP-4.1 サーバー git 実行の非同期化 🔴可用性
- 指摘: 2-1(execFileSync同期実行でイベントループ停止、一覧GET毎にpull)
- アプローチ: clone/pull/commit/push を非同期 `spawn`/`execFile`(Promise化)へ。部署一覧GETで毎回pullしない(既存cloneを読む)。
- 対象: `server/src/routes/departments.ts`, `companies.ts`
- 規模: M / 回帰リスク: 中
- 検証: 大きめリポジトリで一覧GET中も他APIが応答すること。

### WP-4.2 本番デプロイ構成の分離
- 指摘: 2-16(devサーバが本番稼働), 1-2-16関連
- アプローチ: admin をマルチステージで `next build`+`next start`(standalone)。dev用は `docker-compose.override.yml` に分離。`NODE_ENV=production` 既定。
- 対象: `admin/Dockerfile`, `docker-compose.yml`, `docker-compose.override.yml`(新規)
- 規模: M / 回帰リスク: 中
- 検証: 本番イメージで管理画面が動作、HMR/devオーバーレイが無いこと。

### WP-4.3 チャットの再レンダー最適化
- 指摘: 2-2(handleEditMessage identity), 2-12(memo/全タブマウント), 2-13(IPCストーム), 2-29(フルPrism)
- アプローチ: handleEditMessage を関数型更新にして依存縮小。ChatPanelChat を memo化+安定コールバック。一覧APIをメタデータのみに分離。Prism を PrismAsyncLight へ。
- 対象: `client/src/components/chat/ChatPanel.tsx`, `MarkdownMessage.tsx`, `main.ts`(getChatSessions)
- 規模: M / 回帰リスク: 中
- 検証: 長い履歴のストリーミングで全メッセージ再レンダーが起きないこと(React DevTools / perfDiagnostics)。

### WP-4.4 ファイルツリーの差分更新
- 指摘: 2-9(全ツリー再取得), 2-10(行非memo), 2-8(リサイズ全再レンダー)
- アプローチ: watcher の change はスキップ、add/unlink は親だけ差分更新。行を memo化 `TreeNode` に切り出し。リサイズはref+CSS変数で mouseup確定。
- 対象: `client/src/components/skill-ui/FileTreePanel.tsx`, `ResizeHandle.tsx`, `SkillCentricLayout.tsx`
- 規模: M / 回帰リスク: 中
- 検証: 自動保存中にツリー全再構築が走らないこと、ドラッグが軽いこと。

### WP-4.5 同期走査と差分計算の効率化
- 指摘: 2-3(sync毎の全走査), 2-11(computeDiff O(m×n))
- アプローチ: large file / nested repo 検出を `git ls-files`/`status --porcelain` ベースに。computeDiff を共通prefix/suffix除去+Myers系(`diff`パッケージ)へ。
- 対象: `client/electron/main.ts`, `client/src/components/skill-ui/MarkdownReview.tsx`
- 規模: M / 回帰リスク: 中
- 検証: 大規模リポジトリの同期時間短縮、大ドキュメントのdiffがフリーズしないこと。

---

# Phase 5 — 構造改善・テスタビリティ(継続枠、2〜4週間)

> 価値は高いが破壊力も大きい。安全網(Phase 1)が前提。「純粋ロジック抽出 → 分割」の順。

### WP-5.1 shared 型の単一ソース化
- 指摘: 3-2(adminが型を手書き複製しドリフト), 3-8(IPC型二重定義), 3-31(日付型不統一)
- アプローチ: shared を workspace依存(`workspace:*`)として admin/server からimport。`main/types` を実体直指し。IPC型を `shared/` か `client/src/types/ipc.ts` に一元化。API境界の日付は ISO文字列に統一。
- 対象: `shared/`, `admin/src/lib/api.ts`, `client` フック・型, preload
- 規模: M / 回帰リスク: 中
- 検証: typecheck green、実APIレスポンスと型が一致。

### WP-5.2 純粋ロジックの抽出 + ユニットテスト 🔴テスト土台
- 指摘: 4-8, 4-3(main.tsのimport副作用), 各所の純関数埋没
- アプローチ: env/frontmatter解析・diff解析・パス操作・フォルダ名生成・レビューのマージ規則・メッセージ変換などを `lib/` へ抽出してexport。Electron非依存化。Vitest でテーブル駆動テスト。client/admin に vitest 導入。
- 対象: 各パッケージの `lib/` 新設、テスト群
- 規模: L / 回帰リスク: 低(抽出は挙動を変えない)
- 検証: 抽出関数のユニットテストが green、呼び出し側が同一挙動。

### WP-5.3 IPC facade / fs アダプタ
- 指摘: 4-9(window.electronAPI 直結合でテスト不能)
- アプローチ: `services/chatServerClient.ts`(serverInfo注入)、`lib/ipc.ts`(IPC facade)、`{readFile,writeFile,...}` fsアダプタを新設。コンポーネントはそれ経由に。
- 対象: `client/src/` 広範(段階移行)
- 規模: M〜L / 回帰リスク: 中
- 依存: WP-5.2 と相互補完
- 検証: フック/コンポーネントが facade モックでテスト可能に。

### WP-5.4 共通基盤の整備
- 指摘: 3-9(i18n混在), 3-10(モーダル重複×9), 3-11(フォルダ名フォーム重複), 3-12(async/watch/走査の重複)
- アプローチ: `<Modal>`プリミティブ+`useEscapeKey`、`useAsyncResource`/`useDeferredRefresh`/`useWatchedPath`、`utils/skillFolderName`、文言の `locales/*.json` 統一。
- 対象: `client/src/components/common/`, `hooks/`, `utils/`, i18n
- 規模: L / 回帰リスク: 中
- 検証: 言語切替が全画面に効くこと、モーダル挙動の統一。

### WP-5.5 Godコンポーネント分割 + 旧UI削除
- 指摘: 3-4(ChatPanel/skill-ui分割), 3-5(main.ts分割), 3-1(旧UI一括削除)
- アプローチ: レビューの分割方針に従い段階分割。ChatPanel → セッションフック/入力系/ヘッダ/部品。main.ts → `ipc/*`・`git/*`・`config`・`paths`。旧UIツリー・useFileOperations・skill-tools・appStore死状態を削除。
- 対象: `client/` 広範
- 規模: XL / 回帰リスク: 高
- 依存: WP-5.2, WP-5.3(ロジック抽出後に分割するのが安全)
- 検証: 分割前後で全機能が同一動作(回帰テスト + 手動verify)。

---

# Phase 6 — 継続改善

### WP-6.1 Electron 更新(EOL対応)
- 指摘: 3-29(Electron 31.7.7 はEOL、Chromiumセキュリティパッチ未達)
- アプローチ: サポート中メジャーへ更新。`File.path`廃止(1-56)対応で `webUtils.getPathForFile` へ。
- 規模: M / 回帰リスク: 中
- 検証: 主要フローのスモークテスト、ドロップ機能の動作。

### WP-6.2 残りの低優先項目の掃き出し
- 指摘: レビューの[低]項目群(1-50〜71, 2-18〜29, 3-14〜31, 4-11〜18 の未消化分)
- アプローチ: 各Phaseの関連WPに相乗りで消化、または専用の掃除PRでまとめて。
- 規模: 随時 / 回帰リスク: 低〜中

---

## 付録A: 重要度×フェーズの対応表(全[高]24件の所在)

> **改訂1で作り直し。** 初版は「高18件」を名乗りつつ [中] 項目(1-22, 1-47)の混入と [高] 8件(1-2,1-4,1-5,1-6,2-2,3-4,3-5,4-3)の取りこぼしがあった。レビュー doc の `[高]` セクションを機械集計した**実数24件**を全数掲載する(集計コマンド: `[高]` 見出し配下の `### N-M` を数える)。Phase順にソート。

| 指摘ID | 内容 | 担当WP | Phase |
|---|---|---|---|
| 1-1 | `.env`漏洩(APIキー全社流出) | WP-0.1 + 着手前提2(即時鍵ローテ) | 0 |
| 1-11 | Hooks違反で編集時クラッシュ | WP-0.2 | 0 |
| 4-2 | 既存テストがレッド | WP-0.3 | 0 |
| 3-1 | 旧UIデッドコード(データ消失footgun) | WP-0.5(footgun撤去) / WP-5.5(一括削除) | 0, 5 |
| 3-3 | lint腐敗(root lint常時失敗) | WP-1.1 | 1 |
| 4-1 | CI不在 | WP-1.3 | 1 |
| 1-7 | git.ts ほぼ全EPで認可欠如 | WP-2.1 | 2 |
| 1-8 | 招待トークン未消費(無制限作成) | WP-2.2 | 2 |
| 1-9 | pre-receive 初回push未走査 | WP-2.6 | 2 |
| 1-3 | tools:start が未検証パスでnpm install(RCE経路) | WP-2.4 | 2 |
| 1-4 | git系ハンドラの validatePath漏れ+引数injection | WP-2.3 | 2 |
| 1-2 | chatHistory companyId 未検証(path traversal) | WP-2.3(+ WP-3.6) | 2 |
| 1-13 | ログアウト状態分裂(クロスユーザー露出) | **WP-2.10** | 2 |
| 4-4 | 中核経路(git-http/フック/同期)テスト皆無 | WP-2.6 / WP-3.1 | 2, 3 |
| 1-5 | git:sync ロック競合(race) | WP-3.1 | 3 |
| 1-6 | リベース中断検出が不正確 | WP-3.1 | 3 |
| 1-10 | push黙殺でDB/リポジトリ乖離 | WP-3.2(原因) + WP-3.8(既存是正) | 3 |
| 1-12 | スキル無確認上書き(破壊的操作) | **WP-3.7** | 3 |
| 2-1 | サーバーgit同期実行でイベントループ停止 | WP-4.1 | 4 |
| 2-2 | handleEditMessage identityでmemo無効化 | WP-4.3 | 4 |
| 3-2 | shared型が分裂・ドリフト | WP-5.1 | 5 |
| 3-4 | Godコンポーネント(3000行超) | WP-5.5 | 5 |
| 3-5 | main.ts肥大(3965行) | WP-5.5 | 5 |
| 4-3 | main.ts import副作用でテスト不能 | WP-5.2 | 5 |

> 補足:
> - **1-47(server/shared symlink)は本来[中]** だが、他マシンで dev が即死し修正が安価なため Phase 0(WP-0.4)で前倒し対応する。同様に **1-22(未保存編集消失)も[中]** だが影響が大きく WP-3.3 で扱う。この2件は上表([高]全数)には含めない。
> - 横断テーマ「破壊的操作のガード不足」(1-12, 1-26, 1-30, 1-31, 1-32 等)は WP-3.7 で共通の「存在チェック→確認ダイアログ→失敗通知」パターンとして一括整備する。

## 付録B: 並行作業のヒント(複数人の場合)
- **フロント担当 / バックエンド担当 / 基盤担当** で分けると衝突が少ない。
  - 基盤: Phase 1(CI/lint) → WP-5.1(型) → WP-5.2(抽出)
  - バックエンド: WP-2.1, 2.2, 2.6 → WP-3.1(サーバー側), 3.2, 4.1
  - フロント: WP-0.2/0.6, 2.5, 2.8 → WP-3.3, 3.4 → 4.3, 4.4
- **WP-5.5(分割)は最後に1人で**。並行で他WPが走ると衝突が激しい。

## 付録C: 各WP共通の進め方(Definition of Done)
1. 対象コードを修正(レビューの行番号は実装時に再確認。**未コミットWIP込みの行番号**なので、着手前提1でベースを確定してから照合)
2. 回帰テストを追加(Phase 2以降は必須)
3. **必須ゲート**: `pnpm -r typecheck` と `(cd server && npx vitest run)` が green。**lint**: WP-1.3の方針に従い、当面は「全体green」ではなく**触れたファイル/ルートに新規lint違反を持ち込まない**こと(既存違反はベースラインとして許容、領域が片付いたら必須化へ昇格)
4. 影響フローを手動 verify(同期・認証・編集など中核は実アプリで確認)
5. PR は1WP単位。説明に対応する指摘ID(例: 1-1)を記載

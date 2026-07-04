# AI Company Builder コードレビュー / 改善点一覧

作成日: 2026-06-13
対象: リポジトリ全体 (server / admin / client / shared / ビルド・運用設定)
レビュー方法: 領域別に7並列でソースを精読し、主要な高リスク指摘はオーケストレーターが実コード・実行結果で再検証。

---

## エグゼクティブサマリ

- **検出件数**: 約90件 (高: 18 / 中: 41 / 低: 30 前後)。
- **最優先で塞ぐべき**: ①CI・lint・型チェックが事実上ゼロ(rootの`pnpm lint`は常に失敗、サーバーテストは現在1件レッド)、②同期(git:sync)の競合・状態復旧の不正確さ、③信頼境界の緩さ(`.env`が同期対象=APIキー全社漏洩、未検証パスでの`npm install`実行、IPC入力検証の不統一)、④認可漏れ(`git.ts`のほぼ全エンドポイント、`sync.ts`)。
- **構造的負債**: クライアントに新旧UIが並走(旧UI一式がデッドコード)、3000行超のGodコンポーネント、`shared`型が単一の真実源として機能していない、純粋ロジックがUIに埋没してテスト不能。

### 横断的な構造テーマ (まずここから直すと多数の個別問題が一掃される)

1. **品質ゲートの全面的不在** — CIなし、admin/clientはテスト0件かつ`react-hooks/exhaustive-deps`等のlintなし、型チェックは通常運用で一度も走らない。本レビューのstale closure・依存配列・日付ロジック・Windowsパスのバグの多くは、lint+ユニットテスト+CIがあれば機械検出できた類。**投資対効果が最大。**
2. **信頼境界の責務が未定義** — `.env`の同期除外、外部リンクの開き方、ログアウト時の状態クリア、IPCの`validatePath`適用が「やってある所と無い所」でバラバラ。preload/main/サーバー側でガードを一元化し、レンダラーはstore/facade経由のみとする規約が必要。
3. **エラー黙殺 × 二重Source of Truth** — gitのpush/pull失敗を握りつぶしてDBやUIだけ先に進む箇所が多数。「ファイルシステム=正」の原則に反してDB・リポジトリ・画面が乖離する。
4. **純粋ロジックのUI埋没** — diff解析・.envパース・パス操作・レビューのマージ規則・フォルダ名生成などテスト容易な純関数がコンポーネント内に閉じている。`lib/`抽出+IPC facade化で、危険な仕様の大半をユニットテストで固定できる。
5. **Godファイルの増殖** — `main.ts`(3965行)、`ChatPanel.tsx`(3325行)、skill-ui 4ファイル(951〜1425行)。バグが巨大ファイルの中で見えなくなっている(例: ChatPanelのHooks違反)。

### 推奨対応ロードマップ

| 段階 | 内容 |
|---|---|
| **即時 (今週)** | レッドのテスト修正 / `.env`を同期除外 / ChatPanelのHooks違反修正 / 旧UIの同期ボタン撤去(誤使用防止) / `git.ts`・`sync.ts`の認可追加 |
| **短期** | CI(server test + 各パッケージtypecheck)を1本立てる / git:syncロック修正・リベース検出修正 / IPCの`validatePath`を全ハンドラに強制 / 外部リンクを`openExternal`へ |
| **中期** | 認可をHonoミドルウェアに一元化 / `commitAndPush`のpush必須化・トランザクション境界 / 純粋ロジックの`lib/`抽出+ユニットテスト / `shared`型を真の単一ソース化 |
| **継続** | Godコンポーネント分割 / 同期git実行(execFileSync)の非同期化 / 旧UIデッドコード削除 / Electron更新(EOL) |

---

## 凡例

- 重要度: **[高]** データ破損・クラッシュ・セキュリティ・主要フロー破壊 / **[中]** 特定条件で実害 / **[低]** 品質・将来リスク
- 領域タグ: `[server]` `[electron]` `[chat]` `[skill-ui]` `[client]` `[admin]` `[build]`
- ✅ = オーケストレーターが実コード/実行で再検証済み

---

# 1. バグリスク / セキュリティ

## [高]

### 1-1. ✅ `.env`(APIキー)が同期対象から除外されず、チーム全体に漏洩する `[electron]` `[client]`
- 場所: `client/electron/main.ts:1993-2016` (essentialPatterns)、`client/electron/main.ts:936-955` (env:write)、`client/src/components/settings/SettingsPanel.tsx:139-208`
- 問題: SettingsPanelはOPENAI/ANTHROPIC等のAPIキーを`{rootPath}/.env`に保存するが、`.env`を`.gitignore`へ追加する処理が存在しない。自動追加されるのは`.backups/` `.workspace/` `node_modules/`のみ。同期は`git add .`相当で全ファイルをコミットするため、秘密情報が会社リポジトリ経由で全メンバーに配布される。UIの注意書きも`.backups/`と100MB超ファイルしか触れず、ユーザーは気づけない。
- 改善案: `env:write`時(または同期前のessentialPatterns)に`.env`を`.gitignore`へ自動追記し、UIにも明記。既存リポジトリに`.env`がコミット済みでないかの検出も検討。

### 1-2. ✅ chatHistoryの`companyId`が未検証で任意ファイル書き込み (path traversal) `[electron]`
- 場所: `client/electron/main.ts:1096-1102` (`getChatHistoryPath`)、利用箇所 `:1132`/`:1161`/`:1204`
- 問題: `path.join(dir, \`${companyId}.json\`)`の`companyId`をレンダラから無検証で受ける。`companyId='../../../../tmp/evil'`でuserData外の任意`.json`パスにJSONを書き込める。
- 改善案: `companyId`を`^[A-Za-z0-9_-]+$`で検証、または`path.basename`を強制。

### 1-3. ✅ `tools:start`が未検証パスで`npm install`/`npm run`を実行 (RCE経路) `[electron]`
- 場所: `client/electron/main.ts:3603-3751` (特に`:3624`の`execAsync('npm install', { cwd: toolPath })`)
- 問題: `toolPath`を`validatePath`せず`cwd`にして`npm install`と`npm run <cmd>`を起動。toolPathは同期リポジトリ(他メンバー/サーバー由来)のコンテンツであり、postinstallやdevスクリプトで任意コードが実行される。allowedRoots外でも実行可能。
- 改善案: `toolPath`を`validatePath`でallowedRoots配下に限定。起動前に明示的ユーザー同意を必須化。`--ignore-scripts`付きinstallとタイムアウト付与を検討。

### 1-4. ✅ git系ハンドラの`validatePath`適用漏れ + 引数インジェクション `[electron]`
- 場所: 未検証: `git:sync`(`:1883`)、`git:setupCompanyRemote`(`:2517`)、`git:pushToServer`(`:2974`)、`git:log`(`:1792`)、`git:showCommit`(`:1815`)、`git:init`(`:1583`)、`git:addRemote`(`:1604`)。引数インジェクション: `git:revertFile`(`:1709`)、`git:commitFileDiff`(`:1756`)
- 問題: 主要フローの`git:sync`を含め多くがrepoPathを検証せず`createGit`に渡し、commit/pushや`.gitignore`書き込みを行う。`filePath`/`commitHash`を`--`の前に置く箇所があり、`-`始まりの値でgitオプションに化ける。
- 改善案: 全gitハンドラ冒頭で`validatePath(repoPath)`を必須化。ユーザー入力のref/pathは必ず`--`の後に。commitHashは`^[0-9a-fA-F]{7,40}$`で検証、filePathの`..`を拒否。

### 1-5. ✅ git:syncのロックが同時実行を防げていない (race condition) `[electron]`
- 場所: `client/electron/main.ts:1873-1881`
- 問題: 「既存promiseをawait → 新promise生成 → `syncLocks.set`」の順で、awaitとsetの間がアトミックでない。完全同時の2呼び出しは両方existing=undefinedで並走し、同一リポジトリで`git add/commit/rebase/push`が並行実行され`index.lock`競合やリベース破壊を招く。
- 改善案: awaitする前に同期的にチェーンを張る。`const prev = syncLocks.get(repoPath) ?? Promise.resolve(); const p = prev.catch(()=>{}).then(() => doSync()); syncLocks.set(repoPath, p)` とし、`set`を最初のawaitより前に必ず実行。

### 1-6. ✅ syncのリベース中断検出が`REBASE_HEAD`依存で不正確 (状態復旧の取りこぼし) `[electron]`
- 場所: `client/electron/main.ts:1888-1906`
- 問題: クラッシュ後の残存リベース復旧で`REBASE_HEAD`の有無を見ているが、リベース進行中の正規マーカーは`.git/rebase-merge/`または`.git/rebase-apply/`ディレクトリ。`REBASE_HEAD`は存在しないこともあり、中断リベースを検出できず後続のpull/commitが失敗し得る。
- 改善案: リベース判定を`fs.existsSync('.git/rebase-merge') || fs.existsSync('.git/rebase-apply')`に変更。

### 1-7. ✅ `git.ts`のほぼ全エンドポイントに認可(メンバーシップ)チェックが無い `[server]`
- 場所: `server/src/routes/git.ts:41`(GET /repos)、`:75`(POST /repos)、`:137`(GET /repos/:companyId)、`:184`(POST /hooks/install)、`:224`(POST /repos/migrate-http)。認可があるのはDELETE `:262`のみ。
- 問題: 認証はするがメンバーシップ/ロールを確認しないため、任意の認証ユーザーが全テナントのリポジトリID一覧取得・任意companyIdのclone URL取得・任意IDのbareリポジトリ作成・全テナントへのフック再インストールを実行できる。マルチテナント分離違反。
- 改善案: 各ハンドラでcompanyIdに対する`memberships`照会を必須化。保守系(hooks/install, migrate-http)は管理者専用化。

### 1-8. ✅ 招待トークンがサインアップ時に消費されず、1リンクで無制限にアカウント作成可能 `[server]`
- 場所: `server/src/index.ts:116-139` (検証は127-133)
- 問題: サインアップは有効なトークンがあれば許可するが、ここでトークンを`used`にしない。トークン消費は別経路`POST /invitations/:token/accept`のみ。有効期間中、同一リンクで何度でもアカウント作成でき「初回ユーザー後はサインアップ無効」を実質回避できる。
- 改善案: サインアップ成功と原子的にトークンをsingle-use消費する、または招待を「サインアップ用」と「メンバー追加用」で分離。

### 1-9. ✅ pre-receiveのシークレット検査が初回push/ルートコミットでツリー全体を走査しない `[server]`
- 場所: `server/src/templates/pre-receive-hook.sh:90-113` (特に92行)
- 問題: 新規ブランチ時の検査が`git diff-tree --no-commit-id --name-only -r "$new_sha"`(単一引数)でファイル列挙する。これはtipと第1親の差分のみで、ルートコミット(親なし)では出力が空。会社作成時の初回pushは単一ルートコミットなので**全くスキャンされない**。秘密検知はこのフックの主目的。
- 改善案: 初回pushはWindowsパス検査と同様に`git ls-tree -r "$new_sha"`で全ブロブを列挙して`git show`で走査する(または`--root`付きdiff-treeを各コミットに対して回す)。

### 1-10. ✅ git pushエラーの握り潰しでDBと共有リポジトリが恒久的に乖離 `[server]`
- 場所: `server/src/routes/departments.ts:104-117` (push catch 108-111)、利用 `:315`(作成)/`:418`(改名)/`:529`(削除)
- 問題: `commitAndPush`はpush失敗を黙殺する。pre-receive拒否(秘密/Windows非互換名)やネットワーク不調でpushが失敗してもDB更新は成功扱いで201/200を返す。例: `CON`や末尾ドットのフォルダ名はAPI検証を通るがpre-receiveが拒否し、DB行だけ作られbareリポジトリに伝播しない。改名・削除でも同様。
- 改善案: pushを必須化し、失敗時はDB変更をロールバックまたはエラー応答。少なくともpre-receive拒否を呼び出し元へ伝搬。

### 1-11. ✅ ChatPanel: 条件付き早期returnの後に`useState`があり、編集開始でクラッシュ (Hooks違反) `[chat]`
- 場所: `client/src/components/chat/ChatPanel.tsx:467` (早期return) / `:497` (`useState(showAllFiles)`)
- 問題: `if (isEditing) return (...)`の後に`useState`が宣言されている。編集ボタンで`isEditing`がtrueになると次レンダーでHooks数が減り、Reactが "Rendered fewer hooks than expected" をthrowしてチャットパネル全体がクラッシュする。
- 改善案: `showAllFiles`の`useState`を関数先頭(他Hooksの直後)へ移動する。

### 1-12. ✅ スキル作成/コピー時に同名フォルダの重複チェックがなく既存スキルを黙って上書き `[skill-ui]`
- 場所: `client/src/components/skill-ui/NewSkillWizard.tsx:77-87` / `CopySkillModal.tsx:139-173`、消費側 `SkillCentricLayout.tsx:610-`
- 問題: 形式バリデーションのみで宛先の存在を確認しない。親は`mkdir{recursive}`→`writeFile`、コピーは`fs.promises.cp`(force上書き)。CopySkillModalはコピー元フォルダ名をデフォルト値にするため「更新版を再コピー」で既存スキルが破壊される導線になっている。
- 改善案: 確定前に`exists(destPath)`で存在チェックし、重複時はエラー/上書き確認。バリデーション共通化。

### 1-13. ✅ ログアウトがauthStoreとappStoreの片方しか初期化せず、共有端末で別ユーザーに会社が残る `[client]`
- 場所: `client/src/stores/authStore.ts:77-85`、実UIの `SkillCentricLayout.tsx:844-851`(`electronAPI.signOut()`直呼びで`user`を残す)、`App.tsx:72-75`(永続化エフェクト)
- 問題: 経路ごとにクリアする対象が異なる。一方では本体セッション破棄後も`user`が残りAPI全滅、もう一方ではユーザーA→B切替時に`currentCompany`がA社のまま残り、アクセスチェックなしでA社ワークスペースが開き`lastCompany`も汚染される。
- 改善案: `signOut`アクション内で`appStore`の`currentCompany`等もクリアして単一の正規ログアウト経路にし、UIは必ずstoreの`signOut`を呼ぶ。catch追加も。

## [中] (抜粋して列挙)

### 1-14. ✅ アクティブセッション削除後に自動保存で復活する `[chat]`
- 場所: `ChatPanel.tsx:2116-2127` (deleteSession) → `:2129-2136` (startNewChat内の`saveCurrentSession`)
- 問題: 表示中セッションを削除すると`startNewChat()`が走り、その先頭の`saveCurrentSession()`が削除済みID・内容をディスクへ再保存し履歴に蘇る。
- 改善案: 削除経由では保存をスキップするフラグを渡すか、先に`currentSessionId`/`messages`をクリアしてから遷移。

### 1-15. ✅ 外部リンクが`target="_blank"`でElectron子ウィンドウに載る (`setWindowOpenHandler`不在) `[chat]` `[client]`
- 場所: `client/src/components/chat/MarkdownMessage.tsx:28-31`、`client/src/components/auth/LoginScreen.tsx:122-130`。main.tsに`setWindowOpenHandler`なし(`contextIsolation:true`/`nodeIntegration:false`は設定済みで良好)。
- 問題: AI応答(半信頼)やサインアップページのリンククリックで任意URLがアプリ内ウィンドウで開く。Electronセキュリティチェックリスト違反、フィッシング誘導の温床。preloadに`openExternal`は既にあるのに未使用。
- 改善案: `onClick`で`e.preventDefault()`+`window.electronAPI.openExternal(href)`(http/httpsのみ)。main側に`setWindowOpenHandler(()=>({action:'deny'}))`を設定。

### 1-16. メッセージ編集・再生成がサーバー側Claude CLIセッションの文脈をリセットしない `[chat]`
- 場所: `ChatPanel.tsx:2313-2318` (handleEditMessage) / `:2633` (onRegenerate)
- 問題: ローカルの`messages`は`slice`で巻き戻すが`claudeSessionIdRef`/CLIセッションはそのままで、CLIは削除済み旧ターンを文脈に含んだまま応答する。編集時に元の画像・参照ファイルも再送されない。
- 改善案: 編集/再生成時はサーバへ巻き戻し指示を送るか、`claudeSessionIdRef`をクリアして新規CLIセッション+履歴再送で再構築。

### 1-17. stop+150ms待機後の保存がstale closureの`messages`を使い末尾を取りこぼす `[chat]`
- 場所: `ChatPanel.tsx:2080-2085` / `:2130-2136` / `:2280-2284`
- 問題: 「stop→150ms待機→saveCurrentSession」だが、`saveCurrentSession`はクリック時クロージャの`messages`を参照するため、stop後にフラッシュされたチャンクは保存されない。sleepは閉じ込められた配列に効かずタイミング依存。
- 改善案: 最新`messages`を`useRef`にミラーして保存時はrefから読む。完了はsleepでなく`onFinish`/abort完了をawait。

### 1-18. ツール承認リクエストの上書き・残留 `[chat]`
- 場所: `ChatPanel.tsx:1579-1588` / `:2129-2159`
- 問題: 承認待ち中に次のリクエストが来ると`setPendingApproval(data)`が前のを上書きし、前のリクエストには永久に応答されずCLIが待ち続ける。セッション切替/新規/stopでもクリアされず、無関係なセッションで承認操作できてしまう。
- 改善案: 配列キュー化して順次表示。切替・stop時に未応答へ自動denyを送ってクリア。

### 1-19. handleSendの多重実行ガードがなく二重ストリームが起こり得る `[chat]`
- 場所: `ChatPanel.tsx:2269-2310` (入力欄は常に`disabled={false}`)
- 問題: ストリーミング中の送信でstop→150ms待機中にもう一度送信すると、両方が古い`status`判定のまま`sendMessage`へ到達し、同一useChatに並行リクエストが走る。スキル自動送信effectも同型。
- 改善案: `isSendingRef`で直列化。`status`はrefミラーで最新値を読む。

### 1-20. FileReaderにエラーハンドラがなく画像読込失敗でhandleSendが永久待機 `[chat]`
- 場所: `ChatPanel.tsx:2291-2295`
- 問題: `new Promise((resolve)=>{ reader.onload=... })`に`onerror`がなく、失敗時にPromiseが解決されず`handleSend`のawaitが完了しない(送信が無言で消える)。
- 改善案: `reader.onerror=()=>reject(...)`を追加し、失敗画像はスキップ+警告。

### 1-21. transport `body()`が`pendingImagesRef`を破壊消費し、リトライ/regenerateで画像が失われる `[chat]`
- 場所: `ChatPanel.tsx:1651-1676`
- 問題: `body()`呼び出し時に`pendingImagesRef.current=[]`で消費するため、再送・`regenerate()`では画像・referenceFilesなしのリクエストになる(表示は画像付きでもAIに届かない)。
- 改善案: 画像をメッセージIDに紐づけて保持し、message parts(file part)として送る。

### 1-22. ✅ 未保存編集が失われる複数経路(自動保存の保証が破れている) `[skill-ui]`
- 場所: `TabbedEditorPanel.tsx:534-553`(部署切替で全タブ破棄→dirtyバッファ削除)/`:586-651`(自動保存はアクティブファイルのみ)、`SkillCentricLayout.tsx:433-443`
- 問題: (a)部署切替で`setOpenFiles([])`するとクリーンアップがdirtyバッファを削除し直近の編集が消える。(b)別タブへ切替えると背景タブはdirtyのまま二度と保存されない。(c)アプリ終了・ログアウトでもフラッシュがない。フッターは常に「自動保存」と表示し信頼を裏切る。
- 改善案: dirtyバッファ全件を保存する`flushAll()`を用意し、部署切替・ログアウト・ウィンドウクローズ(beforeunload)で必ずawait。自動保存はdirtyファイル単位で管理。

### 1-23. ✅ NewSkillWizardの複数行descriptionがYAML frontmatterを破壊 `[skill-ui]`
- 場所: `NewSkillWizard.tsx:224-237` (textarea)、消費側 `SkillCentricLayout.tsx:568-571` (`description: ${data.description}`を生埋め)
- 問題: descriptionは改行入力でき、frontmatterに生で埋め込まれる。main側パーサは行指向regexのため説明が1行目に切詰められ、説明中に`---`があればfrontmatter全体が壊れる。Claude Code本体が読むYAMLとしても不正。
- 改善案: 改行除去(または1行input化)+`---`/先頭`key:`のエスケープ、または書き込み側でYAML引用。

### 1-24. レビューの「読込」処理が他ユーザーのレビュー/返信ファイルを書換え・削除 `[skill-ui]`
- 場所: `MarkdownReview.tsx:444-473` (自動削除・orphan書換え) / `:161-199` (cleanupRepliesForReview)
- 問題: ファイルを開いただけで他レビュアーの`.review.*.json`にorphanedフラグを書き戻し、全解決済みレビューを削除する。「各自が自分のファイルだけ書くから競合しない」という同ファイル冒頭の設計を実装自身が破っており、複数人同時オープンでsync競合と履歴消失を招く。
- 改善案: orphanedは永続化せず表示時の導出値に。完了レビュー削除は作成者本人のクライアントのみ/明示操作に限定。

### 1-25. MarkdownPreviewのDOM直接改変がReactの再描画と衝突しクラッシュし得る `[skill-ui]`
- 場所: `TabbedEditorPanel.tsx:147-209` (検索ハイライト) / `:252-290` (レビューハイライト)
- 問題: react-markdownが生成したTextノードを`splitText`/`replaceChild`で`<mark>`に差替える。ハイライト中に`content`が変わると、Reactのコミットが改変済みノードに対し操作して`NotFoundError`を投げ得る。
- 改善案: ハイライトをDOM後加工でなくレンダリング段階で注入(rehypeプラグイン/カスタムレンダラ)。

### 1-26. ✅ ファイル操作のエラー握り潰し+入力検証なし(`/`や`..`でツリー外に書ける) `[skill-ui]` `[client]`
- 場所: `FileTreePanel.tsx:607-665`、`SkillCentricLayout.tsx:604-607`(`// TODO: Show error message`)、`common/InputDialog.tsx:47-52`、`common/ConfirmDialog.tsx:25-36`
- 問題: 新規作成/リネームが入力値を検証せず`${parentPath}/${value}`に直結。`/`や`..`でツリー外脱出をmain側`validatePath`頼みで投げる。writeFile/renameItem失敗のcatchがなく未処理rejection。複数削除は途中例外で中断しダイアログも閉じない。ConfirmDialogはdocumentレベルのEnterで破壊的操作が確定する。
- 改善案: ファイル名バリデーション(セパレータ・空・予約名)と操作共通のtry/catch+トースト。ConfirmDialogは要素スコープのkeydownにしdanger時はEnter確定を無効化。

### 1-27. Windowsパス区切りの取り扱いが不統一(rename破綻・外部変更リロード不発・プレフィックス過剰一致) `[skill-ui]` `[client]`
- 場所: `TabbedEditorPanel.tsx:481-495`(生パス比較、正規化漏れ)、`utils/path.ts:9-11`、`SyncPreviewDialog.tsx:45,60,100,155`、`sidebar/Sidebar.tsx:148`、`useFileOperations.ts:74`
- 問題: mainの`readDirectory`はWindowsでバックスラッシュを返すため`lastIndexOf('/')`での親パス切り出しが`-1`になりrenameが壊れる。`startsWith`比較に区切り境界がなく`/root/営業`が`/root/営業部/...`に一致する。直近コミット`cbbde75`で直した箇所の取りこぼし。
- 改善案: `utils/path.ts`に`dirname()`・`isPathInside(parent, child)`(正規化+境界付き)を追加し、文字列直書き比較を全廃。

### 1-28. 非同期IPC応答の順序・キャンセルガード欠如で古い結果が表示される(複数箇所) `[skill-ui]`
- 場所: `MarkdownReview.tsx:430-520` (loadReviews)、`CopySkillModal.tsx:75-120`、`FileSearchModal.tsx:23-28`、`CommitHistoryPanel.tsx:164-185`、`PdfPreview` (`TabbedEditorPanel.tsx:60-93`)
- 問題: 世代カウンタ/cancelledフラグがなく、ソース/ファイルを素早く切替えると先発の遅いレスポンスが後着して別対象の内容で上書きされる。CommitHistoryPanelの`loadingFiles`は単一値で連続展開時に競合。`SearchPanel.tsx:104-120`には正しいパターンがあり横展開すべき。
- 改善案: effectに`let cancelled=false`+cleanup、またはrequestId採番。`loadingFiles`は`prev===hash?null:prev`の関数型更新。

### 1-29. CodeEditorが`onChange`/`readOnly`を生成時にキャプチャするstale closure `[skill-ui]`
- 場所: `CodeEditor.tsx:336-343, 395` (deps `[fileName, theme]`)
- 問題: `updateListener`と`EditorState.readOnly`がエディタ生成時に固定され、親が新しい`onChange`を渡しても古いクロージャが呼ばれ続ける。ピン留め後も古い`onPinFile`を毎キーストローク呼ぶ。readOnlyの動的切替も効かない。
- 改善案: `onChangeRef`を毎レンダー更新してlistenerはref経由。readOnlyはCompartmentでreconfigure。

### 1-30. バックアップ「復元」が確認なしで作業ツリーを即上書き `[skill-ui]`
- 場所: `BackupHistorySlideOver.tsx:55-69, 190-197` (main側は`fs.copyFileSync`で無条件上書き)
- 問題: 1クリックで現在のファイル内容(同期取得したサーバー版/未保存編集)が確認なしに消える。結果通知も`alert()`で他UIと不整合。
- 改善案: 復元前に確認ダイアログ。可能なら復元前の現内容を逆バックアップ。alertをアプリ標準通知へ。

### 1-31. SkillDetailPanel/ToolsTabがkeyなし・ローカルstateで、スキル切替・タブ切替時に状態が乖離 `[skill-ui]`
- 場所: `SkillDetailPanel.tsx:48,173,391-438`、使用側 `SkillCentricLayout.tsx:1104`(keyなし)
- 問題: スキル切替で`activeTab`/`showPublishConfirm`がリセットされず、不可逆操作「公開」の確認状態が別スキルに引き継がれる。ツール起動状態はローカルstateなのでタブ切替でアンマウントされ、プロセスは生きているのにUIは「Start」表示でStopに到達できない。
- 改善案: `key={skill.id}`で再マウントまたはeffectでリセット。ツール実行状態はストア/専用フックへ移し、マウント時にmainへ問い合わせて復元。

### 1-32. ✅ CopySkillModalの`isCopying`が即時解除され二重実行・失敗無通知 `[skill-ui]`
- 場所: `CopySkillModal.tsx:165-173`、`NewSkillWizard.tsx:331-355`
- 問題: `onCopy`はasyncなのにawaitせず`finally`が同期で走り`setIsCopying(false)`が即実行。スピナーが一瞬で消え、完了まで再クリックでき同じdestPathへ二重コピー。失敗時は親が`console.error`のみでモーダルは開いたまま無反応。
- 改善案: `onCopy`/`onComplete`を`Promise<void>`にしてawaitし、成功/失敗をモーダルで受けてエラー表示。実行中はdisabled維持。

### 1-33. CompanySelector: Gitリモート設定失敗を握り潰して「セットアップ完了」表示 `[client]`
- 場所: `CompanySelector.tsx:137-141, 177-181`
- 問題: 中核価値の同期なのに、`gitSetupCompanyRemote`失敗時は`console.warn`のみで`done`まで進み、ユーザーは同期可能と誤認する。
- 改善案: 失敗時は警告ステート+リトライ導線で「同期未設定」を明示。

### 1-34. 会社名を無加工でフォルダ名に使い、Windows禁止文字・スラッシュで破綻 `[client]`
- 場所: `CompanySelector.tsx:170` (`${localPath}/${selectedCompany.name}`)
- 問題: 会社名はサーバー上で自由入力。`/`で意図しないネスト、Windowsでは`<>:"|?*`等で`createDirectory`が生エラー。CLAUDE.mdのフォルダ名規則は部署のみ。
- 改善案: 禁止文字置換のサニタイズ純関数を`utils/`に切り出して適用。

### 1-35. useSparseCheckout: stale stateベースの排他リスト更新で更新ロスト `[client]`
- 場所: `useSparseCheckout.ts:54-80`
- 問題: `next`をクロージャ捕捉の`excludedPaths`から作るため、await中に別操作が走ると後勝ちで片方が消え、チェックアウト対象の誤削除/誤復元につながる。SettingsPanelはボタンdisableで緩和しているが他の呼び出し元(SkillCentricLayout)には保証なし。
- 改善案: フック内で操作をキュー化(直列化)、またはmain側にadd/remove単位APIを持たせ戻り値`result.excluded`のみを正とする。

### 1-36. SyncPreviewDialog: 同期失敗時もコミットメッセージを消去、revert例外は未処理 `[client]`
- 場所: `SyncPreviewDialog.tsx:254-271, 153-169`
- 問題: `onSync(...)`直後に`setCommitMessage('')`するため、失敗しても作業メモが失われる(意図と矛盾)。`handleRevert`はcatchがなくreject未処理。`window.confirm`を使い共通ConfirmDialogと二重基準。
- 改善案: `onSync`をPromise化して成功時のみクリア。revertにcatch+エラー表示。confirmをConfirmDialogへ。

### 1-37. ✅ shell.openExternal / backup:openFolder がスキーム・パス未検証 `[electron]`
- 場所: `client/electron/main.ts:3810-3817` (openExternal)、`:2960-2968` (openFolder)
- 問題: レンダラから渡るURL/パスを無検証で`shell.openExternal`/`shell.openPath`へ。`file:`/`smb:`等任意スキームの起動や任意ファイルを既定アプリで開く(=実行)ことが可能。
- 改善案: openExternalは`new URL(url).protocol`をhttp/https/mailtoに限定。openFolderは`validatePath`でallowedRoots配下に限定。

### 1-38. ✅ validatePathがシンボリックリンクを解決せず外部へ漏れる `[electron]`
- 場所: `client/electron/main.ts:27-35`、`chat-tools.ts:19-25`、`main.ts:405-417`
- 問題: `path.resolve`はリンクを辿らないため、同期リポジトリ内に`sales/evil -> /etc/passwd`があるとテキスト上チェックを通過し実体(リポジトリ外)へアクセスする。共有リポジトリ経由でリンクが配布され得る。
- 改善案: 重要操作では`fs.realpathSync`で実体解決後にallowedRoots判定。書き込み系はリンク経由を拒否。

### 1-39. chat-server: `workingDirectory`等のボディ未検証で任意ディレクトリ実行 `[electron]`
- 場所: `client/electron/chat-server.ts:217-243, 370-374`
- 問題: `/api/chat`はbodyをschema検証せず`workingDirectory`をCLIの`cwd`にして`bypassPermissions`+`settingSources:['user','project']`で起動。トークン保護はあるがallowedRootsチェックがなく任意ディレクトリでbypass実行できる。
- 改善案: bodyをzod等で検証。`workingDirectory`を許可ルート配下に制限(mainから許可リスト注入)。

### 1-40. ✅ `ai:chat`が`config.permissionMode`を無視し常時bypassPermissions `[electron]`
- 場所: `client/electron/main.ts:3820, 3840`
- 問題: レガシー経路`ai:chat`が`permissionMode:'bypassPermissions'`をハードコードし、chat-server側(getPermissionMode尊重)と乖離。使われると常に権限プロンプトを回避。
- 改善案: `loadConfig().permissionMode`を尊重。未使用なら経路ごと削除。

### 1-41. executeCommandのブロックリストが容易に回避可能 `[electron]`
- 場所: `client/electron/chat-tools.ts:144-209`
- 問題: `rm --recursive`(force無し)、`python -c "os.remove"`、`node -e`、`truncate`、`git reset --hard`等が未ブロック。ブロックリスト方式は本質的に抜け穴が多い。
- 改善案: ブロックリストは補助とし、実防御は承認コールバック必須+許可リスト/サンドボックスへ。最低限`find -delete`・スクリプト言語の削除APIを追加。

### 1-42. ✅ me.tsのPATCHが永続化せず成功レスポンスだけ返す `[server]`
- 場所: `server/src/routes/me.ts:27-48` (`// TODO: Implement`)
- 問題: プロフィール更新が何も保存せずリクエスト値をそのまま返し、クライアントは保存成功と誤認(再読込で消える)。GETは`{success,data}`形式なのにPATCHは生オブジェクトで形式も不一致。
- 改善案: Better Authのユーザー更新で永続化、未実装なら501/明示エラー。形式統一。

### 1-43. 管理者が任意ユーザーを'owner'として追加できる(権限昇格) `[server]`
- 場所: `server/src/routes/companies.ts:332-381` (ロール検証356)
- 問題: 招待経路は`admin|member`に制限しているのに、直接APIではadminが共犯ユーザーをownerとして追加でき、削除保護(owner削除不可)と相まって権限モデルが崩れる。`userId`の実在検証もない。
- 改善案: 付与可能ロールを呼び出し元ロール以下に制限(adminはowner付与不可)。userId実在確認。

### 1-44. 共有作業ディレクトリの状態リセット欠如/リポジトリ削除の後始末欠如 `[server]`
- 場所: `departments.ts:64-101` (`getWorkingDir`)、`git.ts:261-305` (DELETE /repos)
- 問題: `getWorkingDir`は会社ごと単一作業ツリーを使い回し、pull失敗を黙殺するのみで`reset --hard`しない。残った未コミット変更・改名途中状態で以降が誤動作。DELETE /reposはbareを`rmSync`するだけでcompanies/memberships/作業ディレクトリを残し、壊れた会社が残る。
- 改善案: 利用前に既知良状態へ同期(fetch+reset --hard、無ければ再clone)。削除時は会社/メンバーシップ/WORKDIRも整合処理。

### 1-45. ✅ 初期セットアップ判定が`NEXT_PUBLIC_API_URL`直叩きで、初回アカウント作成が不能になる条件がある `[admin]`
- 場所: `admin/src/app/login/page.tsx:22-31`
- 問題: 他APIは相対パス+Next rewrites経由なのに`/api/config`だけ直fetch。LAN経由(`BIND_ADDR=0.0.0.0`)ではブラウザが自分のlocalhost:3001を叩いて失敗し、catchで`setupComplete=true`に倒れサインアップフォームが永遠に出ない。`res.ok`未チェック。
- 改善案: `apiClient('/api/config')`に統一しrewriteを通す。失敗時は黙って「済み」に倒さずエラー表示。

### 1-46. ✅ `redirect`クエリ無検証によるopen redirect `[admin]`
- 場所: `admin/src/app/login/page.tsx:10, 37, 52`
- 問題: `searchParams.get('redirect')`をそのまま`router.push()`に渡す。`/login?redirect=https://evil.com`でログイン成功直後に外部サイトへ飛ばせる。
- 改善案: `redirectTo.startsWith('/') && !redirectTo.startsWith('//')`で同一オリジン検証。

### 1-47. ✅ `server/shared`symlinkが開発機の絶対パスでコミットされている `[build]`
- 場所: `server/shared` (git blob, 中身=`/Users/abekoichiro/work/products/ai-company-builder/shared`)
- 問題: 他マシン(特にWindows)でクローンすると壊れたリンクになり、`departments.ts:13`の`from '../../shared/types'`が解決できずホストでの`pnpm dev`が即死。Dockerはvolumeマウントで偶然動くため気づきにくい。
- 改善案: 相対symlink(`../shared`)にするか、symlinkを廃止しtsconfig `paths`/pnpm workspace参照(`@ai-company-builder/shared`)へ。

### 1-48. 削除前統計の取得失敗時に「空です。安全に削除できます」と誤表示したまま削除に進む `[admin]`
- 場所: `admin/src/app/companies/[id]/departments/page.tsx:177-181, 547-551`
- 問題: stats API失敗時に`{files:0,folders:0}`にフォールバックし「空なので安全」と断言する。実際は中身があるかもしれず、部署削除はサーバー側で物理削除する不可逆操作。
- 改善案: 失敗時は`null`のまま「ファイル数を確認できませんでした。中身ごと削除されます」と警告。

### 1-49. 操作系エラーでページ全体がエラー画面に置き換わり復帰不能 `[admin]`
- 場所: `admin/src/app/companies/[id]/page.tsx:148-153, 52/68/80/119`
- 問題: レンダーが`loading : error : 本文`の排他分岐で、招待/メンバー操作の失敗で`setError`されると本文が丸ごと消え、クリア手段がなくリロード必須。departmentsページ(282-287)はバナー方式で正しい。
- 改善案: 「初期ロード失敗」と「操作失敗」を分け、操作失敗は閉じられるバナーで表示。

## [低] (主要なもの)

- **1-50** `[chat]` アンマウント時クリーンアップが初回レンダーの`serverInfo`を捕捉し、サーバー再起動後に旧アドレスへDELETEが飛ぶ (`ChatPanel.tsx:2253-2266`) → serverInfoをrefミラー。
- **1-51** `[chat]` タブクローズ時にセッション未保存でドラフト・直近メッセージ消失 (`ChatPanel.tsx:2843-2854`) → unmount cleanupでスナップショット保存。
- **1-52** `[chat]` ドロップされたfile-pathsペイロードの型未検証で後段`split`がTypeError (`ChatPanel.tsx:1316-1327`) → 要素型を検証。
- **1-53** `[chat]` perfDiagnostics: disable後もrAF/interval/PerformanceObserverが動き続ける (`perfDiagnostics.ts:160-213`) → stopでハンドル解除。
- **1-54** `[skill-ui]` CommentPopoverの外側クリッククローズが空実装(デッドコード) (`MarkdownReview.tsx:1309-1317`)。
- **1-55** `[skill-ui]` レンダー中の副作用(setState+localStorage / キャッシュ更新) (`SkillCentricLayout.tsx:117-122`, `FileTreePanel.tsx:250-259`)。
- **1-56** `[skill-ui]` 外部ドロップが`File.path`依存でElectron 32+で静かに全滅 (`FileTreePanel.tsx:351-369`) → `webUtils.getPathForFile`。
- **1-57** `[skill-ui]` toggleResolved/addReplyのread-modify-write競合 (`MarkdownReview.tsx:609-679`) → 書込みを直列化。
- **1-58** `[skill-ui]` 会社切替で`selectedDeptId`がリセットされず旧会社の部署IDが残る (`SkillCentricLayout.tsx:100-122`)。
- **1-59** `[skill-ui]` CommitHistoryPanel.formatDateが24時間窓で「今日/昨日」を誤判定、未来日時で「-1日前」 (`CommitHistoryPanel.tsx:55-71`)。
- **1-60** `[skill-ui]` NewSkillWizardの`focusRing`は存在しないCSSプロパティで無効、`as`で型エラー握り潰し (`NewSkillWizard.tsx:184`)。
- **1-61** `[skill-ui]` 検索/一覧系の失敗が「0件」と区別されずユーザーに伝わらない (`SearchPanel.tsx:58-68`, `FileSearchModal.tsx:27`)。
- **1-62** `[client]` ContextMenuのビューポートはみ出し補正が初回表示で効かない (`ContextMenu.tsx:44-53`) → `useLayoutEffect`。
- **1-63** `[client]` authStore: signIn成功後のgetSession失敗で「成功なのに未ログイン画面のまま」 (`authStore.ts:40-48`)。
- **1-64** `[client]` appStore: `registerAllowedRoot`をawaitせず会社確定(IPCがawait化された瞬間に初回読込が権限エラー) (`appStore.ts:228-244`)。
- **1-65** `[client]` App.tsx: レンダー中にテーマDOM操作・checkSession呼び出し(StrictMode非互換、テーマ適用が計3箇所重複) (`App.tsx:53-64`)。
- **1-66** `[client]` DiffViewer: バイナリ差分・特殊行を黙って捨てて「差分なし」と誤表示 (`DiffViewer.tsx:98-119`)。
- **1-67** `[chat]` スラッシュ候補の選択リセットが`.length`基準で、件数同数の入替時に別アイテムを指す (`ChatPanel.tsx:808-810`)。
- **1-68** `[server]` `sync.ts`が無認証スタブのままマウントされ、`POST /api/sync`はボディ無しで500 (`sync.ts:6/26/35`, `index.ts:146`)。
- **1-69** `[server]` `permissions.ts`が未マウントだが無認証で全許可を返す地雷コード(削除推奨) (`permissions.ts:6-49`)。
- **1-70** `[admin]` `apiClient`が204/空ボディで例外、タイムアウト無しでハング時に`loading`が永久残留 (`api.ts:16-31`)。
- **1-71** `[admin]` signOut/dashboard loadCompaniesの失敗が`console.error`のみでUI無反応・空状態と誤認 (`auth-context.tsx:62-69`, `dashboard/page.tsx:27-36`)。

---

# 2. パフォーマンス

## [高]

### 2-1. ✅ サーバーの全ファイル操作系が`execFileSync`でgitを同期実行しイベントループ全体を停止 `[server]`
- 場所: `departments.ts:76,90,93,106-109,417,528`、`companies.ts:107-161`。特に`getWorkingDir`が**部署一覧GET(`:207`)のたびに`git pull`を走らせる**。
- 問題: clone/pull/commit/pushが同期実行で、その間Node単一スレッドが完全停止する。2.4GiB級リポジトリでは一覧表示や部署作成のたびにサーバー全体が数秒〜数分フリーズし、ヘルスチェック・認証・他社API・git-httpも巻き添えで止まる。git-http.tsが非同期`spawn`なのと対照的。
- 改善案: 非同期`spawn`/`execFile`(Promise化)へ移行。一覧GETで毎回pullしない。

### 2-2. handleEditMessageのidentity不安定でMessageListのmemoが毎チャンク無効化 `[chat]`
- 場所: `ChatPanel.tsx:2313-2318` (`useCallback`依存に`messages`) / `:1472` / `:582`
- 問題: ストリーミング中50ms毎に新しい関数が生成され`onEditSubmit`として全MessageItemに渡るため、memoが完全無効化されチャンク毎に全メッセージ(Markdown込み)が再レンダー。長い履歴ほど重い主因。
- 改善案: `setMessages(prev => prev.slice(0, prev.findIndex(...)))`の関数型更新にして依存を`[setMessages, sendMessage]`へ縮小。

## [中] (抜粋)

### 2-3. ✅ sync毎にツリー全走査を複数回 (findNestedGitRepos + scanForLargeFiles) `[electron]`
- 場所: `main.ts:2021-2050` (large file)、`:555-593`/`:2066` (nested repo)、gitignore判定が`includes`の部分一致(誤検出)
- 問題: 同期のたびにワークツリー全体を再帰`readdir`+`stat`。大規模リポジトリでI/Oが重く同期UXを悪化。
- 改善案: `git ls-files`/`git status --porcelain`の結果に絞る。gitignoreは行単位で正規化比較。

### 2-4. chat履歴が同期FSかつ非アトミックで毎メッセージ全書き込み `[electron]`
- 場所: `main.ts:1104-1127, 1161-1201`
- 問題: `readFileSync`/`writeFileSync`をメインプロセスで実行しイベントループをブロック。セッション保存はメッセージごとに全JSON読み書きで、肥大化するとUIが固まる。load→modify→writeが非アトミックで多タブ同時保存時にデータ消失。
- 改善案: 非同期FS化、temp+renameのアトミック書き込み、デバウンス/キュー化、セッション単位ファイル分割。

### 2-5. fs:readDirectoryTreeの`Promise.all`が無制限並列でfd枯渇(EMFILE) `[electron]`
- 場所: `main.ts:595-623`
- 問題: 各階層を`Promise.all(entries.map(...))`で再帰展開し並列度に上限がない。広く深いツリーで同時`readdir`が爆発。
- 改善案: 並列度制限(p-limit)または逐次化。

### 2-6. chat-serverのセッションマップがリーク `[electron]`
- 場所: `chat-server.ts:185` (sessionUsageMap)、`:197` (claudeSessionMap)、削除は`:687-693`のみ
- 問題: 明示的DELETEが呼ばれない限り解放されず、クラッシュ・タブ放置で蓄積。TTL/上限なし。
- 改善案: 最終アクセス時刻ベースのTTL/LRU上限。

### 2-7. tool/skillのファイル読み取りが全読込後にtruncate(OOM余地) `[electron]`
- 場所: `chat-tools.ts:81, 96`
- 問題: `fs.readFile(absPath,'utf-8')`で全量を読んでからtruncate。数百MB〜GBでメモリ枯渇の恐れ。
- 改善案: 事前`stat`でサイズ確認、または先頭Nバイトのみ読む。

### 2-8. パネルリサイズのmousemove毎にレイアウト全体を再レンダー `[skill-ui]`
- 場所: `SkillCentricLayout.tsx:666-697, 1130/1146`、`ResizeHandle.tsx:9-39`(`startPos`がstate+deps)
- 問題: mousemove毎に`setLeftPanelWidth`等が走り、memo化されていないFileTreePanel/TabbedEditorPanel/SkillGrid/ChatPanelを含むツリー全体がピクセル単位で再レンダー。ResizeHandleはリスナーも毎回脱着し速いドラッグで取りこぼす。
- 改善案: ドラッグ中はref+CSS変数の直接更新にしてmouseupでstate確定。`startPos`をrefに。主要子を`React.memo`化。

### 2-9. fs変更のたびにdepth5のツリー全再取得(自動保存毎にも発火) `[skill-ui]`
- 場所: `FileTreePanel.tsx:302, 430-460` (コメントは「2 levels」だが実装5)
- 問題: watcherがイベントtypeを見ず、内容変更(change)でも`loadFiles(true)`で5階層全ツリーをIPC再取得。自動保存(1秒毎)中はほぼ常時、巨大フォルダの全走査+全行再構築。
- 改善案: changeはスキップ、add/unlinkは変更パスの親だけ`loadSingleDirectory`で差分更新。

### 2-10. ツリー行が非memoで、1行の状態変化でも全行再レンダー(+localStorage毎回読み) `[skill-ui]`
- 場所: `FileTreePanel.tsx:760-965` (renderEntry)、`MarkdownReview.tsx:404-416` (hasUnseenReviews)
- 問題: `renderEntry`は再帰関数のため`dragOverPath`(ホバー毎変化)や`selectedPaths`更新で可視行すべて再構築。バッジ判定が行毎・レンダー毎に`localStorage.getItem`+`JSON.parse`。
- 改善案: 行を`React.memo`の`TreeNode`に切り出し、review-seenはメモリキャッシュ。

### 2-11. computeDiffがO(m×n)のDP表をフル確保し大ドキュメントでフリーズ `[skill-ui]`
- 場所: `MarkdownReview.tsx:1334-1342` (コメントは「Hunt-Szymanski」だが実装は素朴LCS)
- 問題: 行数m×nの二次元配列を確保。5000行同士で約2500万セル(数百MB)消費しレンダラが固まる。
- 改善案: 共通prefix/suffix除去+Myers O(ND)系(`diff`パッケージ)へ。行数上限フォールバック。

### 2-12. memoがインラインアロー/全タブ常時マウントで無効化 `[chat]` `[skill-ui]`
- 場所: `ChatPanel.tsx:3017-3039` (ChatPanelChat非memo+`onTitleChange={(title)=>...}`)、`SkillGrid.tsx:156-312` (SkillCard)
- 問題: 全タブのChatPanelChatが常時マウントされ、1タブのタイトル更新(自動保存毎)で親再レンダー→全タブ再レンダー。SkillCardは`onSelect={()=>...}`で毎レンダー新関数を渡しmemoが常に不一致。
- 改善案: memo化+`tabId`/`id`を渡して安定コールバックを共有。

### 2-13. 保存毎にフルセッション一覧を全タブで再ロード(IPCストーム) `[chat]`
- 場所: `ChatPanel.tsx:1898-1906, 1969, 1871-1880`
- 問題: `getChatSessions`が全セッションの全メッセージ込みで返り、自動保存(1秒毎)のたびに保存タブの`loadSessions()`+全タブの`onChatHistoryChanged`で二重・N倍の重いIPC+JSON化。
- 改善案: 一覧APIをメタデータのみに分離。save後の手動reloadはイベント駆動に一本化。

### 2-14. メモリ単調増加: messageImages(データURL)・timestampsRef・fileContents `[chat]` `[client]`
- 場所: `ChatPanel.tsx:1631-1637/1771-1777/2091-2093`、`appStore.ts:285-289/272-281`
- 問題: 画像がbase64データURL(数MB/枚)のままMapに保持されセッション切替でも削除されない。`timestampsRef`も追加のみ。appStoreの`fileContents`はclose時も残し全コピー。
- 改善案: 切替時に現セッション外エントリを削除。画像はBlob URL化。closeFileでエントリ削除+LRU。

### 2-15. SearchPanel/FileSearchModal: 結果クリックや開く度にCodeEditor全再構築・ファイル全件再取得 `[skill-ui]`
- 場所: `SearchPanel.tsx:122-126, 234-241` (key連番)、`FileSearchModal.tsx:23-28` (キャッシュなし)
- 問題: `key`がクリック毎にインクリメントされ、同一ファイル内の行移動でもCodeMirrorを破棄再生成。FileSearchModalは開く度に`gitListFiles`をIPC実行。
- 改善案: viewを保持して`dispatch`で行ジャンプ。CommitHistoryPanel同様の短TTLキャッシュ。

### 2-16. ✅ 本番デプロイ経路がdevサーバ(`next dev`/`tsx watch`)で常時稼働 `[build]` `[admin]`
- 場所: `admin/Dockerfile:24` (`CMD ["pnpm","dev"]`)、`docker-compose.yml:31-64` (`NODE_ENV`既定development、apiは`npx tsx watch`)
- 問題: composeが唯一のデプロイ手段だが、adminはReact開発ビルド+HMRで動き応答が遅くメモリを食う。devエラーオーバーレイがスタックトレースを外部に晒す。
- 改善案: マルチステージで`next build`+`next start`(standalone)の本番イメージ。dev用は`docker-compose.override.yml`に分離。

### 2-17. adminのミューテーション毎に画面の全データを再fetch `[admin]`
- 場所: `companies/[id]/page.tsx:41-117`、`departments/page.tsx:96-248`
- 問題: 招待1件削除でも company/members/invitations/departments の4 APIを並列再取得。並べ替えは矢印1クリック毎にreorder+2再取得。
- 改善案: レスポンスでローカルstate部分更新、または対象リソースのみ再fetch(SWR/TanStack Query)。

## [低]

- **2-18** `[electron]` fs:watchがdepth:10・persistentで会社フォルダ全体を常時監視 (`main.ts:793-861`) → 表示中サブツリーに限定。
- **2-19** `[client]` セレクタなしの全store購読が混在(規約違反)。特にFileTreeItemのノード単位全購読は復活時に重大ボトルネック (`SettingsPanel.tsx:22`, `FileTree.tsx:336-337`他) → 個別セレクタに統一+lintで強制。
- **2-20** `[client]` CompanySelector/CompanyWizardが結果未使用の部署スキャンを直列IPC+固定500ms遅延で実行 (`CompanySelector.tsx:118-200`) → スキャン削除。
- **2-21** `[skill-ui]` 全ファイル種別でレビュー読込(ディレクトリ走査+対象ファイル全文read)が走る (`TabbedEditorPanel.tsx:386-393`) → `isMarkdownFile`時のみ。
- **2-22** `[skill-ui]` JSON.stringifyによる深い比較がレビュー再読込毎に実行 (`MarkdownReview.tsx:476/485/495`) → 版数/updatedAt比較。
- **2-23** `[skill-ui]` 未使用の`isSaving` stateが保存毎に2回再レンダー (`TabbedEditorPanel.tsx:364`) → 削除。
- **2-24** `[skill-ui]` useSkills二重実行で部署切替毎にlistSkills IPCが2本 (`SkillCentricLayout.tsx:288-301`)。
- **2-25** `[client]` ダイアログ類がisOpen=falseでもdocumentリスナーを常時登録 (`ConfirmDialog.tsx:25-36`, `InputDialog.tsx:34-43`)。
- **2-26** `[server]` auth.sqliteのリクエスト毎コネクション生成・WAL未設定で "database is locked" 誘発 (`index.ts:119-121`, `lib/auth.ts:60`, `git-http.ts:16`)。
- **2-27** `[chat]` 履歴ドロップダウンのソート/グルーピングがレンダー毎に再計算 (`ChatPanel.tsx:2445-2592`) → useMemo。
- **2-28** `[chat]` メッセージリストの仮想化なしで数百件復元時に全件Markdown+Prismレンダー (`ChatPanel.tsx:1497-1516`)。
- **2-29** `[chat]` react-syntax-highlighterがフルPrism(全言語同期バンドル)。コメントは「async-loaded」だが不一致 (`MarkdownMessage.tsx:4-5`) → PrismAsyncLight。

---

# 3. 可読性・保守性

## [高]

### 3-1. ✅ 旧UI一式(8コンポーネント+2モジュール)がデッドコードとして残存し実装が二重化 `[client]`
- 場所: `components/layout/*`, `sidebar/Sidebar.tsx`, `sidebar/FileTree.tsx`, `editor/*`, `wizard/CompanyWizard.tsx`, `hooks/useFileOperations.ts`, `lib/skill-tools.ts` (いずれもimporterゼロ。App.tsxは`SkillCentricLayout`を描画)
- 問題: 実UIの`FileTreePanel.tsx`(1089行)は`FileTree.tsx`の進化版で、i18n・Windows対応が新側だけに入り乖離。旧`Sidebar.tsx:200-244`の同期ボタンはCLAUDE.md明記の競合解決フロー(バックアップ→ours→rebase --continue)を経ない単純pushで、復活させるとデータ保護が崩れる。appStoreの`fileTree`/`openFiles`/`fileContents`/`companies`/`activeSkill`等もこれら死んだコンポーネントのためだけに存在。
- 改善案: 旧UIツリー・useFileOperations・skill-tools・appStoreの死んだ状態をまとめて削除。最低限、旧Sidebarの同期ボタンは即時撤去。

### 3-2. ✅ `shared/`が型の単一ソースとして機能せず、adminが全型を手書き複製してドリフト済み `[build]` `[admin]`
- 場所: `admin/src/lib/api.ts:57-236` vs `shared/types/index.ts`。shared参照は`departments.ts:13`の1箇所のみ。
- 問題: adminは`@ai-company-builder/shared`を一切importせず同名型を再定義し既に乖離(`User.name`がsharedで`string`/adminで`string|null`、`ReorderDepartmentItem`の`parentId`がshared必須だがadmin/server実装は未使用)。`shared/package.json`の`main/types`はビルドされない`dist/`を指す死に設定。
- 改善案: sharedをworkspace依存(`"@ai-company-builder/shared":"workspace:*"`)としてadmin/server両方からimport。`main/types`を`types/index.ts`直指しに。乖離型はserver実装に合わせて統一。

### 3-3. ✅ lint体制の腐敗: client/serverのlintが常に失敗し、root `pnpm lint`が壊れている `[build]`
- 場所: `client/package.json:13`, `server/package.json:10`, root `package.json:12`
- 問題: client/serverにESLint設定ファイルもeslint依存もなく、スクリプトはESLint 9で廃止の`--ext`を使用。実行すると即死(検証済み)。lintはadminしか機能せず、そのadminも未使用変数4 warningを抱える。
- 改善案: client/serverにflat config(`eslint.config.mjs`)とeslint依存を追加(`react-hooks`プラグイン込み)。当面lintしないなら死にスクリプトを削除してrootを健全化。

### 3-4. 3000行超のGodコンポーネント `[chat]` `[skill-ui]`
- 場所: `ChatPanel.tsx`(3325行)、`MarkdownReview.tsx`(1425)、`SkillCentricLayout.tsx`(1303)、`FileTreePanel.tsx`(1090)、`TabbedEditorPanel.tsx`(951)
- 問題: 1ファイルにI/O・純粋ロジック・hooks・UIが同居し変更影響範囲の見極めが困難。ChatPanelChat(約1100行)はセッションCRUD・タイトル生成・スクロール・承認・送信・描画を全部抱えるGod component。
- 改善案(具体的分割方針):
  - **ChatPanel**: `lib/chatSessionConvert.ts`(メッセージ変換)、`hooks/useChatSessions.ts`(CRUD+タイトル生成)、`hooks/useAutoScroll.ts`、`hooks/useToolApproval.ts`、`chat-input/`(各入力)、`ChatHeader.tsx`、`HistoryDropdown.tsx`、`ChatTabBar.tsx`、`AuthSettings.tsx`、`chat/parts/`(各部品)。
  - **MarkdownReview**: `lib/reviewStore.ts`(sidecar I/O)、`lib/reviewUtils.ts`(merge/diff/find/detect)、`hooks/`(useMarkdownReview/useTextSelection)、Banner/SidePanel/Popover/DiffViewを各ファイルへ。
  - **SkillCentricLayout**: `useSyncManager`、`useEditorTabs`、ヘッダー/通知トーストを子へ。
  - **FileTreePanel**: `useFileTree`、`useTreeDnD`、memo化`TreeNode`、ダイアログ分離。
  - **TabbedEditorPanel**: MarkdownPreview別ファイル、`useFileBuffers`、タブバー、レビューUI分離。

### 3-5. ✅ main.tsが約3965行・責務過多 `[electron]`
- 場所: `client/electron/main.ts`全体(import時に`ipcMain.handle`群が多数実行され副作用)
- 問題: PATH解決/CLI検出/config/fs IPC/git sync/sparse/skills/tools/chat履歴/AI chatが単一ファイルに同居。
- 改善案: `ipc/fs.ts`・`ipc/git.ts`・`git/sync.ts`・`git/sparse.ts`・`skills.ts`・`tools.ts`・`config.ts`・`paths.ts`へ分割。`registerXxxHandlers(deps)`形式にして副作用を関数内へ。

## [中] (抜粋)

### 3-6. ✅ サーバーの認可チェックが共通化されず各ファイルに散在・重複 `[server]`
- 場所: `companies.ts:196-399`、`departments.ts:41-51`、`invitations.ts:33-145`、`git.ts:272-278`、`git-http.ts:61-66`
- 問題: 同じ`SELECT role FROM memberships WHERE user_id=? AND company_id=?`とロール分岐がほぼコピペで多数。共通ミドルウェアがないため新規エンドポイントでチェック漏れが起きやすい(実際git.ts/sync.tsで漏れている)。
- 改善案: Honoミドルウェア`requireMembership(role?)`に一元化。

### 3-7. エラーレスポンス形式・toCamelCase・パス定数の重複と不統一 `[server]`
- 場所: 失敗時`{error}`(companies/departments/invitations) vs `{success:false,error}`(git.ts) vs 生オブジェクト(me.ts)。`toCamelCase`が3コピー(`companies.ts:57`/`departments.ts:28`/`invitations.ts:9`、departments版だけbool変換)。`DATA_DIR/REPOS_DIR/WORKDIR_DIR`が3ファイルで再計算。
- 改善案: 共通レスポンスヘルパ`{success,data?,error?}`、共有util、単一configモジュール。

### 3-8. IPC型・preload型・レンダラー型の二重定義と手動再マッピング `[client]`
- 場所: `useDepartments.ts:4-18`(`DepartmentFromAPI`はpreload型のコピー)、`useSkills.ts:37-47`(恒等フィールドコピー)、`DiffViewer.tsx:201-202`(キャスト)、`types/index.ts:50-57`、`CopySkillModal.tsx:95-108`(`as any[]`)
- 問題: IPC境界の型がpreloadのグローバル宣言とrenderer側ローカル定義で二重管理され、片側変更で黙って乖離。`shared/`の存在意義がIPC契約に活かされていない。
- 改善案: IPCレスポンス型を`shared/`か`client/src/types/ipc.ts`に一元化し、preloadとフック双方がimport。恒等マッピング削除。

### 3-9. i18n基盤があるのに認証・設定・共通ダイアログ・skill-ui各所が日本語ハードコード `[chat]` `[skill-ui]` `[client]`
- 場所: 広範。`LoginScreen`/`CompanySelector`/`ServerSetupScreen`/`SettingsPanel`/`ConfirmDialog`/`SyncPreviewDialog`(全文)、`ChatPanel`(画像警告・今日/昨日・ツールチップ)、`SlashCommandDropdown`、`TabbedEditorPanel`(ほぼ全域)、`SkillCentricLayout`(sync通知)、`SkillDetailPanel`(共有/公開)、`CommitHistoryPanel`/`SearchPanel`/`BackupHistorySlideOver`(全文)。言語初期化も`appStore.ts:57-70`と`i18n/index.ts:7-20`で重複。
- 問題: 言語切替が画面の半分に効かない。後からの国際化で漏れ探しコストが高い。
- 改善案: 文言を`locales/*.json`へ移し`useTranslation`に統一。`getInitialLanguage`をi18n側に一本化。

### 3-10. モーダル骨格(backdrop/Escape/z-index)の重複実装 `[skill-ui]` `[client]`
- 場所: `NewSkillWizard`/`CopySkillModal`/`FileSearchModal`/`BackupHistorySlideOver`(skill-ui)、`ConfirmDialog`/`InputDialog`/`DiffViewer`/`SyncPreviewDialog`/`SettingsPanel`(common)
- 問題: オーバーレイ実装が9箇所近くで重複し、ESC・背景クリック・テーマ対応の挙動が不揃い(NewSkillWizardはダーク固定でライトに追従しない等、既にズレている)。
- 改善案: `<Modal onClose zIndexLayer>`プリミティブ+`useEscapeKey`フックに共通化。

### 3-11. フォルダ名生成・検証ロジックの重複と「全社」マジック文字列の散在 `[skill-ui]`
- 場所: `NewSkillWizard.tsx:23-66` と `CopySkillModal.tsx:26-163`(`generateFolderName`/`isValidFolderName`がほぼ同一)、`SkillGrid.tsx:144/276`・`CopySkillModal.tsx:52`・`DepartmentTabs.tsx:83`(`'全社'`リテラル判定)
- 問題: スキル命名規則(CLAUDE.md記載)が2箇所(+サーバー)で同期必要。「全社」表示名を変えるとSkillGridのアイコン分岐が壊れる。
- 改善案: `utils/skillFolderName.ts`に純関数抽出+共有フォーム。全社判定はID/フラグ(`COMPANY_GROUP`)で。

### 3-12. 同型ロジックのコピペ(会社フォルダ走査・認証アクション・fetch系フック・遅延リロード・watch購読) `[client]` `[skill-ui]`
- 場所: 走査`CompanySelector`/`CompanyWizard`、認証`authStore.ts:37-75`、フック`useDepartments`/`useSkills`/`useSparseCheckout`(三点セット手書き、`refresh`型・`isLoading`初期値が不統一)、遅延リロード`SkillCentricLayout.tsx:316-355`≒`FileTreePanel.tsx:387-423`、watch購読3箇所
- 改善案: `scanDepartments()`純関数、`authenticate(fn)`ヘルパ、`useAsyncResource<T>`共通フック、`useDeferredRefresh`/`useWatchedPath`に集約。

### 3-13. buildSystemPromptに約170行のプロンプト直書き / ai:chatの機能重複・脆い文字列パース `[electron]`
- 場所: `main.ts:3031-3199` (プロンプト)、`:3820-3965` (ai:chat)
- 問題: 長大な日本語プロンプトがコード埋め込みで編集・差分・i18n困難。ai:chatは`<think>`抽出を`includes`の逐次判定で行いネスト/部分タグに脆く、chat-server側の`extractReasoningMiddleware`と二重実装。
- 改善案: プロンプトを別ファイル化。chat-server経路に一本化しai:chatを廃止、または共通reasoning抽出へ集約。

## [低]

- **3-14** `[electron]` エラーを握り潰して[]/null/falseを返す箇所が多数(ログなし、権限エラーとnot-found区別不能) (`main.ts:542-545`他) → `{success,data?,error?}`統一。
- **3-15** `[electron]` Claude spawnロジックの重複 (`chat-server.ts:89-149`と`:395-445`) → `spawnClaudeCodeProcess`に集約。
- **3-16** `[electron]` パス許可判定が3箇所重複 (`main.ts:27-35/405-417/2934-2940`) → `isWithinAllowedRoots(p)`に統一。
- **3-17** `[electron]` checkClaudeCodeStatusが常にauthenticated=true(バイナリ存在のみ判定) (`main.ts:295-297`)。
- **3-18** `[electron]` `stringifyEnvFile`が改行/引用符を未エスケープでenv注入可能 (`main.ts:909-918`)。
- **3-19** `[electron]` 未発火イベントonAIThought(デッドコード) (`preload.ts:221-225`)。
- **3-20** `[chat]` 「stop→150ms sleep→save」が3箇所、`http://127.0.0.1:${port}`+認証ヘッダ組立が6箇所に複製 → `stopAndFlush()`/`chatServerFetch()`へ。
- **3-21** `[chat]` 死にコード・未使用props(`SlashCommandDropdown`の`onClose`、perfDiagnosticsのcutフラグ、LegacyTextareaChatInput、常にtrueの条件) (`ChatPanel.tsx:1143-1151/2756`他)。
- **3-22** `[skill-ui]` エディタタブ状態のprop drilling+watch初期化の暗黙結合(FileTreePanelのwatchにTabbedEditorPanelが便乗) (`SkillCentricLayout.tsx:1120-1141`)。
- **3-23** `[skill-ui]` ファイル種別ディスパッチの多段ネスト三項(約180行) (`TabbedEditorPanel.tsx:760-940`) → `getViewerType()`+switch。
- **3-24** `[skill-ui]` ツリーキャッシュ4層の整合性が手動管理で無効化漏れ(showDotFiles切替時など) (`FileTreePanel.tsx:57-321`)。
- **3-25** `[skill-ui]` 拡張子→言語/アイコンのマッピングが2箇所で二重管理&既にズレ(sass等) (`CodeEditor.tsx:61-101`, `FileIcons.tsx:241-317`)。
- **3-26** `[skill-ui]` `${color}20`形式のhexアルファ連結が12箇所以上に散在(6桁hex前提が型で守られない) → `withAlpha(color, 0.12)`util。
- **3-27** `[client]` appStoreがドメイン混在の神ストア、localStorage永続化が各setterに分散 (`appStore.ts:87-226`) → `persist`+`partialize`、slice分割。
- **3-28** `[build]` docker-composeとserver/Dockerfileで起動コマンド・git configが二重定義。
- **3-29** `[build]` フロントエンド基盤の分裂(admin React19/Tailwind4 vs client React18/Tailwind3)、**Electron 31.7.7はEOLでChromiumセキュリティパッチが届かない**(優先更新)。
- **3-30** `[admin]` ページ間のコピペ(認証ガード/ローディング/エラーUI×4ページ)、`virtual-`プレフィックスのサーバー内部表現への暗黙結合 → `<RequireAuth>`+共通フック、`isVirtual`フラグに昇格。
- **3-31** `[server]` マジックナンバー散在(ポート/TTL/上限/デバウンス)とshared型の日付表現不統一(`Date` vs `string`、JSON境界を越えられない)。

---

# 4. テスタビリティ・開発体制

## [高]

### 4-1. ✅ CIが存在せず、既存のサーバーテスト資産すら自動実行されない `[build]`
- 場所: リポジトリルートに`.github/`なし。`server/tests/`にsecurity 5本+integration 3本。
- 問題: path-traversal・authorization等のセキュリティテストが8ファイルあるのに実行はローカル手動のみ。lint・型検査・テストのどれもマージ前に強制されず、リグレッションは本番(=devサーバ)で発覚する。
- 改善案: GitHub Actionsで最低限 `server: vitest run` + `admin: next build`(型検査込み) + `client: tsc --noEmit` をPR必須チェックに。**最優先・投資対効果最大。**

### 4-2. ✅ 現状サーバーテストがレッド: path-traversalテストが実装でなく自前リテラルを検証 `[server]`
- 場所: `server/tests/security/path-traversal.test.ts:63-105` (検証済み: 1 failed | 82 passed)
- 問題: テストは`departments.ts`がASCII限定正規表現を含むと断言するが、実装は日本語許容の正規表現に変更済みで`toContain`が失敗。さらに悪意入力チェックは**ソースの`isValidFolderName`ではなくテスト内ハードコードの`pattern`変数**に対して行っており、実装を全く検証していない(偽りの安心)。
- 改善案: `isValidFolderName`を実装からexportしてテストで直接import検証。日本語許容後の境界を明示。

### 4-3. ✅ import時のIPC登録副作用でmain.tsが単体テスト不能 `[electron]`
- 場所: `client/electron/main.ts`全体(`ipcMain.handle`がトップレベル多数実行)
- 問題: モジュール読込だけでElectron `app`/`ipcMain`/`mainWindow`に依存・副作用が走り、Electronランタイム無しでロードできない。純粋ロジック(sync競合解決、sparse調整、env/frontmatter解析)にテストを書けない。
- 改善案: 純粋関数をElectron非依存モジュールへ抽出(`parseEnvFile`/`stringifyEnvFile`/`parseSkillFrontmatter`/`findNestedGitRepos`/`applySparseSelection`等)。ハンドラは`register*(deps)`でDI化。

### 4-4. ✅ git-http CGI・pre-receiveフック・ファイル操作の挙動テストが皆無 `[server]`
- 場所: `server/tests/`全般(`security/*`は`readFileSync`+正規表現の静的grepのみ)
- 問題: 同期/共有の中核であるgit-http.ts(340行のCGI)、pre-receive-hook.sh(秘密/gitlink/winpath検知)、departmentsのclone/commit/pushが一度も実行されない。フックのルートコミット未走査バグ(1-9)はまさに無テストゆえに潜在化していた。
- 改善案: 一時bareリポジトリでフックを実行する結合テスト(秘密混入push拒否、ルートコミット全走査、winpath拒否)とgit-httpの最小E2E。

## [中] (抜粋)

### 4-5. ✅ admin/clientはテスト0件、testスクリプトすら無い `[build]`
- 場所: `admin/package.json`, `client/package.json`(test scriptなし、`*.test.*`が0件)
- 問題: `apiClient`のエラー処理、`isValidFolder`正規表現(CLAUDE.md命名規則と同期必要)、招待フロー、diff解析・.envパース・パス処理など、単体テストが容易で壊れると痛い箇所が無防備。clientにはESLint(`react-hooks/exhaustive-deps`)もなく、本レビューのstale closure群を機械検出できない。
- 改善案: admin/clientにvitest(+RTL)を導入し、`api.ts`/`isValidFolder`/auth-contextから着手。clientにESLint導入。

### 4-6. ✅ 型検査が通常運用で一度も走らない(走らせると壊れている) `[build]` `[admin]`
- 場所: `admin/package.json`(typecheckなし、デプロイは`next dev`)、`client/package.json:12`(typecheckはbuild経由のみ)
- 問題: adminの型検査は`next build`時のみだがデプロイは`next dev`なので型エラーが本番到達。素の`tsc --noEmit`はstale成果物`.next/types/validator.ts`で失敗する(検証済み)。
- 改善案: 各パッケージに`typecheck`スクリプト追加、rootに`pnpm -r typecheck`を用意してCIに。

### 4-7. ✅ Dockerビルドの依存解決がlockfileに従わず再現性がない `[build]`
- 場所: `server/Dockerfile`(`npm install`)、`admin/Dockerfile:9-13`(`--frozen-lockfile`なし、pnpmバージョン未ピン)
- 問題: serverイメージはpnpm-lock.yamlを無視してnpmがcaret範囲の最新を取り、ローカルと本番でバージョンが食い違い得る。
- 改善案: `corepack`(pnpm固定)+`pnpm install --frozen-lockfile`に統一。

### 4-8. 純粋ロジックがコンポーネント/ハンドラに埋没してテスト不能(横断) `[chat]` `[skill-ui]` `[client]`
- 場所: メッセージ変換・履歴グルーピング・画像バリデーション(`ChatPanel`)、merge/diff/findText/detect/emailToHash(`MarkdownReview`)、parseDiff/.envパース/URL正規化/isReviewFile/部署走査(`DiffViewer`/`SettingsPanel`/`ServerSetupScreen`/`SyncPreviewDialog`/`CompanySelector`)、generateFolderName/formatDate/groupSkills/getLanguageExtension(skill-ui各所)
- 問題: 入出力が明確な純関数なのに非exportでコンポーネント内にあり、危険な仕様(自動削除条件・マージ規則・2MB/4枚制限・フォルダ名正規化)が描画経由でしか検証できない。
- 改善案: `lib/`配下へ純関数抽出+export、Vitestでテーブル駆動テスト。

### 4-9. window.electronAPI / fetch直叩きでモック境界がない(横断) `[chat]` `[skill-ui]` `[client]`
- 場所: ChatPanel内に`window.electronAPI.*`約15箇所+`fetch`6箇所、skill-ui/フック全般、`useDepartments`/`useSkills`/`useSparseCheckout`
- 問題: コンポーネント/フックテストにグローバル600行APIの丸ごとスタブが必要で、URL組立・認証ヘッダもテスト不能なまま複製されている。
- 改善案: `services/chatServerClient.ts`(serverInfo注入)・`lib/ipc.ts`(IPC facade)・`{readFile,writeFile,...}` fsアダプタを作り、コンポーネントはそれだけに依存。

### 4-10. ✅ サーバーの認可テストに穴・auth層が全面モックで結合未検証 `[server]`
- 場所: `tests/integration/authorization.test.ts:156-161`(git.tsはDELETEのみ検証)、`tests/integration/*.test.ts:10-17`(`vi.mock('../../src/lib/auth')`)
- 問題: git.tsのPOST/GET/GET:companyIdのメンバーシップ強制が未検証(実装の認可漏れをテストも見逃し)。全結合テストがauthをモックするためgit-httpのBasic Auth照合やBetter Auth連携が一切実行されない。
- 改善案: 非メンバーのアクセスが403/404になるケース追加(実装修正とセット)。auth.sqliteに実セッションを挿入する実経路テスト。

## [低]

- **4-11** `[electron]` sync競合解決・sparse調整・path検証にテストがない(データ破損直結) (`main.ts:1873-2499/2704-2745`)。
- **4-12** `[electron]` chat-tools/chat-serverがプロセス・SDKと密結合でDIなし、`startChatServer`が実ポートbind (`chat-tools.ts:88-211`, `chat-server.ts:167-730`)。
- **4-13** `[skill-ui]` `loadReviews`の削除/orphan化ポリシーがI/Oと不可分 → `reconcileReviews(reviews, docContent)`純関数に抽出。
- **4-14** `[skill-ui]` ToolsTabのプロセス起動/停止ロジックがUI直書き → `useToolRunner`フックへ。
- **4-15** `[skill-ui]` `commitCache`がモジュールレベル可変Map+`Date.now()`直参照でテスト間リーク (`CommitHistoryPanel.tsx:33-53`)。
- **4-16** `[client]` App.tsxの復元ロジックがcomponent内密結合、`safeReadLastCompany`の検証が不十分 → `restoreLastCompany(userId, deps)`純関数に。
- **4-17** `[client]` storeのアクションがDOM操作・IPC・i18n副作用を内包しテスト分離できない (`appStore.ts:190-233`)。
- **4-18** `[build]` root `build`がelectron-builderを含み検証用途に使えない、sharedのbuild成果物は誰も消費しない → 検証用と成果物ビルドを分離。

---

## 付録: 再検証した主要項目 (✅マーク)

オーケストレーターが実コードまたは実行で確認した項目:

- `.env`が`.gitignore`自動追加対象外 (essentialPatternsは`.backups/` `.workspace/` `node_modules/`のみ) → **秘密漏洩リスク実在**
- `getChatHistoryPath`のcompanyIdが無検証 → path traversal実在
- `tools:start`が`validatePath`なしで`npm install` → RCE経路実在
- git:syncロックのawait→setの非アトミック性 → race実在
- `git.ts`のGET/POST `/repos`等にメンバーシップ検証なし (認可はDELETEのみ) → 認可漏れ実在
- 招待トークンがサインアップ時にUPDATEされない → 無制限アカウント作成実在
- pre-receiveがルートコミットで空走査 (`diff-tree`に`--root`なし) → 初回push秘密未検査実在
- `commitAndPush`がpush失敗を黙殺 → DB/リポジトリ乖離実在
- `me.ts` PATCHが`// TODO`スタブ → 永続化なし実在
- ChatPanel早期return後の`useState` → Hooks違反実在
- `server/shared`が絶対パスsymlink → 他マシンで壊れる実在
- `setWindowOpenHandler`不在 (contextIsolation/nodeIntegrationは適切) → 外部リンク問題実在
- `npx vitest run` → **1 failed | 82 passed** (path-traversal.test.ts) → テストレッド実在

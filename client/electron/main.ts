import { ConsultationReferences } from './consultations/service'
import { recoveryContext } from './handoff/recovery-context'
import { AgentInteractions } from './agent-interactions'
import { getCodexStatus } from './agents/codex'
import { registerVoiceInput } from './voice-input'
import { app, BrowserWindow, ipcMain, net as electronNet, protocol, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import path from 'path'
import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'

import { startChatServer, type ChatServerConfig } from './chat-server'
import { createGitSync } from './sync/git-sync'
import { createMessageBoxSyncDialog } from './sync/message-box-dialog'
import { createFetchSyncServerApi } from './sync/server-api'
import { notDownloadedFolders } from './sync/not-downloaded'
import { createCompanyFilesApi } from './company-files/api'
import { companyFilesInstructions, createCompanyFileTools } from './company-files/tools'
import { localFileTarget } from './local-file-protocol'
import { HandoffStore } from './handoff/store'
import { HandoffService } from './handoff/service'
import { writeClaudeHandoff } from './handoff/claude'
import { writeCodexHandoff } from './handoff/codex'
import { ChatHistoryStore } from './chat-history-store'
import { normalizePermissionMode } from '../shared/permission-mode'
import { BUILD_INFO, installServerFetchIdentity } from './client-identity'
import { createWriteAccessStore } from './write-access-store'
import { createPrivateFoldersApi } from './private-folders-api'
import { AllowedRoots, type ValidateOptions } from './allowed-roots'
import { typedIpc } from './ipc/registrar'
import { createConfigStore } from './services/config-store'
import { createShellEnvironment } from './services/shell-env'
import { createClaudeCli } from './services/claude-cli'
import { createMessageBoxHost, createWindowPort, desktopShell } from './electron-adapter'
import { createSession } from './services/session'
import { registerAuthIpc } from './features/auth/ipc'
import { registerChatHistoryIpc } from './features/chat-history/ipc'
import { createToolApprovals, registerAgentInteractionsIpc } from './features/agent-interactions/ipc'
import { registerSettingsIpc } from './features/settings/ipc'
import { registerEnvIpc } from './features/env/ipc'
import { registerBackupsIpc } from './features/backups/ipc'
import { registerFsIpc } from './features/fs/ipc'
import { registerSyncIpc } from './features/sync/ipc'
import { registerSkillsIpc } from './features/skills/ipc'
import { registerToolsIpc } from './features/tools/ipc'
import { registerCompanySetupIpc } from './features/company-setup/ipc'
import { registerDownloadChoicesIpc } from './features/download-choices/ipc'
import { registerPrivateFoldersIpc } from './features/private-folders/ipc'
import { createPrivateFolderGuards } from './features/private-folders/guards'
import { registerGitHistoryIpc } from './features/git-history/ipc'
import { createAppGit } from './services/app-git'
import { createCommitMessages } from './services/commit-messages'

// Every channel below is checked against the IPC contract (shared/ipc-contract.ts).
const ipc = typedIpc<IpcMainInvokeEvent, IpcMainEvent>(ipcMain)

// Allowed directory roots for file system access control
// Paths are added when the user selects a directory via dialog or sets up a
// company folder. A path must be inside one by name AND by its real location
// (symbolic links resolved): ./allowed-roots.ts.
const allowedRoots = new AllowedRoots()

/**
 * Validate that a path is within an allowed directory, links resolved.
 * Prevents path traversal (and symlink escapes) from the renderer process.
 * `followFinal: false` judges the entry itself (delete / rename source).
 */
function validatePath(inputPath: string, options?: ValidateOptions): string {
  return allowedRoots.validate(inputPath, options)
}

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
// Events to the window (features/ports.ts WindowPort).
const appWindow = createWindowPort(() => mainWindow)
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
})

// Settings (<userData>/config.json), the environment for spawned processes,
// and the member's Claude Code CLI (electron/services/).
const config = createConfigStore(() => path.join(app.getPath('userData'), 'config.json'))
const shellEnv = createShellEnvironment()
const claudeCli = createClaudeCli()

// Skills and their web-app tools (features/skills, features/tools).
const skills = registerSkillsIpc(ipc, { paths: allowedRoots })
const tools = registerToolsIpc(ipc, { paths: allowedRoots, shellEnv, shell: desktopShell })

function createWindow() {
  const disableElectronSpellcheck =
    process.env.ELECTRON_DISABLE_SPELLCHECK === '1' ||
    process.env.ELECTRON_DISABLE_SPELL_CHECKING === '1'

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Reversible A/B test switch for input lag diagnosis.
      spellcheck: !disableElectronSpellcheck,
      // Required for the in-iframe Chromium PDF Viewer to render `blob:` PDFs in
      // packaged builds. Without this, dev (HTTP origin) happens to work but the
      // production file:// origin blocks the embedded PDF viewer.
      plugins: true,
    },
  })

  // Fully disable spell checker to prevent dictionary loading overhead (especially for Japanese IME)
  mainWindow.webContents.session.setSpellCheckerLanguages([])

  // Inject DocBase cookie for image.docbase.io requests (fixes 403 on DocBase images)
  const appConfig = config.load()
  if (appConfig.docbaseCookie) {
    const docbaseCookie = appConfig.docbaseCookie
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://image.docbase.io/*'] },
      (details, callback) => {
        details.requestHeaders['Cookie'] = docbaseCookie
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    // DevTools disabled for performance testing - uncomment below line to enable
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// Chat server info (shared between app.whenReady and IPC handler)
let chatServerInfo: { port: number; authToken: string } | null = null

// Register custom protocol for serving local files (images etc.)
// Must be called before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-file', privileges: { stream: true, supportFetchAPI: true } },
])

// IPC handler for renderer to request chat server info on demand
ipc.handle('chat-server:getInfo', () => {
  return chatServerInfo
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// On quit: stop the skill tools (the company watchers close in their own handler, registered below).
app.on('before-quit', () => tools.stopAll())

registerEnvIpc(ipc, { paths: allowedRoots })

registerSettingsIpc(ipc, { config, claudeCli, codexStatus: () => getCodexStatus(shellEnv.env()) })

const agentInteractions = new AgentInteractions((owner, event, request) => {
  const target = mainWindow?.webContents
  if (target && !target.isDestroyed() && target.id === owner) target.send(`agent-interaction:${event}`, request)
})
// The send stays unguarded, as it always was: a destroyed window rejects the approval.
const toolApprovals = createToolApprovals(request => mainWindow?.webContents.send('tool-approval-request', request))
registerAgentInteractionsIpc(ipc, { interactions: agentInteractions, approvals: toolApprovals })

// Local history stays in the existing per-device userData directory.
const localHistoryStore = new ChatHistoryStore(path.join(app.getPath('userData'), 'chat-history'))
const handoffStore = new HandoffStore(path.join(app.getPath('userData'), 'chat-handoffs'), localHistoryStore)
const handoffs = new HandoffService(localHistoryStore, handoffStore, async (provider, request) => {
  const cwd = path.join(app.getPath('userData'), 'handoff-worker')
  fs.mkdirSync(cwd, { recursive: true })
  const input = { ...request, cwd, env: shellEnv.env() }
  return provider === 'claude-code' ? writeClaudeHandoff({ ...input, cli: claudeCli.path() }) : writeCodexHandoff(input)
}, (companyId, sessionId) => appWindow.send('handoff:changed', { companyId, sessionId }))
try { handoffStore.cleanupDeleted() } catch { console.warn('[handoff] Startup cleanup deferred: history unavailable') }
app.on('before-quit', () => handoffs.dispose())
// History writes are coalesced and asynchronous; whatever is still pending is written now.
app.on('will-quit', () => localHistoryStore.flushSync())
const chatHistory = registerChatHistoryIpc(ipc, { history: localHistoryStore, handoffs, window: appWindow })

// Server API URL - read from config.json (set during first-launch setup) with env fallback
function getServerApiUrl(): string {
  return config.serverUrl()
}

// Every fetch() to the server's origin carries X-ACB-Client-Version /
// X-ACB-Client-Platform, so the server knows which build each member runs.
installServerFetchIdentity(getServerApiUrl)
console.log(`[client-identity] build ${BUILD_INFO.version} (built ${BUILD_INFO.builtAt})`)

// The member's session with the server (cookies, in memory only).
const session = createSession()

// Per-folder write access of the signed-in member (shared/write-access.ts).
// The renderer asks when it opens a company and gets writeAccess:changed
// broadcasts after that; the chat refreshes it per turn, sync after success.
const writeAccessStore = createWriteAccessStore({
  baseUrl: getServerApiUrl,
  cookies: session.cookies,
  onChange: (companyId, access) => appWindow.send('writeAccess:changed', { companyId, access }),
})
// The chat AI's read-only company files (company-files/): the session stays
// here in the main process; answers are cached briefly per member.
const companyFilesApi = createCompanyFilesApi({ baseUrl: getServerApiUrl, cookies: session.cookies, log: console })

registerAuthIpc(ipc, {
  session,
  serverUrl: getServerApiUrl,
  onSignedOut: () => {
    writeAccessStore.clear()
    companyFilesApi.clear()
  },
})

// The app's git (binary, credentials, guarded configuration) and sync's
// commit messages (electron/services/).
const appGit = createAppGit({ token: session.gitToken, appGitDir: () => path.join(app.getPath('userData'), 'git') })
const createGit = appGit.create
const commitMessageGenerator = createCommitMessages({
  config,
  claudeCli,
  shellEnv,
  cwd: () => path.join(app.getPath('userData'), 'commit-message'),
})
const generateCommitMessage = commitMessageGenerator(createGit)

// The working tree and its history for the sync preview, the diff views,
// the search tab and Cmd+P (features/git-history).
registerGitHistoryIpc(ipc, { paths: allowedRoots, git: appGit, commitMessagesFor: commitMessageGenerator })

// git:sync lives in ./sync/git-sync.ts (testable without Electron — see
// tests/sync-harness). This wires the app's git, dialogs and server API in.
const gitSync = createGitSync({
  createGit,
  dialog: createMessageBoxSyncDialog(createMessageBoxHost(() => mainWindow)),
  api: createFetchSyncServerApi({ baseUrl: getServerApiUrl, cookies: session.cookies }),
  generateCommitMessage,
  now: () => new Date(),
  platform: process.platform,
  log: console,
})

registerSyncIpc(ipc, { paths: allowedRoots, gitSync, writeAccess: writeAccessStore })

// Private folders (stage 3c): the 「新しいフォルダ…」 dialog and the lock
// icons; the guards the chat and the file operations ask (features/private-folders).
const privateFoldersApi = createPrivateFoldersApi({ baseUrl: getServerApiUrl, cookies: session.cookies })
const privateFolderGuards = createPrivateFolderGuards({ api: privateFoldersApi, pathChecker: gitSync.pathChecker })
registerPrivateFoldersIpc(ipc, { paths: allowedRoots, api: privateFoldersApi, guards: privateFolderGuards })

// The company folder on disk (features/fs): file tree, editor, watchers.
const files = registerFsIpc(ipc, {
  paths: allowedRoots,
  shell: desktopShell,
  window: appWindow,
  reservedRefusal: absPath => privateFolderGuards.reservedRefusal(absPath),
  // A skill the AI (or anything else) created, changed or removed is scanned
  // afresh by the next skills:list.
  onFileChanges: changes => skills.invalidateForChanges(changes),
})
app.on('before-quit', () => files.closeWatchers())

// Setting a company folder up, and what this computer downloads
// (features/company-setup, features/download-choices).
registerCompanySetupIpc(ipc, {
  paths: allowedRoots,
  appGit,
  session,
  serverUrl: getServerApiUrl,
  userDataDir: () => app.getPath('userData'),
})
registerDownloadChoicesIpc(ipc, { paths: allowedRoots, appGit, session, serverUrl: getServerApiUrl, privateFolders: gitSync })

registerBackupsIpc(ipc, { paths: allowedRoots, shell: desktopShell })

// Default system prompt with thinking instructions
const DEFAULT_SYSTEM_PROMPT = `あなたは会社の業務をサポートするAIアシスタントです。丁寧に日本語で回答してください。

重要: 複雑な質問や分析が必要な場合は、まず<think>タグ内で思考過程を示してください。
思考には以下を含めてください：
- 質問の分析
- 考慮すべきポイント
- 解決へのアプローチ

例:
<think>
ユーザーは○○について質問しています。
これを答えるには、△△と□□を考慮する必要があります。
まず△△について検討し、次に□□について...
</think>

実際の回答は<think>タグの外に記述してください。
シンプルな挨拶や短い質問には思考は不要です。`

// Build system prompt with working directory context
function buildSystemPrompt(workingDirectory?: string): string {
  let prompt = DEFAULT_SYSTEM_PROMPT

  if (workingDirectory) {
    prompt += `

## 作業ディレクトリ
あなたの作業ディレクトリは「${workingDirectory}」です。
ファイルの作成・編集・読み取りはすべてこのディレクトリ内で行ってください。
相対パスを使う場合は、このディレクトリを基準にしてください。

このディレクトリ内には部署ごとのフォルダ（sales, hr, accounting, contents, development, general）があり、
各フォルダにはAGENT.mdファイルにそのエージェントの役割が定義されています。`
  }

  // Add skill structure rules
  prompt += `

## スキル作成ルール

ユーザーが「スキルを作成して」「新しいスキルを追加して」などと言った場合は、以下のルールに従ってスキルを作成してください。

### 設計哲学：Progressive Disclosure（段階的開示）

スキルは3層構造で設計する。**コンテキストウィンドウは公共財**であり、本当に必要な情報だけを含める。

| 層 | 内容 | 目安 |
|---|------|------|
| Layer 1 | frontmatter（name, description） | 〜100語、トリガー判定用 |
| Layer 2 | SKILL.md本文 | <5000語、実行時にロード |
| Layer 3 | references/, scripts/ | 必要時のみ参照 |

**重要**: 詳細な仕様書、API定義、長いドキュメントはSKILL.md本文ではなく \`references/\` フォルダに分離する。

### スキルのディレクトリ構造

\`\`\`
.claude/skills/{folder-name}/
├── SKILL.md          # スキル定義ファイル（必須）
├── rules/            # ルールファイル格納フォルダ（必須、空でも作成）
├── references/       # 参考資料格納フォルダ（必須、空でも作成）
├── scripts/          # スクリプト格納フォルダ（必須、空でも作成）
└── tools/            # Webアプリツール格納フォルダ（必須、空でも作成）
\`\`\`

### フォルダ名の命名規則（重要）

- **英小文字で始まる**
- **使用可能文字**: 英小文字(a-z)、数字(0-9)、ハイフン(-)、アンダースコア(_)
- **日本語は使用不可**
- **最大50文字**

例: \`create-proposal\`, \`monthly-report\`, \`customer_analysis\`
NG例: \`提案書作成\`, \`Create Proposal\`, \`123-skill\`

### SKILL.mdのフォーマット

\`\`\`markdown
---
name: スキル名（日本語OK）
description: スキルの説明（1-2文、このスキルが何をするか簡潔に）
---

# スキル名

## Overview（概要）
このスキルが何を実現するか、1-2段落で説明。

## When to Use（使うべき場面）
- このスキルが適している状況を箇条書きで列挙
- 具体的なユースケースを示す

## When NOT to Use（使うべきでない場面）
- このスキルでは対応できないケース
- 代わりに使うべきスキルや方法を示す
- 例: 「カレンダー予定の登録 → Googleカレンダースキルを使用」

## 前提条件
- 必要な設定、認証情報、ツール
- 例: 「Slack APIトークンが必要」

## AIへの指示

このスキルを実行するときにAIが従うべき詳細な指示。
- 具体的な手順
- 出力フォーマット
- 品質基準

## 安全ルール

**重要**: お金、データ、外部送信が絡む操作には必ず記載。
- 確認が必要な操作（例: 「送信前に必ずユーザーに確認」）
- 禁止事項（例: 「本番データを削除しない」）
- エラー時の対応

## 参考資料

references/ フォルダ内のファイルを参照する場合はここに記載。
詳細な仕様書、API定義、長いドキュメントはreferences/に格納し、
必要に応じて「references/api-spec.md を参照」のように指示する。
\`\`\`

### 制約レベルの使い分け

| レベル | 用途 | SKILL.mdでの書き方 |
|--------|------|-------------------|
| テキスト指示 | 柔軟なタスク | 「丁寧な文体で」「簡潔に」 |
| 擬似コード | パターンあり＋変動 | 処理の流れを箇条書きで |
| scripts/ | 一貫性必須の操作 | スクリプトファイルに分離 |

### スキル作成時の手順

1. ユーザーの要望をヒアリング（何を自動化したいか）
2. フォルダ名を決める（英数字のみ、内容を表す名前）
3. スキルディレクトリを作成
4. 必須サブディレクトリ（rules/, references/, scripts/, tools/）を作成
5. SKILL.mdを上記フォーマットで作成
6. 必要に応じてreferences/に詳細資料を追加

### スキル作成後の報告

作成後、以下を報告：
- スキル名とフォルダ名
- 概要（何ができるか）
- 使い方の例
- 追加で設定が必要なこと（あれば）`

  return prompt
}

// Startup runs last, once every store and service above is initialised: the
// chat server config below captures them, and keeping the use after the
// declaration makes no-use-before-define (TDZ) hold by construction.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  registerVoiceInput(claudeCli.path, shellEnv.env, () => ({ authMode: config.authMode(), apiKey: config.load().anthropicApiKey }))
  // Handle local-file:// protocol to serve local files (restricted to allowed directories)
  // `?v=<n>` (a per-path version the renderer bumps on file events) is dropped
  // before resolving; responses are never cached, so a replaced file shows.
  protocol.handle('local-file', async (request) => {
    const target = localFileTarget(request.url, allowedRoots)
    if (!target.ok) {
      return new Response(target.status === 403 ? 'Forbidden: path is outside allowed directories' : 'Bad request', { status: target.status })
    }
    // Inside by name; a link there must not lead out of the company folder.
    let resolved: string
    try {
      resolved = validatePath(target.path)
    } catch {
      return new Response('Forbidden: path is outside allowed directories', { status: 403 })
    }
    const response = await electronNet.fetch(pathToFileURL(resolved).toString())
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  })
  // Start embedded Hono chat server
  try {
    const serverConfig: ChatServerConfig = {
      getAuthMode: () => config.authMode(),
      getApiKey: () => config.load().anthropicApiKey,
      // Unset → 'auto'. A mode the user saved explicitly is kept as-is.
      getPermissionMode: () => normalizePermissionMode(config.load().permissionMode),
      isClaudeCodeAuthenticated: claudeCli.isAuthenticated,
      getClaudeCodeCliPath: claudeCli.path,
      getShellEnv: shellEnv.env,
      buildSystemPrompt,
      onChatActivity: (token, active) => handoffs.setBusy(token, active),
      getWriteGuard: async (companyId, root) => {
        const [access] = await Promise.all([
          writeAccessStore.refresh(companyId, { timeoutMs: 3000 }),
          privateFolderGuards.refreshReadable(companyId, 3000),
          privateFolderGuards.refreshAuthority(companyId, 3000),
        ])
        if (!access) console.warn(`[write-access] ${companyId}: unknown at chat start; edits to read-only folders are not blocked in the chat`)
        // getAccess reads the live cache, so a refresh during a long chat applies at once.
        return {
          root,
          getAccess: () => writeAccessStore.get(companyId),
          getNotDownloaded: () => notDownloadedFolders(root),
          getPrivateFolders: () => privateFolderGuards.readable(companyId),
          getInstructionAuthority: () => privateFolderGuards.authority(companyId),
          getPrivateFolderView: () => privateFolderGuards.guardView(root),
        }
      },
      createCompanyFiles: (companyId, root, signal) => {
        let notDownloaded: string[] = []
        try { notDownloaded = root ? notDownloadedFolders(root) : [] } catch { /* unknown: the instructions just do not list them */ }
        return {
          tools: createCompanyFileTools({ api: companyFilesApi, companyId, companyRoot: root, signal }),
          instructions: companyFilesInstructions(notDownloaded),
        }
      },
      createReferences: (company, id, signal) => new ConsultationReferences(localHistoryStore, handoffStore).forTurn(company, id, signal),
      prepareRecovery: (company, id, messages) => recoveryContext(localHistoryStore.get(company, id), handoffStore.read(company, id), messages),
      onRecovery: (company, id, recovery) => handoffs.recordRecovery(company, id, recovery),
      persistAgentSession: (company, id, session) => {
        if (!localHistoryStore.patch(company, id, { agentSession: session, claudeSessionId: session.providerId === 'claude-code' ? session.id : '' })) throw new Error('相談が削除されたため引き継ぎを中止しました。')
        chatHistory.changed({ companyId: company, sessionId: id, kind: 'patch' })
      },
      requestInteraction: (request, appSessionId, signal) => {
        const owner = mainWindow?.webContents
        if (!owner || owner.isDestroyed()) return Promise.resolve({ cancelled: true })
        const ownerId = owner.id
        const close = () => agentInteractions.closeOwner(ownerId)
        owner.once('destroyed', close)
        owner.once('did-start-navigation', close)
        return agentInteractions.request(ownerId, appSessionId, request, signal).finally(() => {
          owner.removeListener('destroyed', close)
          owner.removeListener('did-start-navigation', close)
        })
      },
      requestToolApproval: (toolName, toolInput, toolUseId, appSessionId, reason) => toolApprovals.request(toolName, toolInput, toolUseId, appSessionId, reason),
    }
    const result = await startChatServer(serverConfig)
    chatServerInfo = { port: result.port, authToken: result.authToken }
  } catch (err) {
    console.error('[chat-server] Failed to start:', err)
  }

  createWindow()

  // Send chat server info to renderer once window is ready
  if (mainWindow && chatServerInfo) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow?.webContents.send('chat-server:info', chatServerInfo)
    })
  }
})

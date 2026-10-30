// Web-app tools inside skills (<…>/.claude/skills/<skill>/tools/<tool>):
// npm install + npm run dev|start on a free port (3100–3199), stop, and
// stop them all when the app quits; and opening links in the browser
// (http / https / mailto only).
//   tools:start, tools:stop, shell:openExternal

import { exec, spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { promisify } from 'util'
import { isExternalUrlAllowed } from '../../external-url'
import type { IpcRegistrar } from '../../ipc/registrar'
import type { ShellEnvironment } from '../../services/shell-env'
import type { DesktopShell, PathGuard } from '../ports'

const execAsync = promisify(exec)

// Running tool processes map
interface RunningTool {
  process: ChildProcess
  port: number
  toolPath: string
}

export interface ToolsDeps {
  paths: PathGuard
  shellEnv: ShellEnvironment
  shell: Pick<DesktopShell, 'openExternal'>
  /**
   * The key broker's variables for a tool of this company (key-broker.md K6):
   * a token for `tool:<path>` and the skill's department; {} when off.
   */
  brokerEnv?: (request: { companyId: string; conversationId: string; department: string | null }) => Promise<Record<string, string>>
}

export interface ToolsFeature {
  /** Kill every running tool (app quit) so dev servers don't outlive the app. */
  stopAll(): void
}

export function registerToolsIpc(ipc: IpcRegistrar, { paths, shellEnv, shell, brokerEnv }: ToolsDeps): ToolsFeature {
  const runningTools: Map<string, RunningTool> = new Map()

  // Start a tool (Web app)
  ipc.handle('tools:start', async (_, unsafeToolPath: string, startCommand: string = 'dev', companyId?: string) => {
    try {
      // A skill's tool folder (<…>/.claude/skills/<skill>/tools/<tool>) inside
      // a company, and one of the scripts the skills scan offers: this runs
      // `npm install` and `npm run` there.
      const toolPath = paths.validate(unsafeToolPath)
      const root = paths.rootOf(toolPath)
      const rel = root ? path.relative(root, toolPath).split(path.sep).join('/') : ''
      if (!/(^|\/)\.claude\/skills\/[^/]+\/tools\/[^/]+$/.test(rel)) return { success: false, error: 'Not a skill tool folder' }
      if (startCommand !== 'dev' && startCommand !== 'start') return { success: false, error: 'Unknown start command' }
      console.log('[tools:start] toolPath:', toolPath, 'command:', startCommand)

      // Check if already running
      if (runningTools.has(toolPath)) {
        const existing = runningTools.get(toolPath)!
        return { success: true, port: existing.port, alreadyRunning: true }
      }

      // Check if package.json exists
      const packageJsonPath = path.join(toolPath, 'package.json')
      if (!fs.existsSync(packageJsonPath)) {
        return { success: false, error: 'No package.json found' }
      }

      // Check if node_modules exists, if not run npm install
      const nodeModulesPath = path.join(toolPath, 'node_modules')
      if (!fs.existsSync(nodeModulesPath)) {
        console.log('[tools:start] Installing dependencies...')
        try {
          await execAsync('npm install', { cwd: toolPath, env: shellEnv.env() })
        } catch (installErr) {
          console.error('[tools:start] npm install failed:', installErr)
          return { success: false, error: `npm install failed: ${installErr instanceof Error ? installErr.message : installErr}` }
        }
      }
      console.log('[tools:start] node_modules exists:', fs.existsSync(nodeModulesPath))

      // Find an available port (start from 3100 to avoid conflicts)
      const basePort = 3100
      let port = basePort
      const maxPort = 3200

      const isPortInUse = async (p: number): Promise<boolean> => {
        return new Promise((resolve) => {
          const server = net.createServer()
          server.once('error', () => resolve(true))
          server.once('listening', () => {
            server.close(() => resolve(false))
          })
          server.listen(p)
        })
      }

      const waitForPort = (p: number, timeoutMs: number): Promise<boolean> => {
        return new Promise((resolve) => {
          const start = Date.now()
          const check = () => {
            const socket = new net.Socket()
            socket.once('connect', () => {
              socket.destroy()
              resolve(true)
            })
            socket.once('error', () => {
              socket.destroy()
              if (Date.now() - start > timeoutMs) {
                resolve(false)
              } else {
                setTimeout(check, 200)
              }
            })
            socket.connect(p, '127.0.0.1')
          }
          check()
        })
      }

      while (port < maxPort) {
        if (!(await isPortInUse(port))) break
        port++
      }

      if (port >= maxPort) {
        return { success: false, error: 'No available port found' }
      }
      console.log('[tools:start] Using port:', port)

      // Start the tool — write stdout/stderr to log file to avoid EBADF with pipes
      const logPath = path.join(toolPath, '.tool-output.log')
      const logFd = fs.openSync(logPath, 'w')
      const npmArgs = ['run', startCommand, '--', '--port', port.toString()]
      // shellEnv.env() handles the Windows Path-key replacement; PORT rides along
      // The key broker's token and relay URLs for this company's tool (they win over
      // the shell's variables of the same names). A tool running past the token's
      // lifetime (≤ 60 min) must be restarted to get a new one.
      const department = rel.startsWith('.claude/') ? null : rel.split('/')[0]
      const broker = typeof companyId === 'string' && companyId && brokerEnv
        ? await brokerEnv({ companyId, conversationId: `tool:${rel}`, department }).catch(() => ({}))
        : {}
      const toolEnv = { ...shellEnv.env(), ...broker, PORT: port.toString() }

      console.log('[tools:start] About to spawn: npm', npmArgs.join(' '))
      let childProcess: ChildProcess
      if (process.platform === 'win32') {
        // npm is npm.cmd on Windows: batch files cannot be spawned directly
        // (Node blocks it since CVE-2024-27980). Run through cmd.exe with
        // spaced args quoted — same pattern as the chat-server claude spawn.
        // No `detached`: tools:stop kills the tree from this cmd.exe pid via
        // taskkill /t.
        const quoted = ['npm', ...npmArgs]
          .map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
          .join(' ')
        childProcess = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', quoted], {
          cwd: toolPath,
          stdio: ['ignore', logFd, logFd],
          env: toolEnv,
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
      } else {
        // Force fork+exec instead of posix_spawn to avoid EBADF in Electron
        // (Electron's main process inherits Chromium FDs that lack FD_CLOEXEC)
        childProcess = spawn('npm', npmArgs, {
          cwd: toolPath,
          stdio: ['ignore', logFd, logFd],
          detached: true,
          env: toolEnv,
          ...(process.getuid ? { uid: process.getuid(), gid: process.getgid!() } : {}),
        })
      }
      console.log('[tools:start] Spawn succeeded, pid:', childProcess.pid)

      // Close the log fd in the parent (child has its own copy)
      fs.closeSync(logFd)

      // Store the running tool
      runningTools.set(toolPath, {
        process: childProcess,
        port,
        toolPath,
      })

      // Handle process exit
      childProcess.on('exit', (code) => {
        console.log(`Tool process exited with code ${code}:`, toolPath)
        runningTools.delete(toolPath)
      })

      childProcess.on('error', (err) => {
        console.error('Tool process error:', err)
        runningTools.delete(toolPath)
      })

      // Wait for the server to be ready (port listening), with timeout
      const isReady = await waitForPort(port, 5000)
      if (!isReady) {
        console.warn(`[tools:start] Port ${port} not ready after timeout, proceeding anyway`)
      }

      return { success: true, port, pid: childProcess.pid }
    } catch (error) {
      console.error('[tools:start] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Stop a running tool
  ipc.handle('tools:stop', async (_, toolPath: string) => {
    try {
      toolPath = typeof toolPath === 'string' ? path.resolve(toolPath) : ''
      const runningTool = runningTools.get(toolPath)
      if (!runningTool) {
        return { success: true, message: 'Tool was not running' }
      }

      // Kill the process
      if (runningTool.process.pid) {
        // On Windows, we need to kill the process tree
        if (process.platform === 'win32') {
          // Await taskkill so a failure is visible instead of silently
          // leaving an orphaned dev server holding files and the port
          await new Promise<void>((resolve) => {
            const tk = spawn('taskkill', ['/pid', runningTool.process.pid!.toString(), '/f', '/t'], { windowsHide: true })
            tk.on('exit', (code) => {
              if (code !== 0) console.warn(`[tools:stop] taskkill exited with ${code} for pid ${runningTool.process.pid}`)
              resolve()
            })
            tk.on('error', (err) => {
              console.error('[tools:stop] taskkill failed:', err)
              resolve()
            })
          })
        } else {
          // On Unix, kill the process group
          try {
            process.kill(-runningTool.process.pid, 'SIGTERM')
          } catch {
            runningTool.process.kill('SIGTERM')
          }
        }
      }

      runningTools.delete(toolPath)
      return { success: true }
    } catch (error) {
      console.error('Tool stop error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // Open URL in external browser
  ipc.handle('shell:openExternal', async (_, url: string) => {
    try {
      // Web pages and mail only: file:, javascript: or an app's own scheme
      // would open local files or launch other programs.
      if (!isExternalUrlAllowed(url)) return { success: false, error: 'このリンクは開けません（http / https / mailto のみ開けます）。' }
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  return {
    stopAll() {
      // Kill running skill tools so dev servers don't outlive the app.
      // Windows has no process groups/POSIX signals — kill the tree via taskkill.
      for (const [toolPath, tool] of runningTools) {
        const pid = tool.process.pid
        if (!pid) continue
        console.log('[before-quit] stopping tool:', toolPath)
        if (process.platform === 'win32') {
          try {
            spawn('taskkill', ['/pid', pid.toString(), '/f', '/t'], { windowsHide: true })
          } catch { /* best effort on quit */ }
        } else {
          try {
            process.kill(-pid, 'SIGTERM')
          } catch {
            try { tool.process.kill('SIGTERM') } catch { /* already gone */ }
          }
        }
      }
      runningTools.clear()
    },
  }
}

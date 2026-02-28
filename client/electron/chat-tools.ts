import { tool } from 'ai'
import { z } from 'zod'
import * as fs from 'fs/promises'
import * as path from 'path'
import { exec } from 'child_process'
import crypto from 'crypto'

// Approval callback type (optional, injected from chat-server)
export type RequestApproval = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
) => Promise<{ approved: boolean }>

// ============================================================================
// Path Validation
// ============================================================================

function validatePath(filePath: string, workingDirectory: string): string {
  const resolved = path.resolve(workingDirectory, filePath)
  if (!resolved.startsWith(workingDirectory + path.sep) && resolved !== workingDirectory) {
    throw new Error(`Access denied: path "${filePath}" is outside working directory`)
  }
  return resolved
}

// ============================================================================
// Output Truncation
// ============================================================================

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  const buf = Buffer.from(text, 'utf-8')
  const truncated = buf.subarray(0, maxBytes).toString('utf-8')
  return truncated + '\n... (truncated)'
}

// ============================================================================
// Tool Factory
// ============================================================================

const readFileSchema = z.object({
  path: z.string().describe('File path relative to working directory'),
})

const writeFileSchema = z.object({
  path: z.string().describe('File path relative to working directory'),
  content: z.string().describe('Content to write'),
})

const listDirectorySchema = z.object({
  path: z
    .string()
    .default('.')
    .describe('Directory path relative to working directory (default: ".")'),
})

const executeCommandSchema = z.object({
  command: z.string().describe('Shell command to execute'),
})

// ============================================================================
// Skill Tools (read-only, scoped to skill folder)
// ============================================================================

const readSkillFileSchema = z.object({
  path: z.string().describe(
    'File path relative to the skill folder. Examples: "rules/format-rules.md", "references/sample.csv"'
  ),
})

export function createSkillTools(skillFolderPath: string) {
  return {
    readSkillFile: tool({
      description:
        'Read a file from the current skill folder (rules/, references/, scripts/). ' +
        'Path is relative to the skill folder root.',
      inputSchema: readSkillFileSchema,
      execute: async ({ path: filePath }) => {
        const absPath = validatePath(filePath, skillFolderPath)
        const content = await fs.readFile(absPath, 'utf-8')
        return truncate(content, 50_000)
      },
    }),
  }
}

export function createFileSystemTools(workingDirectory: string, requestApproval?: RequestApproval) {
  return {
    readFile: tool({
      description:
        'Read the contents of a file at the given path (relative to the working directory).',
      inputSchema: readFileSchema,
      execute: async ({ path: filePath }) => {
        const absPath = validatePath(filePath, workingDirectory)
        const content = await fs.readFile(absPath, 'utf-8')
        return truncate(content, 50_000) // 50 KB limit
      },
    }),

    writeFile: tool({
      description:
        'Write content to a file at the given path (relative to the working directory). Creates parent directories if needed.',
      inputSchema: writeFileSchema,
      execute: async ({ path: filePath, content }) => {
        if (requestApproval) {
          const result = await requestApproval('writeFile', { path: filePath }, crypto.randomUUID())
          if (!result.approved) throw new Error('ユーザーにより拒否されました')
        }
        const absPath = validatePath(filePath, workingDirectory)
        await fs.mkdir(path.dirname(absPath), { recursive: true })
        await fs.writeFile(absPath, content, 'utf-8')
        return `File written: ${filePath}`
      },
    }),

    listDirectory: tool({
      description:
        'List files and directories at the given path (relative to the working directory). Hidden files (starting with .) are excluded.',
      inputSchema: listDirectorySchema,
      execute: async ({ path: dirPath }) => {
        const absPath = validatePath(dirPath, workingDirectory)
        const entries = await fs.readdir(absPath, { withFileTypes: true })
        const items = entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
          }))
        return JSON.stringify(items, null, 2)
      },
    }),

    executeCommand: tool({
      description:
        'Execute a shell command in the working directory. Use for build, test, or inspection tasks. Dangerous commands are blocked.',
      inputSchema: executeCommandSchema,
      execute: async ({ command }) => {
        if (requestApproval) {
          const result = await requestApproval('executeCommand', { command }, crypto.randomUUID())
          if (!result.approved) throw new Error('ユーザーにより拒否されました')
        }

        // Block dangerous command patterns
        const DANGEROUS_PATTERNS = [
          // Destructive file operations
          /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)/,  // rm with -f or --force
          /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+)/,             // rm with -r (recursive)
          /\bmkfs\b/,                                       // format filesystem
          /\bdd\s+if=/,                                     // disk dump
          /\b(chmod|chown)\s+(-R\s+)?[0-7]*\s+\//,         // chmod/chown on root paths
          // Fork bombs and resource exhaustion
          /:\(\)\s*\{/,                                     // bash fork bomb
          /\bfork\s*bomb\b/i,
          /while\s+true.*do/,                               // infinite loops
          // System destruction
          /\b(shutdown|reboot|halt|poweroff)\b/,
          /\binit\s+[06]\b/,
          /\bsystemctl\s+(stop|disable|mask)\b/,
          // Dangerous writes
          />\s*\/dev\/sd/,                                  // write to block devices
          />\s*\/etc\//,                                    // overwrite system config
          /\bcurl\b.*\|\s*(ba)?sh\b/,                      // pipe curl to shell
          /\bwget\b.*\|\s*(ba)?sh\b/,
          // Credential/key theft
          /\bcat\b.*\.(ssh|gnupg|aws|kube)/,               // read sensitive dirs
          /\bcp\b.*\.ssh\//,
          // Network exfiltration
          /\bnc\s+-[a-zA-Z]*l/,                            // netcat listen
          /\bsudo\b/,                                       // privilege escalation
          // Escape working directory via subshell
          /\bcd\s+\.\.\//,                                  // cd ../
          /\bcd\s+\//,                                      // cd to absolute path outside workdir
        ]

        const commandLower = command.toLowerCase()
        for (const pattern of DANGEROUS_PATTERNS) {
          if (pattern.test(commandLower)) {
            throw new Error(`Blocked: command matches dangerous pattern`)
          }
        }

        return new Promise<string>((resolve) => {
          exec(
            command,
            {
              cwd: workingDirectory,
              timeout: 30_000,
              maxBuffer: 1024 * 1024, // 1 MB
              env: { ...process.env, FORCE_COLOR: '0' },
            },
            (error, stdout, stderr) => {
              const out = truncate(stdout, 10_000) // 10 KB
              const err = truncate(stderr, 5_000) // 5 KB

              if (error) {
                resolve(
                  `Exit code: ${error.code ?? 1}\n` +
                    (out ? `stdout:\n${out}\n` : '') +
                    (err ? `stderr:\n${err}` : ''),
                )
              } else {
                resolve(out || '(no output)')
              }
            },
          )
        })
      },
    }),
  }
}

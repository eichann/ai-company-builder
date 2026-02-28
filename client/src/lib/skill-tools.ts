/**
 * Skill Tools - AI SDK Tool definitions for skill management
 *
 * These tools allow the AI to create and manage skills with proper validation.
 * The AI calls these tools, and they validate the input before executing.
 */

import { z } from 'zod'

// ============================================================================
// Schemas
// ============================================================================

/**
 * Schema for skill folder name
 * - Must start with lowercase letter or number
 * - Can contain lowercase letters, numbers, hyphens, underscores
 * - Max 50 characters
 */
export const skillFolderNameSchema = z
  .string()
  .min(1, 'Folder name is required')
  .max(50, 'Folder name must be 50 characters or less')
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'Folder name must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores'
  )

/**
 * Schema for SKILL.md frontmatter
 */
export const skillFrontmatterSchema = z.object({
  name: z.string().min(1, 'Skill name is required').max(100, 'Skill name must be 100 characters or less'),
  description: z.string().min(1, 'Description is required').max(500, 'Description must be 500 characters or less'),
})

/**
 * Schema for creating a new skill
 */
export const createSkillSchema = z.object({
  folderName: skillFolderNameSchema,
  name: z.string().min(1, 'Skill name is required'),
  description: z.string().min(1, 'Description is required'),
  instructions: z.string().min(1, 'Instructions are required'),
  rules: z.array(z.string()).optional().default([]),
  references: z.array(z.string()).optional().default([]),
})

export type CreateSkillInput = z.infer<typeof createSkillSchema>

/**
 * Schema for updating an existing skill
 */
export const updateSkillSchema = z.object({
  skillPath: z.string().min(1, 'Skill path is required'),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
})

export type UpdateSkillInput = z.infer<typeof updateSkillSchema>

/**
 * Schema for adding a rule to a skill
 */
export const addRuleSchema = z.object({
  skillPath: z.string().min(1, 'Skill path is required'),
  fileName: z
    .string()
    .min(1, 'File name is required')
    .regex(/^[a-z0-9][a-z0-9_-]*\.md$/, 'File name must be a valid markdown filename (e.g., my-rule.md)'),
  content: z.string().min(1, 'Rule content is required'),
})

export type AddRuleInput = z.infer<typeof addRuleSchema>

// ============================================================================
// Validation Functions
// ============================================================================

export interface ValidationResult {
  success: boolean
  errors: string[]
}

/**
 * Validate create skill input
 */
export function validateCreateSkill(input: unknown): ValidationResult {
  const result = createSkillSchema.safeParse(input)
  if (result.success) {
    return { success: true, errors: [] }
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  }
}

/**
 * Validate update skill input
 */
export function validateUpdateSkill(input: unknown): ValidationResult {
  const result = updateSkillSchema.safeParse(input)
  if (result.success) {
    return { success: true, errors: [] }
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  }
}

/**
 * Validate add rule input
 */
export function validateAddRule(input: unknown): ValidationResult {
  const result = addRuleSchema.safeParse(input)
  if (result.success) {
    return { success: true, errors: [] }
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  }
}

// ============================================================================
// SKILL.md Generator
// ============================================================================

/**
 * Generate SKILL.md content from validated input
 */
export function generateSkillMdContent(input: CreateSkillInput): string {
  const { name, description, instructions, rules } = input

  let content = `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## AIへの指示

${instructions}
`

  if (rules && rules.length > 0) {
    content += `
## ルール

${rules.map((rule) => `- ${rule}`).join('\n')}
`
  } else {
    content += `
## ルール

<!-- rules/ フォルダにルールファイルを追加してください -->
`
  }

  content += `
## 参考資料

<!-- references/ フォルダに参考資料を追加してください -->
`

  return content
}

// ============================================================================
// Tool Definitions for AI SDK
// ============================================================================

/**
 * Tool definitions to be used with AI SDK's streamText/generateText
 *
 * Usage:
 * ```typescript
 * import { tool } from 'ai'
 * import { createSkillSchema, validateCreateSkill, executeCreateSkill } from './skill-tools'
 *
 * const tools = {
 *   create_skill: tool({
 *     description: 'Create a new skill with SKILL.md and required directories',
 *     parameters: createSkillSchema,
 *     execute: async (params) => {
 *       const validation = validateCreateSkill(params)
 *       if (!validation.success) {
 *         return { success: false, error: validation.errors.join(', ') }
 *       }
 *       return executeCreateSkill(params, basePath)
 *     }
 *   })
 * }
 * ```
 */

export const toolDescriptions = {
  create_skill: {
    name: 'create_skill',
    description: `Create a new skill with SKILL.md and required directories (rules/, references/, scripts/, tools/).

IMPORTANT RULES:
- folderName must be alphanumeric with hyphens/underscores only (no Japanese characters)
- name can be in any language (displayed to users)
- description should be concise (1-2 sentences)
- instructions should be detailed and specific about what the AI should do`,
    parameters: createSkillSchema,
  },

  update_skill: {
    name: 'update_skill',
    description: 'Update an existing skill\'s SKILL.md content',
    parameters: updateSkillSchema,
  },

  add_rule: {
    name: 'add_rule',
    description: 'Add a rule file to a skill\'s rules/ directory',
    parameters: addRuleSchema,
  },
}

// ============================================================================
// Execution Functions (to be called from main process)
// ============================================================================

export interface ExecuteResult {
  success: boolean
  error?: string
  data?: unknown
}

/**
 * Execute create skill (called from main process with file system access)
 */
export async function executeCreateSkill(
  input: CreateSkillInput,
  basePath: string,
  fsApi: {
    createDirectory: (path: string) => Promise<void>
    writeFile: (path: string, content: string) => Promise<void>
    exists: (path: string) => Promise<boolean>
  }
): Promise<ExecuteResult> {
  const { folderName } = input
  const skillPath = `${basePath}/${folderName}`

  // Check if skill already exists
  if (await fsApi.exists(skillPath)) {
    return { success: false, error: `Skill folder already exists: ${folderName}` }
  }

  try {
    // Create skill directory
    await fsApi.createDirectory(skillPath)

    // Create subdirectories
    await fsApi.createDirectory(`${skillPath}/rules`)
    await fsApi.createDirectory(`${skillPath}/references`)
    await fsApi.createDirectory(`${skillPath}/scripts`)
    await fsApi.createDirectory(`${skillPath}/tools`)

    // Create SKILL.md
    const skillMdContent = generateSkillMdContent(input)
    await fsApi.writeFile(`${skillPath}/SKILL.md`, skillMdContent)

    return { success: true, data: { skillPath } }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    }
  }
}

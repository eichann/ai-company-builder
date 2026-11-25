// Codex's process-local overrides for a text-only job (one-shots, the second opinion, the Web reader, hand-off memos,
// chat titles): the shell, apply_patch, plugins, skills, MCP apps, memories… off; never the user's Codex configuration
// written or credentials copied. A leaf: codex.ts (titles) and codex-text.ts both read it.
const disabledFeatures = ['shell_tool', 'unified_exec', 'shell_snapshot', 'apply_patch_freeform', 'apps', 'plugins', 'remote_plugin', 'hooks', 'codex_hooks', 'plugin_hooks', 'memories', 'memory_tool', 'multi_agent', 'multi_agent_v2', 'collab', 'code_mode', 'js_repl', 'browser_use', 'computer_use', 'image_generation', 'imagegenext', 'view_image', 'skill_search', 'tool_search', 'request_permissions', 'request_permissions_tool', 'goals']

export const CODEX_TEXT_OVERRIDES = [
  ...disabledFeatures.map(name => `features.${name}=false`),
  'features.skip_host_skill_discovery=true', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'project_doc_max_bytes=0', 'web_search="disabled"', 'tools.update_plan.enabled=false',
  'tools.experimental_request_user_input.enabled=false', 'include_apps_instructions=false',
]

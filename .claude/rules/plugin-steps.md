---
paths:
  - "client/shared/ai-turn-steps/plugin.ts"
  - "client/electron/features/ai-turns/**"
  - "server/src/services/ai-runs.ts"
---

# A plugin's steps run as AI turns (stage 4a, lane C: C5)

Reserved for C5. A business plugin declares `steps` (target type and state, instructions, tools,
roles used); the AI turn of a record runs the step automatically with that step's ACB tools only
(not the member's own Claude settings, MCP or hooks). A step's version is fixed per record at its
first run (the shelf then keeps that version); the emergency stop overrides the fixed version.
Write the rules here as C5 builds them.

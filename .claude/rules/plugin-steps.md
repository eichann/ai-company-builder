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

Ready from C2 (`plugins.md` "Handing packages to the app"): the app keeps each listed package under
`<userData>/plugins/<id>@<version>/` (`pluginPackages.folderOf`); C5 binds
`createPluginDistribution`'s `pinnedVersions` (in `composition/plugins.ts`) with its stored pins
so a pinned older version stays listed and kept — the operator's stop still removes it.

Ready from C4 (`plugins.md` "The gate of a step's run"): claim a step's run as
`<pluginId>__<step>` (`parsePluginRunStep`; `AI_RUN_STEP_RE` allows 40 characters); the server then
lets its tokens call only that plugin's operations the step allows and the step's connector roles,
and `GET /api/records-ai/plugins` lists only those operations for such a token.

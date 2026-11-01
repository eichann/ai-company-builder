---
paths:
  - "client/shared/plugin-bridge.ts"
  - "client/src/features/plugins/**"
  - "client/electron/features/plugins/protocol.ts"
  - "server/src/routes/plugin-bridge.ts"
  - "server/src/services/plugin-bridge.ts"
---

# A plugin's screen in a frame and its bridge (stage 4b, lanes A and B: A5 / A6 / B6)

Reserved for A5, A6 and B6. A plugin's `ui/` runs in a frame served by `acb-plugin://` with a CSP
that allows no network; it never reaches `window.electronAPI` or storage. It talks only through
a narrow bridge handed over once; every bridge call is limited to the overlap of the person's
permission, what the company allowed and the operation's own scope (`via`). Approving and sending
happen only on the core app's cards. Write the rules here as these items are built.

---
paths:
  - "client/tests/ui/**"
  - "client/tests/*-ui.*"
  - "client/tests/perf/**"
  - "client/playwright.config.ts"
  - "client/scripts/check-bundle-size.mjs"
  - "client/tests/*.test.ts"
---

# Client tests: node tests, renderer UI tests, performance baselines

Run what you touched; CI runs the suites (macOS runners). Sync's harness: `sync-testing.md`.
IPC harness: `ipc-and-main-process.md`. Parity tests: `shared-core.md`. Full text:
`docs/architecture/testing.md` (internal).

## Node tests

`client/tests/*.test.ts` run with node:test via tsx: `cd client && npx tsx --test tests/<name>.test.ts`.
Pure logic belongs here. CI job "Client tests (macOS)" runs `npx tsx --test tests/*.test.ts`
plus two Swift tests (`audio-level`, `input-route`). macOS on purpose: the POSIX spawn wrappers
run `exec N>&-` through `/bin/sh`, which on Ubuntu is dash and fails on multi-digit fds.

## Renderer UI tests (Playwright)

The preview pages `client/tests/*-ui.html` (+ `.tsx`) render the real React components with the
preload API faked (`tests/ui/fixtures/electron-api.ts`: `installElectronAPI`, typed against
`Window['electronAPI']` from `electron/preload.ts`) and, for the chat, a faked chat server.
Playwright drives them in headless Chromium (`client/tests/ui/*.spec.ts`, CI "Renderer UI tests
(macOS)").

```bash
cd client
npx playwright install --only-shell chromium   # once per Playwright version
npx playwright test chat-panel         # one spec (all: ~40 s; builds, serves, runs)
npx tsc -p tests/ui                    # type-check specs + preview pages (CI does)
npx vite -c tests/ui/vite.config.ts    # look at a page: http://localhost:5174/tests/<name>-ui.html
```

- A UI spec pins only what a component split can break: rendering, events, focus, ARIA, what
  stays mounted. Assert through roles and text, not pixels (no snapshots); pure logic stays in
  node tests.
- The chat specs drive replies through `window.__acbChat` (`chat-header-ui.html?turn=manual`),
  the main screen through `window.__acbLayout` (`skill-layout-ui.html`). A new preview page gets
  a spec; `smoke.spec.ts` picks it up automatically.
- `playwright test` starts and stops `vite preview` itself (port 4179). `UI_TEST_REUSE=1` reuses
  one you started (rebuild after changes); stop it, and any `vite -c tests/ui/vite.config.ts`,
  when done.

## Performance baselines

`client/tests/perf/*.perf.test.ts` + `client/scripts/check-bundle-size.mjs`, CI job "Performance
baselines (macOS)" (not part of `tests/*.test.ts`). They hold earlier wins: one recursive watch
handle for a 15k-file company and a first file-tree view of one ~55 KB read (#151); search of
「の」 over ~6.5k files capped at 500 matches / < 1 MB, folder `git log` (#153); autosave of an
~8 MB history returning at once, summaries < 500 KB, the 564-message conversation rendering only
its latest window (#154); the renderer bundle ≤ 2.2 MiB JS.

- Budgets are ~10x a developer Mac (runners vary): they catch order-of-magnitude regressions,
  not drift. Each check prints `[perf] name=value unit (budget …)`; grep the job log for `[perf]`.
- Run one: `cd client && npx tsx --test tests/perf/git-search.perf.test.ts`; bundle:
  `npx vite build && node scripts/check-bundle-size.mjs`.
- Small-size behaviour (and the Myers diff timings) stays in the regular tests.

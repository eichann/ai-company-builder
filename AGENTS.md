# AGENTS.md

The project instructions live in [`CLAUDE.md`](CLAUDE.md) and the area rules in
[`.claude/rules/`](.claude/rules/). They apply to every coding agent, Codex included: read
`CLAUDE.md` first, and the matching rule file before changing an area. If this file and
`CLAUDE.md` disagree, `CLAUDE.md` wins.

The hard rules, in one line each:

- **Sync must never lose a member's work**: anything sync cannot resolve stops with local work intact.
- **The server is the authority**: client checks are for experience; the push checker and API decide.
- **Private folder names never leak** to someone who cannot read the folder (answers, errors, commits, `.gitignore`).
- **`shared/core` depends on nothing** (no Node built-ins, packages, Electron, React, database or git).
- **A test must guard something**, and each new guard is mutation-checked: remove or invert it and a test fails.
- **`docs/` is never committed**: this is a public (AGPL) repository; durable knowledge goes into the rule files.
- **The owner merges**: open a PR, wait for all CI checks; never merge, use admin overrides or enable auto-merge.

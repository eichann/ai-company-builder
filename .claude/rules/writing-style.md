---
paths:
  - "shared/core/writing-style.ts"
  - "shared/types/writing-style.ts"
  - "server/src/ports/sent-samples.ts"
  - "server/src/services/writing-samples.ts"
  - "server/src/services/google-writing.ts"
  - "server/src/routes/writing-samples.ts"
  - "server/tests/unit/writing-samples.test.ts"
  - "server/tests/unit/writing-style.test.ts"
  - "client/shared/writing-style.ts"
  - "client/electron/features/writing-style/**"
  - "client/tests/writing-style.test.ts"
  - "client/tests/writing-style-boundary.test.ts"
---

# 「返事の下書きを、わたしの書き方に合わせる」 (writing style, owner decision 2026-11-28)

When the member's AI drafts a reply, it is handed a short **summary of how the member writes** (書き方のまとめ): greeting,
closing, sentence length, politeness, frequent phrases, emoji, other habits — one shape for every tool
(`shared/core/writing-style.ts` `WritingStyle`). Made from the member's own newest sent messages (20 per tool), **kept only
on the member's PC**, never on the server, never handed to anyone else's AI or the company's.

## The core knows no tool

- A summary is kept per **connector id × audience** (身内 `inside` / よそ `outside`), at most one each (mail × 2, chat × 2
  today). An audience with fewer than `WRITING_STYLE_MIN_SAMPLES` (5) messages gets none; the **other audience of the same
  connector** stands in (`chooseWritingStyle`, `standIn`), never another connector's.
- The connector side is the optional **role capability** `sent_samples` (本人が送った文を読む) of the roles `mail` and `chat`
  (`shared/core/connector-roles.ts`, `connector-roles.md`): a connector declares it in its `RoleServing` and registers a
  `SentSamplesReader` (`server/src/ports/sent-samples.ts`) under its id — `recentSent` (the member's newest sent messages:
  text they wrote, time, 身内 / よそ) and `audienceOf` (a thread's other side). The core
  (`services/writing-samples.ts`) asks the role resolver which connector serves `mail` / `chat` now and uses its reader only
  when it declares the capability: another registered connector, one serving another company, one switched off or without
  the capability hands nothing.
- Gmail: `services/google-writing.ts` — the Sent label (a year back, the newest 40 looked at), the member's own words
  only (quoted conversation, a forwarded part, a signature and `>` lines cut: `ownWords`), machine / list mail and mail to
  nobody else left out; 身内 = every other address of the company's domains (`companyDomains`: the intake settings' and the
  members' own, never free mail; `inbox.internalDomains`). Only with the member's own 受信を読む (`gmail.readonly`, the
  `inbox` feature and both switches: the inbox source's `ready`, google-client's `scopeStop`) — **no new permission**.
- Slack: not yet (PR 2). Its `chat` serving declares no `sent_samples`, so a Slack thread's `writing` is null.
- Test `client/tests/writing-style-boundary.test.ts`: the core files name no tool and import no connector module
  (self-tested).

## Server (keeps nothing)

`GET /api/companies/:companyId/me/writing-sources` (`WritingSourcesView`: each connector serving a role with the capability
now, its label, whether the member's permission reads now) and `GET …/me/writing-sources/:connectorId/samples`
(`WritingSamplesView`, `no-store`; 404 `WRITING_SOURCE_NOT_FOUND`, 409 `WRITING_SOURCE_NOT_READABLE` — nothing read —,
503 `WRITING_SOURCE_UNAVAILABLE`). Session only (no AI route). Permission matrix rows; the connector id is in
`NOT_OBJECT_IDS` (the role resolver decides it per company). `ThreadView.writing` (`shared/types/threads.ts`, additive):
the key `{ connectorId, audience }` for a reply into that thread (`threads.ts` → `writingSamples.keyForThread`), null when
none fits. Nothing of a message is stored or logged (threads integration test greps every table and log line).

## The member's PC (`client/electron/features/writing-style/`)

- **Made by the member's own AI** (`summarize.ts`): `runOneShotText` with the member's agent and the registry's
  `tasks.writingStyle` (Claude Code `claude -p --model haiku` with no tools / settings / memory, Codex's text one-shot, the
  API key's `claude-haiku-5-5`); the messages of one audience as **one outside-text block** (`writingStyleInput`:
  `neutralizeOutsideText` per message, `wrapOutsideText`), the prompt says they are data; only the last `<writing_style>`
  JSON is taken and checked (`readWritingStyleAnswer` → `parseWritingStyle`: the three choices required, texts one line and
  cut, **anything personal dropped field by field** — an address, a phone number, a URL, a postal address, a name with an
  honorific or a title (山田部長); 皆様 / お客様 / ご担当者様 / 部長 / 仕様 stay — and so is a field that reads as an
  instruction (`findInstructionLikeText`) or names money or a secret (振込・口座・パスワード…): the summary is ACB's words
  to the drafting AI, so nothing of a message may pass as one). Never while an administrator stopped the AI.
- **Kept** in `<userData>/writing-style/<userId>/<companyId>.json` (owner-only, atomic): `enabled`, the summaries, a note.
  Another account or company reads another file. **Bound to the sign-in** (`session`: the session's cookies array, new at
  every sign-in): a build or a status read that saw another sign-in meanwhile — also the same account signed in again,
  A → B → A — writes and answers nothing. Kept across a sign-out like the consultations' history (per account);
  「消す」 removes the file, and a build started before it saves nothing (`generation`; 「作り直す」 then starts a new
  one). Made again when older than a month (`writingStyleStale`; looked at when a thread asks, at most every
  `REFRESH_RETRY_MS`), never over a summary the member corrected (`edited`). A connector no longer readable (409 / 404)
  loses its summaries; a passing failure (offline, 5xx, the AI not answering) keeps the ones there.
- **Used**: `inbox_read` (`features/inbox/tools.ts`, the AI's thread read before `mail_draft_create { interactionId }` —
  the inbox's triage and follow-up, a consultation about a 連絡) appends `writingStyleForAi` **after** the thread's
  outside-text block, as reference data, only while the member's check is on (`forTurn`, bound by `recordToolProviders`
  when the turn starts to the member and sign-in it is for: a later sign-in gets nothing through it).
  Not yet: a new mail (`mail_recipients` without a thread).
- IPC (main, the session stays there): `writingStyle:status` / `setEnabled` (on = build in the background) / `rebuild` /
  `update` (the member's correction, checked like the AI's) / `remove` (one, or all and the check off). The renderer's entry
  (the check on 「仕事の道具をつなぐ」 and in 設定 → 仕事の道具) comes with PR 2.

Tests: `server/tests/unit/writing-style.test.ts` (shape, personal details, stand-in, staleness),
`server/tests/unit/writing-samples.test.ts` (the role and capability only, readable before reading, Gmail's own words /
audience / machine mail / max), `server/tests/integration/threads.test.ts` (the samples route end to end against the fake
Google: own words, 身内 / よそ, 受信を読む off → nothing sent to Google, the key on a mail thread, nothing kept),
`client/tests/writing-style.test.ts` (outside text, the member's agent, per account and company, off / unreadable / AI
stopped, a sign-in during a build and A → B → A, a turn bound to its sign-in, deletion during a build, a passing failure,
instruction and money words dropped, corrections, deletion, a month later, after the block) — guards mutation-checked.

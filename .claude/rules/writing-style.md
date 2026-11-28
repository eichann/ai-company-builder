---
paths:
  - "shared/core/writing-style.ts"
  - "shared/types/writing-style.ts"
  - "server/src/ports/sent-samples.ts"
  - "server/src/services/writing-samples.ts"
  - "server/src/services/google-writing.ts"
  - "server/src/services/slack-writing.ts"
  - "server/src/routes/writing-samples.ts"
  - "server/tests/unit/writing-samples.test.ts"
  - "server/tests/unit/writing-style.test.ts"
  - "client/shared/writing-style.ts"
  - "client/electron/features/writing-style/**"
  - "client/tests/writing-style.test.ts"
  - "client/tests/writing-style-boundary.test.ts"
  - "client/src/features/settings/writingStyle.ts"
  - "client/src/features/settings/writingStyle.test.ts"
  - "client/src/features/settings/hooks/useWritingStyle.ts"
  - "client/src/features/settings/components/WritingStyleSection.tsx"
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
- Slack: `services/slack-writing.ts` — **no new permission**: only the member's own 自分あての DM とメンションを読む (`read`:
  the `*:history` scopes, granted and not turned off) while their 受信を読む is on. That permission cannot list the member's
  conversations (`*:read`) or search (`search:read`), so the places read are the ones the inbox already took in for them:
  the newest of their chat pointers (`inbox_messages.source_ref` `slack:<channel>:<ts>`, reporter = the member;
  `InboxRepository.recentSourceRefs`, pointers only) — a DM (`D…`) by `conversations.history` (a year back, the newest
  100), any other place by that message's thread (`conversations.replies`); each place once, at most
  `SLACK_SAMPLES_READS_MAX` (12) calls per making. Kept: the member's own plain messages (no bot, no join / edit subtype),
  mentions as 「@Slack の人」 (no name looked up). 身内 / よそ = everyone else's workspace (`user_team` / `team`) is the
  company's Slack workspace or not (a Slack Connect guest is よそ; an Enterprise Grid colleague of another workspace too);
  a place where no one else's workspace shows, or someone's is not given, is left out (never guessed as 身内).
  A thread's other side: `slack-chat.ts` marks each message `external` from its team (`ChatMessage.external`, not on the
  wire), `audienceOf` says よそ when anyone is external, 身内 only when everyone is known to be of the workspace. A member
  who just connected has no pointers yet: Slack's summaries come once Slack's DMs and mentions have arrived.
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
  Not yet: a new mail (`mail_recipients` without a thread). A thread through a connector with no summary yet (a tool
  allowed after the check was turned on) makes the missing ones in the background (`build(…, full = false)`: a
  summary made within the month is not read or made again), at most every `REFRESH_RETRY_MS`; 「作り直す」 makes all. A summary the member removed with 「消す」 is remembered (`dismissed` in the file) and never made again by a thread read;
  「作り直す」 makes it again.
- IPC (main, the session stays there): `writingStyle:status` / `setEnabled` (on = build in the background) / `rebuild` /
  `update` (the member's correction, checked like the AI's) / `remove` (one, or all and the check off).

## The entry (renderer, `client/src/features/settings/`)

- **One optional check** 「返事の下書きを、わたしの書き方に合わせる」 on 「仕事の道具をつなぐ」 (`ConnectToolsScreen.tsx`: the
  first run's dialog and 設定 → 「サービスの一覧」; owner: no settings screen of its own), off until the member ticks it,
  shown while the company has a tool that could hand samples (`writingCheckOffered`). Its line names the tools by the
  labels the server answered (`writingCheckHint`), never in code. On but nothing readable → 「受信を読む」 is pointed to
  (`writingStatusLine`). A connection finished on the screen (`useConnectTools`' `onConnected`) makes them again while it is on.
- **The summaries, corrected where they are shown** (`WritingStyleSection.tsx`; owner: no editing box apart): each text
  field is `InlineText` (press the words → a field in the same place, Enter / leaving saves, Esc puts it back), each choice
  turns into its list in place; the phrases are one line with 「／」. A correction is checked here with the main process's
  rule (`withWritingText` → `parseWritingStyle`): what would be dropped (a name with an honorific, an address, money, an
  instruction) is refused with 「名前・連絡先・住所やお金の話、指示のような文は、まとめに入れられません。」 and nothing is
  sent. 「消す」 per summary; 「まとめをすべて消す」 (confirmation) removes the file and the check; 「作り直す」.
- Ports `WritingStyleReads` / `WritingStyleWrites` (`api.ts`), `hooks/useWritingStyle.ts` (loads from a callback ref,
  every 2 s while 「まとめています」). Words and rules: `writingStyle.ts`.

Tests: `server/tests/unit/writing-style.test.ts` (shape, personal details, stand-in, staleness),
`server/tests/unit/writing-samples.test.ts` "Slack's reader" (a place with no one else's workspace left out, each DM once and
the 12-call limit, a refused permission ends the making, よそ / 身内 / unknown for a thread, only the inbox's Slack pointers),
`server/tests/integration/threads.test.ts` (Slack: only the places the inbox took in, her own plain messages, a join / a
bot / another's words never, 身内 / よそ by workspace, a Slack Connect thread's key よそ, 受信を読む or 読む off → nothing
read), `client/src/features/settings/writingStyle.test.ts` (a correction that would be dropped is refused before sending;
the check's words), `client/tests/ui/connect-tools.spec.ts` (the check off until ticked; a field corrected in place, a name
refused with nothing sent, a choice in place, 「消す」),
`server/tests/unit/writing-samples.test.ts` (the role and capability only, readable before reading, Gmail's own words /
audience / machine mail / max), `server/tests/integration/threads.test.ts` (the samples route end to end against the fake
Google: own words, 身内 / よそ, 受信を読む off → nothing sent to Google, the key on a mail thread, nothing kept),
`client/tests/writing-style.test.ts` (outside text, the member's agent, per account and company, off / unreadable / AI
stopped, a sign-in during a build and A → B → A, a turn bound to its sign-in, deletion during a build, a passing failure,
instruction and money words dropped, corrections, deletion, a month later, after the block) — guards mutation-checked.

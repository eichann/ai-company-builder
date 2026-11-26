# model/drive-view — viewing a picked Drive video as a TLA+ model

The view pick of a Drive video (its ticket bound to one file, the Picker's result, the pick kept apart) and the
streaming of its bytes to the member's own player (the pick checked at every range, the caps, the last checks before
the call to Google leaves, the answer ending once) written in TLA+ (`DriveView.tla`), with the rules they keep. The
checker [tla-ts](https://www.npmjs.com/package/tla-ts) explores **every** reachable state — every interleaving of the
two requests of one member, another member's request, the ticket's two halves and the revocations — and checks the
rules in each.

The working rule is in `.claude/rules/google-drive.md` "Streaming a picked video": **a PR that changes the view pick or
the streaming route changes this model in the same PR.**

## Run it

```sh
model/drive-view/check
```

Needs bash, Node (22 in CI) and npm only. The checker is installed from `package-lock.json` into a temporary folder (no
install scripts run); nothing is written to the repository or to HOME. About 100 s (the liveness rule R7 takes most of it). Outside the pnpm workspace on
purpose, like `model/browser-plan/` (same pinned `tla-ts` version).

CI: job "Model (Drive view)" in `.github/workflows/ci.yml`, run when area `model` changes
(`.github/scripts/changed-areas.sh`: this folder and the code it copies), on every push to main and nightly.
`.github/scripts/check-areas.mjs` fails when a `.tla` here cites a code file that does not exist or is not in that area.

## What the model copies

| Part | Copied from |
|---|---|
| The view ticket (one id, bound), the Picker's result in two halves (the grant read before Google is asked, then the bound id, the video type and the same account), the pick kept apart from the AI's picks | `server/src/services/google-drive.ts` (`startPick`, `pageResult`, `keepViewPicks`), `shared/core/google-drive.ts` (`DRIVE_VIEW_MIMES`, `drivePickableFor`) |
| The pick checked at every range (member, file, the account the grant has now, the switches) | `server/src/services/google-drive.ts` `useViewPick` |
| The caps, the session's metadata, the bytes reserved and cut, the answer ending once (finish, the viewer leaving, a failure) | `server/src/services/google-drive-view.ts` `open` |
| The last checks before the call leaves (every switch, the grant still the one the pick check saw — before the access token and again after it, then nothing awaited until the call leaves) | `server/src/services/google-client.ts` `streamMedia` |

## Rules

| Rule | What it says | 日本語（意味） |
|---|---|---|
| `R1_ViewPickOnlyBoundVideo` | A view pick exists only for the file its ticket was bound to, and only when Google said it is a video | 再生用に選んだものは、資料が求めた動画そのものだけ |
| `R2_StreamOnlyForLivePick` | A stream starts only for a live view pick of that member, file and Google account with the grant active, the switches on and the member in the company; its call leaves only under the grant that check saw, with every switch still on | 本人・その動画・いまの Google アカウントで選んだものがあり、許可とスイッチが生きているときだけ流す。Google に出す直前にも確かめる |
| `R3_OnlyInFlightOutlivesRevocation` | After a revocation (grant revoked or replaced, Drive off, member removed) no new range leaves (R2's second half); what continues is only what was already in flight: at most `MAXS` answers of the member, each at most `CH` bytes | 許可がなくなったあとに続くのは、すでに出ていた分（1回の読み込み）だけ |
| `R4_StreamsPerMember` | Answers streamed at once per member stay within the cap, and the count is exactly the answers holding a slot (released on finish, abort and failure) | 同時に流す数は上限まで。止めたら必ず数を戻す |
| `R5_BytesPerDay` | The day's bytes stay within the member's and the company's caps, and what is counted is exactly what is reserved by answers under way plus what ended answers passed on | 1日の量は本人・会社の上限まで。途中でやめた分は戻す |
| `R6_ViewPickNeverAiPick` | A view pick never becomes an AI-readable pick: the AI's picks are only files pressed in a reading ticket | 再生用に選んだ動画を AI は読めない |
| `R7_SlotReleased` | (liveness) Every answer that took a stream slot ends — its slot released, its unsent bytes given back — under the weak fairness of the server's own steps (`ServerFair`: the caps, the metadata, the reservation, the last check, the answer's deadline), even when the viewer never reads and Google never fails | 読まない相手がつながったままでも、枠と予約は必ず戻る（答えごとの期限） |

"In flight" is a request that passed `streamMedia`'s last checks: its call to Google left (or will with no further
await). One request is one answer of at most `CH` bytes (the per-answer ceiling), so a revocation lets at most the
answers already in flight finish, never a new one: the player's next range is checked again (R2).

No dead end: a run where every request ended and the ticket is closed stutters in `Done`; any other state with no step
fails the check.

## What `check` verifies (numbers in `expected.txt`)

1. The real model (`LiveSpec` = the spec with `ServerFair`) keeps every INVARIANT and the PROPERTY R7, and has no dead end; the rules checked are exactly `expected.txt`'s
   `rule DriveView` lines; a `CHECK_DEADLOCK` line is refused.
2. Its distinct state count equals `states DriveView` (today **267,040**): a guard against a checker that explores less.
3. Each `broken/` variant fails on its named rule. **A variant that passes fails the job.**
4. Every variant file has a line in `expected.txt` and every line has its file.

## Broken variants (`broken/`): one guard removed each

| Variant | Guard removed | Fails |
|---|---|---|
| `BrokenResultKeepsAnyId` | The result keeps whatever id was pressed (`not-requested` removed) | R1 |
| `BrokenResultNoVideoCheck` | The result keeps the bound file whatever Google says it is (`not-video` removed) | R1 |
| `BrokenViewKeepsAiPick` | A view result is also kept as an ordinary pick (the purpose falling back to `read`) | R6 |
| `BrokenCheckAnyMembersPick` | `useViewPick` looks the pick up without the member | R2 |
| `BrokenCheckNoAccount` | `useViewPick` looks the pick up without the Google account | R2 |
| `BrokenPassAnyGrant` | `streamMedia` does not compare the grant with the one the check saw (`grant-changed`) | R2 |
| `BrokenPassNoSwitches` | The call leaves without the last checks (a revocation between the check and the call does not stop it) | R2 |
| `BrokenNoStreamCap` | The caps do not count the answers being streamed | R4 |
| `BrokenAbortKeepsSlot` | The viewer leaving does not release the slot (a leak) | R4 |
| `BrokenReserveNoCut` | A whole range is reserved whatever is left of the day | R5 |
| `BrokenAbortNoGiveBack` | An answer ended early keeps its whole reservation counted | R5 |
| `BrokenReserveStale` | The reservation uses what was left of the day at the caps, not the counts read again after the metadata's await | R5 |
| `BrokenNoAnswerDeadline` | The answer has no deadline of its own: only the viewer reading to the end, leaving, or Google failing ends it (review 2026-11-27) | R7 |

R3 has no variant of its own: what could break it (a new range leaving after a revocation, more answers in flight than
the cap, an answer longer than `CH`) is caught first by R2 (`BrokenPassNoSwitches`, `BrokenPassAnyGrant`) and R4
(`BrokenNoStreamCap`); it is kept as the statement of the promise.

## What the model leaves out

- **One company, two members, two files, three requests** (r1, r2 by m1 for the bound file, r3 by m2, who never picks).
  Other members' answers are folded into one step that reserves the company's bytes by the same rule (`OthersStream`).
- **Bytes are abstract units**: a range is at most `CH` = 2, the member's day `MCAP` = 3, the company's `CCAP` = 4, one
  stream at once per member (`MAXS` = 1). Only their order matters (a range can be cut by what is left).
- **One day**: the day's change (the caps starting again) is not modelled; nor the requests-per-minute cap (a counter
  checked in the same synchronous stretch as the others, held by the tests).
- **The environment** happens at most once each — the grant revoked, a re-consent (the same or another account), the
  company's Drive switch off (it stands for the member's own switch, the company's Google off and the operator's stop:
  the same checks see them all), a member removed, the pick lapsing (90 days, here at any time) — and at most two of the
  revocations in one run; each such pair is explored against every point of every request.
- **The metadata** (type and size) is one step that may fail; the type list, the Range forms and Google answering a
  different range than asked are the tests' job (`server/tests/integration/google-drive-stream.test.ts`).
- **The token's await**: `streamMedia` checks before the token and again after it, and awaits nothing from that last check
  to the call leaving, so `Pass` is that last check.
- **One server process**: the per-minute counts, the open answers and the sessions are in its memory; two processes
  would each keep their own (the daily bytes, in the database, would still hold).
- **What releases a slot** (R7's steps): the last byte passed on (`Finish`), the viewer leaving (`Abort`), Google failing or
  ending short (`Fail`), the answer's own deadline (`Deadline`, `ACB_DRIVE_VIEW_ANSWER_MS`, which fires whether or not the
  viewer reads), and a refusal before the call (`Meta`, `Reserve`, `Pass`). The viewer's and Google's steps are not
  assumed to happen.
- **The viewing session's log line** (one per session) and the request log are the tests' job.
- No liveness under fairness ("eventually ends"): the dead-end check says no state is stuck.

# model/browser-plan — the browser plan lifecycle as a TLA+ model

The life of one 「ブラウザ操作」 plan — register → approve → claim → send permit → send → report →
confirm — written in TLA+ (`PlanLife.tla`), with the rules it must keep. A second model,
`StepsLife.tla`, is the **several-writes design** (generalization PR 1, below: "StepsLife"), kept as the
model of the safe pattern. A third, `FramesLife.tla`, is **writes within frames** (redesign step ⑤a, below:
"FramesLife"): free operation where only an upper bound per write target is known. The checker
[tla-ts](https://www.npmjs.com/package/tla-ts) explores **every** reachable state and checks the
rules in each. It catches what example-based tests miss: interleavings of two PCs, late network
answers, crashes at any step, and clocks.

The working rule is in `.claude/rules/agent-browser.md` "The plan model": **a PR that changes the
plan lifecycle changes this model in the same PR.**

## Run it

```sh
model/browser-plan/check
```

Needs bash, Node (22 in CI) and npm only. The checker is installed from `package-lock.json` into a
temporary folder (no install scripts run); nothing is written to the repository or to HOME. About
25 s. This folder is **outside the pnpm workspace on purpose** (not in `pnpm-workspace.yaml`, not in
Dependabot): it is a tool used by one CI job only, pinned by its own npm lockfile; bump `tla-ts` by
hand, re-run `check`, and say what changed.

CI: job "Model (browser plan)" in `.github/workflows/ci.yml`, run when this folder or the code it
copies changes (area `model` in `.github/scripts/changed-areas.sh`), on every push to main and in the
nightly run. `.github/scripts/check-areas.mjs` fails when a `.tla` cites a code file that does not
exist or is not in that area.

## What the model copies

| Part | Copied from |
|---|---|
| Plan and execution states, times | `shared/core/browser-plans.ts` (`BrowserPlanState`, `BrowserExecutionState`, `BROWSER_PLAN_TIMES`) |
| Server actions (register, approve, cancel / expiry / leaving, claim, permit, time-outs, report, confirm) | `server/src/services/browser-plans.ts` (PR 6a; the clock fix of 6b-2a), each action naming its function |
| App actions (re-read after claim, ask for the permit, an unusable permit answer before 5 s, the last check before sending, judging after the send, reports) | the runner of 6b-2c: `client/electron/features/browser/runner.ts` (`createBrowserRunner`'s `run`: `giveBack`, `ready`, `beforeSend`, `settle`), `client/shared/browser-runner.ts` (the claim, the fixed content, the permit's answer), `client/electron/features/browser/read-session.ts` (`writeThroughSession`: the permit inside the prepared write session, "not sent" only before `request.end`). Built and tested, **switched off; nothing in the app calls it yet** (6b-2d wires the card's press) |

Each action in `PlanLife.tla` says which function or design section it copies.

## Rules

| Rule | What it says | 日本語（意味） |
|---|---|---|
| `R1_AtMostOneSendPerPlan` | One plan's write reaches the site at most once | 1 つの計画の書き込みは、サイトに多くても 1 回しか届かない |
| `R2_NoSendWithoutApprovalAndLivePermit` | Nothing is sent without the member's approval and a live permit (that execution permitted, the claiming PC, under 5 s since the permit) | 承認と生きている許可なしに送らない |
| `R3_OneOpenExecutionPerTarget` | On one target at most one execution is open (claimed, permitted, unknown); an unknown one is never retried by another | 同じ対象で終わっていない実行は 1 つだけ。「分からない」を自動でやり直さない |
| `R4_FailedOnlyIfNotSent` | A failed ("not sent") execution's write never reached the site | 「失敗（送っていない）」なら本当に送っていない。迷ったら「分からない」 |
| `R5_NotDoneStaysTrue` | An execution confirmed "not done" did not change the site later either | 「されていなかった」と確かめたものが、あとから嘘にならない |
| `R6_NoDoubleApply` | The same change never lands twice | 同じ変更が 2 回入らない |
| `R7_EverythingSettles` | From every state, a settled state (every execution final, the lock free) can be reached | どの状態からも、全部が片付いた状態まで行ける |

"Never retry what is not known" is not one formula: R1 (no second send by the same execution), R3
(no other execution on the target) and R2 (a new plan needs a new approval) keep it together. R7 is a
reachability rule, not a state formula: `reach.mjs` checks it on the checker's state graph (the
`\* REACH` line of `PlanLife.cfg`).

## What `check` verifies (numbers in `expected.txt`)

1. Each real model (`model` lines: PlanLife, StepsLife, FramesLife) keeps every INVARIANT and has no dead
   end; the rules checked are exactly `expected.txt`'s `rule <model>` lines (dropping one fails); a
   `CHECK_DEADLOCK` line is refused.
2. Its distinct state count equals `states <model>` (today PlanLife **57,618**, StepsLife **28,320**,
   FramesLife **264,480**): a guard against a checker that explores less than it should. **A ceiling**: the
   checker writes the whole state graph out as one string for `reach.mjs`, and a string cannot pass ~512 MB — about
   1,750 bytes a state, so roughly **290,000 states** (FramesLife's graph is 463 MB). A change that grows a model past
   that fails with `RangeError: Invalid string length`: narrow the model (as FramesLife's `RefusedOrNot`) rather than
   the check.
3. R7 holds over all of those states (`reach.mjs` must walk the same number; one settled predicate for
   both models).
4. Each `broken/` variant fails on its named rule. **A variant that passes fails the job**: the
   checker must not wave through something known to be broken.
5. Each `limits/` and `holes/` variant fails on its named rule, so neither disappears nor changes
   unnoticed.
6. Each `proposals/` variant keeps every rule, R7 included, with its expected state count.
7. Every variant file has a line in `expected.txt` and every line has its file.

## Broken variants (`broken/`): one guard removed each

| Variant | Guard removed | Fails |
|---|---|---|
| `BrokenRetryAfterUnknown` | The app resends the write when no answer came and the permit is not over | R1 |
| `BrokenNoCheckBeforeSend` | No check of the permit's age (both clocks) right before sending | R2 |
| `BrokenPermitReplayed` | The server answers send-permit again without checking it is the claiming PC | R2 |
| `BrokenFailedOn4xx` | After a send the site refused (4xx) and the page looks unchanged, the app reports failed (the runner's branch `refused-by-site` before 6b-2c; removed there). Also stands for "failed after an error once the request left": the same transition in the model (code guard: `writeThroughSession` + the runner, held by the tests) | R4 |
| `BrokenLockFreedOnUnknown` | An unknown execution releases the target lock | R3 |
| `BrokenNoReread` | The app asks for the permit without re-reading the fixed facts after the claim | R6 |
| `BrokenNoServerTimeout` | The server never turns a silent permitted execution unknown | R7 |
| `BrokenNoMonotonicWindow` | The server judges permit + 5 s + 30 s by its wall clock alone (6a), with the wall clock jumping forward | R5 |

## Accepted limits (`limits/`)

| Variant | What happens | Fails | Status |
|---|---|---|---|
| `LimitFrozenAfterCheck` | After the last check before sending, the process freezes before the request leaves and resumes after the permit ran out | R2 | **Accepted** (agent-browser.md "Remaining limits": the stretch between the app's last clock check and the request leaving). Kept minimal (no await between the check and `request.end`); the 30 s grace delays 「確かめた」 |

## Closed hole: the server's clock jumping forward (fixed in 6b-2a)

The real model has an environment action `ServerClockJumps`: the server's wall clock jumps forward by
35 s or more right after a permit (a one-shot NTP correction, a VM time sync). 6a judged
"permit + 5 s + 30 s have passed" by the wall clock alone, so it turned the execution unknown and
accepted 「確かめた：されていなかった」 while the app, correctly by its own clocks, still sent inside its
5 s — the "not done" confirmation turned false (R5). 6b-2a counts the window on both clocks
(`pastWindow` in `server/src/services/browser-plans.ts`; `Past(p)` here: the wall clock `srvAge` and the
monotonic clock `realAge` — since the permit on the same process start, since the start after a
restart, which is never earlier than the real elapsed time). `broken/BrokenNoMonotonicWindow` drops the
monotonic condition again and fails R5 (R2 also breaks, earlier; it checks only R5, the worst
consequence). The state count went from 32,882 to 57,618 with the jump in the real model.

`holes/` and `proposals/` are empty now; `check` still runs any variant put there (a new hole found
in today's code, or a proposed fix).

## What the model leaves out

- **One target, two plans, two PCs.** More plans, other targets, companies and members are not
  modelled (lock keys and company separation are the server tests' job).
- **Abstract time**: the 5 s permit = 1, the 30 s grace = 1; only permit < permit + grace matters.
  The 2-minute claim limit and the plan's hour are "may happen at any time" (wider, safe side).
- **The app's two clocks** (monotonic and wall) are one "real elapsed" value; sleep and a wall clock
  going back on the PC are the app's unit tests' job.
- **The person who confirms answers truthfully** (looks at the site).
- **The facts** (template name, body, timing, audience, sharing) are folded into three site states:
  as when planned (`before`), as planned (`after`), anything else (`other`); per-field comparison is
  the app's tests' job.
- **A modified app or a member lying about their own API calls** are out of scope (design §29.4);
  the app's "not sent" is trusted.
- **A site still processing a send and changing later** is not modelled (a remaining limit).
- The approval hash check, the gate (type, grant, setting, stop, app version) and fact-shape checks
  are folded into one "pass / refuse" (`ServerRefusesPermit` may refuse at any time).
- **No liveness under fairness** ("eventually settles"): R7 says a path to settled exists.

## StepsLife: several ordered writes (design ahead of code)

Design memo 「ブラウザ操作の汎用化」 §4, §5, §9, §15 (C11–C15), §15-2 (PR 1), §16-3. The contract is
agent-browser.md "Executions with several writes" (the execution and write-state table); each action of
`StepsLife.tla` names its row there. Nothing implements it yet: PR 4 (server) and PR 5 (app) copy it,
and then cite their files in the actions (and in `changed-areas.sh`'s MODEL), as PlanLife does.

Site-neutral: an existing object E, a folder, what this execution created ("ours"), a person's new
object in the same folder ("theirs"). p1 = a three-write plan (create → change it → change E; or a
second shape that changes E before its last write, which the line judge must keep out); p2 = an
old-path one-write plan on the same E (its own life is PlanLife's, folded into claim → write → end).

| Rule | What it says | 日本語（意味） |
|---|---|---|
| `R1_AtMostOneSendPerWrite` | Each write reaches the site at most once | どの書き込みも、届くのは多くても1回 |
| `R2_NoSendWithoutLivePermit` | Only under a live permit for that write | その書き込みの生きている許可なしに送らない |
| `R3_OneOpenExecutionPerObject` | One open execution per object, across the old and the new path | 古い道と新しい道をまたいで、同じものに開いた実行は1つ |
| `R4_NotSentMeansNotSent` | `not_sent` / `skipped` / `pending` never reached the site | 「送っていない」「試していない」は本当に届いていない |
| `R5_NotDoneStaysTrue` | A "not done" confirmation stays true | 「されていなかった」があとから嘘にならない |
| `R6_NoDoubleApply` | No change lands twice | 同じ変更が2回入らない |
| `R7_EverythingSettles` | Every state can reach a settled one | どこからでも片付けられる |
| `R8_InOrder` | Write k is permitted only after k−1 was recorded done | k 番目は k−1 番目が「済んだ」と記録されてから |
| `R9_StoppedLeavesExistingAlone` | A stopped execution left the existing object alone | 途中で止まった実行は、今あるものを変えていない |
| `R10_NoContinueAfterUnknown` | Nothing is permitted after an execution was unknown, not even after a late "done" | 「分からない」のあとは、遅れた「済んだ」が来ても続けない |
| `R11_CreatedIsItsOwn` | What is recorded as created is this execution's own, unshared object | 「作ったもの」は本当に自分が作り、だれからも指されていないもの |
| `R12_PartialIsSure` | A partial execution has no unknown write | 「途中まで」には「分からない」書き込みが残っていない |
| `R13_DoneMeansLanded` | A write recorded done landed (a report counts for the write it names) | 「済んだ」は本当に入った（報告は名指しした書き込みにだけ効く） |

Broken variants (`broken/BrokenSteps*`), one guard removed each:

| Variant | Guard removed | Fails |
|---|---|---|
| `BrokenStepsLockFreedAfterWrite` | locks held until the execution is final (C12) | R3 |
| `BrokenStepsOldPathOwnKey` | one lock key for both paths (C11) | R3 |
| `BrokenStepsPermitPerPlan` | a permit per write, only after k−1 done | R8 |
| `BrokenStepsWindowFromFirstPermit` | the window counted from that write's permit (checks R5 only; R2 breaks in the same step) | R5 |
| `BrokenStepsContinueAfterLateDone` | `unknown` never runs again | R10 |
| `BrokenStepsNoReferenceCheck` | a create is ours only if nothing else references it (C1) | R11 |
| `BrokenStepsPickNewest` | identifying the created object by answer id and content, not "the one new" (C3) | R11 |
| `BrokenStepsReportToCurrentWrite` | a report counts for the write it names | R13 |
| `BrokenStepsNoLineJudge` | the line judge at the claim (I4) | R9 |
| `BrokenStepsNoGapTimeout` | the plan's limit ends a gap between two writes (has its own `TimePasses` stutter so the stuck state is no dead end) | R7 |
| `BrokenStepsGapEndsOpenWrite` | the gap ends only with nothing open | R12 |
| `BrokenStepsResendAfterNoAnswer` | a write with no answer is never sent again | R1' |
| `BrokenStepsSendWithoutPermitCheck` | the last check before sending looks at the permit's age | R2' |
| `BrokenStepsNotSentAfterSend` | "not sent" only before the request left (never after a send) | R4' |
| `BrokenStepsNoRereadBeforeWrite` | the target read again before each write (I2) | R6 |

Not tested by a variant, on purpose: the plan's limit on later permits (`ageFirst < LIMIT` in
`ServerPermits`) only bounds how long a run may take (availability; no rule depends on it), and
`NoneOpen` there is a second layer of `Prev = "done"`.

### What StepsLife leaves out

- **Site properties are assumptions** (memo C2, C15): whether a site's create shares a child, what
  creating sets off, what is not visible — checked per site by the map's reviewed promise and a test
  object, not here. The model lets any create share (`oursShared`) and demands the app see it.
- Three writes, one folder, one existing object; no two new-path plans at once (the claim once and the
  one lock are PlanLife's and R3 here); no `remove_child` or irreversible write (not opened, I10).
- One clock per write (`age`, since that write's permit) and the plan's (`ageFirst`); both-clock
  readings and a jumping clock are PlanLife's (`ServerClockJumps`) and required per write all the same.
- The approval, the facts, the gate's checks (folded into `ServerRefusesPermit`), a person confirming
  wrongly, a modified app.

## FramesLife: writes within frames (redesign step ⑤a)

Design memo 「ブラウザ操作：記録から自動化へ」 §3 I3–I5 and its 「止まったら・2回動いたら・同時に動いたら」 list, §6-2, §7-2.
The AI operates a registered domain freely; each write its page makes is held, matched to a **frame** of
the run (a write target × at most `max` uses), sent once under a permit and reported. StepsLife assumed
the writes were known in advance (one row per write, made at the claim, in order); here a run holds only
an upper bound per frame and a write row is appended per permit. The contract is agent-browser.md
"Writes within frames"; the server half (step ⑤a) is `server/src/services/browser-frames.ts`, whose
functions the server actions name. The app's half (step ⑤b: holding the page's write, sending it once
through the core's own write connection) copies the `App*` actions.

Site-neutral: two frames, "a" (at most 2 uses) and "b" (at most 1), at most 3 writes in all. A run starts
`waiting` (an ad-hoc plan, a per-run Skill, a Skill whose text changed: the card first) or `open` (a
pre-approved Skill version). `gate`: `stopped` is the AI stop (the app and the server both see it);
`closed` folds every cause only the server re-checks at each permit (the person lowered to 見るだけ, the
site, the Skill's approval revoked or changed, another PC, the run's hour).

| Rule | What it says | 日本語（意味） |
|---|---|---|
| `R1_AtMostOneSendPerWrite` | Each write reaches the site at most once | どの書き込みも、届くのは多くても1回（自動で送り直さない） |
| `R2_NoSendWithoutApprovalAndLivePermit` | Nothing is sent without a live permit for that write; no permit before the plan was approved or after the run ended | 生きている許可なしに送らない。承認前・実行の終わったあとは許可しない |
| `R4_NotSentMeansNotSent` | `not_sent` (or never permitted) never reached the site | 「送っていない」は本当に送っていない |
| `R7_EverythingSettles` | Every state can reach a settled one (the run ended, nothing in flight) | どこからでも片付けられる |
| `R10_NothingAfterUnknown` | After a write was unknown nothing more is permitted or sent in that run, not even after a late "done" | 「分からない」のあとは、その実行では何も送らない |
| `R14_WithinFrames` | A frame is never used more than its max | 枠を超えない |
| `R15_OneWriteAtATime` | One write of the run on its way at a time | 書き込みは1つずつ（2つ目は1つ目の結果が記録されるまで待つ） |
| `R16_NoSendAfterStop` | Nothing is sent after the AI was stopped | 止めたあとは送らない |
| `R5_NotDoneStaysTrue` | A write the person answered 「されていなかった」 about never reached the site later either | 「されていなかった」があとから嘘にならない |

**Recovering from a failed write** (agent-browser.md "Recovering from a failed write"): a write the site answered with a
4xx that proves it was not taken is `refused` — the run goes on (no lock), its unit stays used (R14: a corrected try is a
new write within the same max) —; the person may answer about a write in doubt from the card (`PersonConfirms`: only past
its permit + 5 s + 30 s, true when given, never moving the write or the run — R10 covers "never unlocks"; the server
keeps the write `unknown` and the answer apart, folded here into `cdone` / `cnotdone`, `InDoubt`).

"Unused frames vanish at run end" is R2 (`BrokenFramesUsedAfterEnd`). Broken variants
(`broken/BrokenFrames*`), one guard removed each:

| Variant | Guard removed | Fails |
|---|---|---|
| `BrokenFramesExceedFrame` | the frame's units checked at the permit (`takeUnit` and the CHECK `used <= max`) | R14 |
| `BrokenFramesSendAfterUnknown` | a locked run (a write unknown) gives no permit | R10 |
| `BrokenFramesSendAfterStop` | the app's last check before the request leaves looks at the AI stop | R16 |
| `BrokenFramesTwoInFlight` | one write in flight per run (the check and the partial unique index) | R15 |
| `BrokenFramesNoApproval` | no permit while the run waits for the person's approval | R2 |
| `BrokenFramesUsedAfterEnd` | an ended run's frames give nothing | R2 |
| `BrokenFramesRefusedGivesUnitBack` | a refused write's unit stays used (`permit` counts it) | R14 |
| `BrokenFramesConfirmUnlocks` | the person's answer never unlocks the run | R10 |
| `BrokenFramesConfirmBeforeWindow` | the answer only past the write's permit + 5 s + 30 s (both clocks) | R5 |

### What FramesLife leaves out

- **One app worker**: it asks for the next page write as soon as it sent the previous one (before that
  one's result is recorded), so the server's one-in-flight rule is what makes it wait. A second worker would
  also ask while a permit is held and not yet used — the same rule refuses it — and needs over 4 GB of the
  checker; the server tests race two permits on the real code.
- **Matching a page write to a frame** (method, path, the body's `_method` and fixed fields, a body that
  cannot be read): ⑤b's, its own tests; a write matching no frame is refused before a permit is asked.
- **A permit already given under a cause only the server sees** (`closed`) stays good for its 5 s: the app
  cannot know; the next permit is refused and the run ends. The stretch between the app's last check and
  the request leaving is PlanLife's accepted limit (`LimitFrozenAfterCheck`), the same here.
- **Where the code is stricter than the model** (each on the safe side, none breaking a rule): the code checks "a write
  in flight" and "used up" before the gate, so a closed gate ends the run only when those pass (the model ends it on
  any refusal under a closed gate); a run `waiting` whose gate closed answers "not approved" to a permit and ends only
  at its approval or its time (the model ends it at once). `approve` under a closed gate ending the run is modelled
  (`PersonApproveRefused`), and so is leaving (`MemberLeaves`: the run ends, a write still permitted is unknown at once —
  that very write may still go out within its 5 s, which is no "more" after unknown).
- **Refused writes, narrowed** (`RefusedOrNot`, for the ceiling above): only the run's first write, on frame "a" (max 2),
  may be refused, and that report arrives exactly once — one refused try and a corrected one within the max is the case
  that matters; a lost refused report is the time-out to unknown and a repeated one the same answer, both explored for the
  other answers; more refused tries repeat the same move. Statuses (which 4xx count as refused: an allowlist, every
  other status unknown) are the app's rule (`browserWriteAnswerKind`), tested there.
- **The person's answer, true when given** (`PersonConfirms`): 「されていなかった」 only while the write has not reached the
  site, 「済んでいた」 only once it has; a person answering wrongly is left out (as in PlanLife). Their PC and member binding
  is folded in (the server's tests).
- **Matching the request to the frame** is a precondition of `AppAsks` here (a write that fits no frame is never asked
  for); the server checks it too (`browserFrameMismatch`, the one rule in `shared/core`) and a mismatch takes nothing.
- **The card's one-time approval value** (only the start's answer carries it) is folded into `PersonApproves`.
- **Where the app's code (step ⑤b, `client/electron/features/browser/frame-writes.ts`) is stricter than the model** (each on
  the safe side, no transition added): the worker asks for the next page write only once the previous one's **report
  was recorded** (the model's worker asks right after sending; the server's one-in-flight rule is what the model
  checks); a report the server did not record, an answer of the site that is neither a success nor a refusal (`browserWriteAnswerKind`) or a permit refusal that ends the run
  make the app send nothing more in that run (the model sends on until the server refuses); a held write is matched to a
  frame locally first, with the core's rule (`browserFrameMismatch`), so a mismatch never asks. The join of the frames
  run's lock with the operator runs' (one run per company × domain across both, `services/browser-runs.ts` `frameRunOn`
  and `browser-frames.ts` `holderOn`) is about more than one run: left out like the lock itself.
- The run lock per company × domain (D10) and the domain kept busy by an ended run's write in flight (more than one run,
  the server's tests), the
  run's time limits as real durations (folded into `closed` and `RunEnds`), a server clock jump (PlanLife's;
  the server counts each write's window on both clocks all the same), the safe patterns (StepsLife).

## Drift: the model is copied by hand

Nothing compares the model with the code mechanically: change the code and the model stays as it
was. What keeps them together:

1. The rule in agent-browser.md: a lifecycle change (state transitions, the order of checks, the time
   contract) changes this model in the same PR, ideally **before** the code. A PR that changes the
   cited files without touching the model says in its body why the model is unaffected.
2. The CI job runs whenever a cited file changes (`check-areas.mjs` keeps the list in step).
3. Weakening or removing a rule is the owner's call: the rule set is compared with `expected.txt`,
   so a silent removal fails, and the independent review looks for it.
4. Regressions in the code itself stay the tests' job (`server/tests/unit/browser-plans.test.ts`,
   the runner's tests).

## Changing the model

- Changing the lifecycle: write it here first and run `check`.
- A new state count: update `states` in `expected.txt` and say why in the PR.
- A new guard: add a `broken/` variant that removes it, with the rule it must fail in `expected.txt`.
- The structure follows andon's `model/` (`reach.mjs` is written for this model, Node built-ins only).

## Files

| File | What |
|---|---|
| `PlanLife.tla` / `PlanLife.cfg` | The model of today's one-write code, its rules, the checker's settings and the `\* REACH` line |
| `StepsLife.tla` / `StepsLife.cfg` | The several-writes design (generalization PR 1), the same way |
| `FramesLife.tla` / `FramesLife.cfg` | Writes within frames (redesign step ⑤a), the same way |
| `reach.mjs` | R7 on the state graph |
| `expected.txt` | Rules, state count, each variant's expected result |
| `broken/`, `limits/`, `holes/`, `proposals/` | The variants |
| `check` | The entry point |
| `package.json`, `package-lock.json` | The checker (tla-ts 0.0.10, as in andon) |

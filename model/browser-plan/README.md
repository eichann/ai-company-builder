# model/browser-plan — the browser plan lifecycle as a TLA+ model

The life of one 「ブラウザ操作」 plan — register → approve → claim → send permit → send → report →
confirm — written in TLA+ (`PlanLife.tla`), with the rules it must keep. The checker
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
| App actions (re-read after claim, ask for the permit, the last check before sending, judging after the send, reports) | the runner of 6b-2c: `client/electron/features/browser/runner.ts` (`createBrowserRunner`'s `run`: `giveBack`, `ready`, `beforeSend`, `settle`), `client/shared/browser-runner.ts` (the claim, the fixed content, the permit's answer), `client/electron/features/browser/read-session.ts` (`writeThroughSession`: the permit inside the prepared write session, "not sent" only before `request.end`). Built and tested, **switched off; nothing in the app calls it yet** (6b-2d wires the card's press) |

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

1. The real model keeps every INVARIANT (TypeOK, R1–R6) and has no dead end; the rules checked are
   exactly `expected.txt`'s `rule` lines (dropping one fails); a `CHECK_DEADLOCK` line is refused.
2. Its distinct state count equals `states` (today **57,618**): a guard against a checker that
   explores less than it should.
3. R7 holds over all of those states (`reach.mjs` must walk the same number).
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
| `BrokenFailedOn4xx` | After a send the site refused (4xx) and the page looks unchanged, the app reports failed (the runner's branch `refused-by-site` before 6b-2c; removed there) | R4 |
| `BrokenFailedAfterSendError` | An error after the request left (no answer, a disconnect, an exception after `request.end`) is reported failed (6b-2c: `writeThroughSession` says "not sent" only before `request.end`; the runner settles the rest unknown) | R4 |
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
| `PlanLife.tla` / `PlanLife.cfg` | The model, its rules, the checker's settings and the `\* REACH` line |
| `reach.mjs` | R7 on the state graph |
| `expected.txt` | Rules, state count, each variant's expected result |
| `broken/`, `limits/`, `holes/`, `proposals/` | The variants |
| `check` | The entry point |
| `package.json`, `package-lock.json` | The checker (tla-ts 0.0.10, as in andon) |

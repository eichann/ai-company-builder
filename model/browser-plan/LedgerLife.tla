---- MODULE LedgerLife ----
\* THE WRITE LEDGER ACROSS REQUESTS (agent-browser.md "The write ledger across requests"). FramesLife.tla proves the
\* once-rules inside ONE run: a write whose answer was lost locks its run, and nothing more is sent in it. But a run ends
\* (its hour, the person's end, leaving), and the next request is a NEW run: without the ledger, "created, but the answer
\* was lost" → "ask again tomorrow" puts the same thing on the site twice. This model is that sequence: several runs of
\* one member, one after another (one run per company × domain at a time), each with at most one write to ONE target —
\* the target the ledger keys (company × domain × the member's outside account × the target's hash). Each action names
\* the function it copies in server/src/services/browser-frames.ts (`permit`'s ledger check, `settle`, `report`,
\* `confirm`, `end`, `memberLeft`) or client/electron/features/browser/work.ts (the read-back).
\*
\* Inside one run everything is FramesLife's (folded here: a permit, the last check, the send, the report). What this
\* model adds is only what crosses runs: a doubt (a write `permitted` / `unknown` with no answer of the person) keeps
\* every LATER run from a permit to that target — never by time (a run ending by its hour changes nothing) — until the
\* person answers (truthfully: they look at the site) or the site's answer comes (a late report, or the app's read-back,
\* which reports `done` only when the read shows the write landed).
\*
\* Left out (tested in the code instead): other targets and other accounts (they never meet the ledger's key: the
\* server tests "another target is not held up", "another member's account and another company are never mixed in");
\* the start's question on the card (the app's: it only asks the person earlier than the permit's refusal would); more
\* than one write per run and the operator (FramesLife); real durations (`live` folds the permit's 5 s and the 30 s after).
EXTENDS Naturals, FiniteSets

Runs == 1..3

VARIABLES
    exSt,     \* per run: none (not asked for yet), open, locked (its own write unknown), ended
    st,       \* per run: its one write to the target — none, permitted, done, notsent, unknown, refused
    lock,     \* per run: its in-flight slot (held while its write is permitted)
    ans,      \* per run: the person's answer about its write in doubt — none, done (済んでいた), notdone (されていなかった)
    live,     \* per run: its permit is still within its window (the app may send only within its 5 s)
    ph,       \* per run: the app — idle, permitted, sent, gone (crashed, quit, or the permit's answer lost)
    rep,      \* per run: a report in flight — none, done, notsent, unknown, refused
    sends,    \* per run: how often its write took effect on the site (capped at 2)
    knownAt   \* per run: the other runs whose write's result was known when this run's permit was given (history)

vars == <<exSt, st, lock, ans, live, ph, rep, sends, knownAt>>

Init ==
    /\ exSt = [r \in Runs |-> "none"] /\ st = [r \in Runs |-> "none"] /\ lock = [r \in Runs |-> "none"]
    /\ ans = [r \in Runs |-> "none"] /\ live = [r \in Runs |-> FALSE] /\ ph = [r \in Runs |-> "idle"]
    /\ rep = [r \in Runs |-> "none"] /\ sends = [r \in Runs |-> 0] /\ knownAt = [r \in Runs |-> {}]

\* A write in doubt: it may have been sent, and nobody knows whether it took effect (the ledger's `ledgerDoubts`).
Doubt(j) == st[j] \in {"permitted", "unknown"} /\ ans[j] = "none"
\* `permit`'s ledger check (`BROWSER_WRITE_IN_DOUBT`): no write of any run to this target in doubt — whatever that run's
\* state, ended runs included, however old.
LedgerGuard == \A j \in Runs : ~Doubt(j)

\* =========================== server ===========================

\* `start`: a new request (a new run) once the earlier ones ended and no write is on its way to the domain (`busy`).
Start(r) ==
    /\ exSt[r] = "none"
    /\ \A j \in Runs : j < r => exSt[j] = "ended"
    /\ \A j \in Runs : lock[j] = "none"
    /\ exSt' = [exSt EXCEPT ![r] = "open"]
    /\ UNCHANGED <<st, lock, ans, live, ph, rep, sends, knownAt>>

\* `permit`: the run open, its write not made yet, and the ledger check. Its answer may be lost (the app gives up).
Permit(r) ==
    /\ exSt[r] = "open" /\ st[r] = "none"
    /\ LedgerGuard
    /\ st' = [st EXCEPT ![r] = "permitted"] /\ lock' = [lock EXCEPT ![r] = "held"] /\ live' = [live EXCEPT ![r] = TRUE]
    /\ knownAt' = [knownAt EXCEPT ![r] = {j \in Runs : j # r /\ ~Doubt(j)}]
    /\ ph' \in {[ph EXCEPT ![r] = "permitted"], [ph EXCEPT ![r] = "gone"]}
    /\ UNCHANGED <<exSt, ans, rep, sends>>

\* The permit's window passes (its 5 s and the 30 s after them): the write can no longer be sent or be on its way.
Tick(r) ==
    /\ live[r]
    /\ live' = [live EXCEPT ![r] = FALSE]
    /\ UNCHANGED <<exSt, st, lock, ans, ph, rep, sends, knownAt>>

\* `settle`: a write permitted and silent past its window → unknown; its run locks.
ServerSettlesUnknown(r) ==
    /\ st[r] = "permitted" /\ ~live[r]
    /\ st' = [st EXCEPT ![r] = "unknown"] /\ lock' = [lock EXCEPT ![r] = "none"]
    /\ exSt' = [exSt EXCEPT ![r] = IF exSt[r] = "open" THEN "locked" ELSE exSt[r]]
    /\ UNCHANGED <<ans, live, ph, rep, sends, knownAt>>

\* `report` (judged after the time-outs): permitted + x → x (unknown locks the run); unknown + done / refused → that
\* (late and sure: the site's answer came after all — also the app's read-back `done`), unless the person answered first;
\* anything else kept.
ServerGetsReport(r) ==
    /\ rep[r] # "none" /\ ~(st[r] = "permitted" /\ ~live[r])
    /\ LET x == rep[r] IN
       CASE st[r] = "permitted" ->
              /\ st' = [st EXCEPT ![r] = x] /\ lock' = [lock EXCEPT ![r] = "none"]
              /\ exSt' = [exSt EXCEPT ![r] = IF x = "unknown" /\ exSt[r] = "open" THEN "locked" ELSE exSt[r]]
         [] st[r] = "unknown" /\ x \in {"done", "refused"} /\ ans[r] = "none" ->
              st' = [st EXCEPT ![r] = x] /\ UNCHANGED <<exSt, lock>>
         [] OTHER -> UNCHANGED <<st, exSt, lock>>
    /\ rep' = [rep EXCEPT ![r] = "none"]
    /\ UNCHANGED <<ans, live, ph, sends, knownAt>>

ReportLost(r) ==
    /\ rep[r] # "none"
    /\ rep' = [rep EXCEPT ![r] = "none"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, ph, sends, knownAt>>

\* `end` / the run's hour / `work-ended`: the run ends. The ledger is untouched: a doubt outlives its run.
RunEnds(r) ==
    /\ exSt[r] \in {"open", "locked"}
    /\ exSt' = [exSt EXCEPT ![r] = "ended"]
    /\ UNCHANGED <<st, lock, ans, live, ph, rep, sends, knownAt>>

\* `memberLeft`: the member's run ends and its write still permitted becomes unknown at once. Invited back later, the
\* member's next run meets the same ledger (a later `Start`).
MemberLeaves(r) ==
    /\ exSt[r] \in {"open", "locked"}
    /\ exSt' = [exSt EXCEPT ![r] = "ended"]
    /\ st' = [st EXCEPT ![r] = IF st[r] = "permitted" THEN "unknown" ELSE st[r]]
    /\ lock' = [lock EXCEPT ![r] = "none"]
    /\ UNCHANGED <<ans, live, ph, rep, sends, knownAt>>

\* `confirm`: the person answers about a write in doubt, once, past its window (it can no longer be on its way), from
\* the card — the earlier run's own card or the next request's question. They look at the site, so the answer is true.
PersonConfirms(r) ==
    /\ st[r] = "unknown" /\ ans[r] = "none" /\ ~live[r]
    /\ ans' = [ans EXCEPT ![r] = IF sends[r] > 0 THEN "done" ELSE "notdone"]
    /\ UNCHANGED <<exSt, st, lock, live, ph, rep, sends, knownAt>>

\* =========================== app ===========================

\* The last check, then the write goes out once (lost on the way, or it takes effect).
AppSends(r) ==
    /\ ph[r] = "permitted" /\ live[r]
    /\ sends' \in {sends, [sends EXCEPT ![r] = IF sends[r] < 2 THEN sends[r] + 1 ELSE 2]}
    /\ ph' = [ph EXCEPT ![r] = "sent"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, rep, knownAt>>

AppStopsBeforeSend(r) ==
    /\ ph[r] = "permitted"
    /\ rep' = [rep EXCEPT ![r] = "notsent"] /\ ph' = [ph EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, sends, knownAt>>

\* The site's answer: done (it took effect), refused (a 4xx: it did not), or none / anything else (unknown).
AppAfterSend(r) ==
    /\ ph[r] = "sent"
    /\ \E x \in (IF sends[r] > 0 THEN {"done", "unknown"} ELSE {"refused", "unknown"}) : rep' = [rep EXCEPT ![r] = x]
    /\ ph' = [ph EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, sends, knownAt>>

\* The read-back (work.ts `readBack`, `readBackLanded`): the write's own address, read before it and after, shows every
\* value it sent and a change — only when the write took effect — → the app reports `done` (reason `read-back`).
AppReadsBack(r) ==
    /\ st[r] = "unknown" /\ ans[r] = "none" /\ rep[r] = "none"
    /\ sends[r] > 0
    /\ rep' = [rep EXCEPT ![r] = "done"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, ph, sends, knownAt>>

AppCrashes(r) ==
    /\ ph[r] \in {"permitted", "sent"}
    /\ ph' = [ph EXCEPT ![r] = "gone"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, rep, sends, knownAt>>

Done ==
    /\ \A r \in Runs : exSt[r] = "ended" /\ ph[r] \in {"idle", "gone"} /\ rep[r] = "none" /\ lock[r] = "none"
    /\ UNCHANGED vars

ServerNext == \E r \in Runs : Start(r) \/ Permit(r) \/ Tick(r) \/ ServerSettlesUnknown(r) \/ ServerGetsReport(r) \/ ReportLost(r)
                               \/ RunEnds(r) \/ MemberLeaves(r) \/ PersonConfirms(r)
AppNext == \E r \in Runs : AppSends(r) \/ AppStopsBeforeSend(r) \/ AppAfterSend(r) \/ AppReadsBack(r) \/ AppCrashes(r)

Next == ServerNext \/ AppNext \/ Done

Spec == Init /\ [][Next]_vars

\* =========================== rules ===========================

TypeOK ==
    /\ exSt \in [Runs -> {"none", "open", "locked", "ended"}]
    /\ st \in [Runs -> {"none", "permitted", "done", "notsent", "unknown", "refused"}]
    /\ lock \in [Runs -> {"none", "held"}]
    /\ ans \in [Runs -> {"none", "done", "notdone"}]
    /\ live \in [Runs -> BOOLEAN]
    /\ ph \in [Runs -> {"idle", "permitted", "sent", "gone"}]
    /\ rep \in [Runs -> {"none", "done", "notsent", "unknown", "refused"}]
    /\ sends \in [Runs -> 0..2]
    /\ knownAt \in [Runs -> SUBSET Runs]

\* R1 Each write reaches the site at most once (FramesLife's, kept here across runs)
R1_AtMostOneSendPerWrite == \A r \in Runs : sends[r] <= 1

\* R17 No blind duplicate: two runs' writes to one target both took effect only when the later one (runs come one after
\*     another) was permitted with the earlier one's result already known (done, not sent, refused, or answered) — never
\*     while nobody knew, whatever time passed or however the earlier run ended.
R17_NoBlindDuplicate == \A j, r \in Runs : (j < r /\ sends[j] > 0 /\ sends[r] > 0) => j \in knownAt[r]

\* R18 Counted done only if it landed: a write the server holds `done` (the site's answer or the read-back) or the person
\*     answered 済んでいた about took effect on the site.
R18_DoneMeansLanded == \A r \in Runs : (st[r] = "done" \/ ans[r] = "done") => sends[r] > 0

\* R5 A write answered されていなかった did not take effect, later either.
R5_NotDoneStaysTrue == \A r \in Runs : ans[r] = "notdone" => sends[r] = 0

\* R7 From every reachable state a settled one can be reached (reach.mjs, the same predicate for every model): every app
\*    step idle or gone, every run not started or ended, every in-flight slot free.
Settled ==
    /\ \A r \in Runs : ph[r] \in {"idle", "gone"} /\ exSt[r] \in {"none", "ended"} /\ lock[r] = "none"

====

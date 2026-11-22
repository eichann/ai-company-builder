---- MODULE PlanLife ----
\* The life of one 「ブラウザ操作」 plan — register, approve, claim, send permit, send, report, confirm —
\* and the rules it keeps. Copied BY HAND from the code and the design; each action names what it
\* copies. A PR that changes the lifecycle changes this file in the same PR (agent-browser.md "The plan model").
\*   Server: server/src/services/browser-plans.ts (PR 6a; the clock fix of 6b-2a), with the states and times of
\*           shared/core/browser-plans.ts (BrowserPlanState, BrowserExecutionState, BROWSER_PLAN_TIMES).
\*   App:    the approved 6b-2 design (internal design memo, 6b-2 §3 and §5). Nothing in the app calls
\*           the server's plans yet: today's runner (client/electron/features/browser/runner.ts, with
\*           client/shared/browser-runner.ts) is replaced by 6b-2; until then the App actions below
\*           describe the design, not shipped code (README "What the model copies").
\* One target (one reminder step). Two plans (p2 = the person asks again, or two asked at once).
\* Two apps (a2 = the same member's second PC, or the app restarted). Time is counted as "elapsed since
\* the permit", capped. What is left out: README "What the model leaves out".
EXTENDS Naturals

Plans == {"p1", "p2"}
Apps == {"a1", "a2"}
\* Abstract time units. PERMIT = the 5 s permit, GRACE = the 30 s grace (BROWSER_PLAN_TIMES.permit /
\* .grace). Only PERMIT < PERMIT + GRACE matters, not the ratio.
PERMIT == 1
GRACE == 1
CAP == PERMIT + GRACE
Min(x, y) == IF x < y THEN x ELSE y

VARIABLES
    \* ---- server (browser_plans, browser_executions, browser_target_locks) ----
    planSt,       \* plan: none (not yet made), draft, approved, claimed, closed, done
    approvedEver, \* the member approved it at some point (history read by R2)
    exSt,         \* execution: none, claimed, permitted, unknown, succeeded, failed,
                  \*   cdone (confirmed_done), cnotdone (confirmed_not_done), void
    holder,       \* the app that claimed the execution (= received the execution's secret)
    lock,         \* the plan holding the target lock ("none" = free)
    srvAge,       \* elapsed since the permit by the server's WALL clock (capped at CAP; may jump forward)
    realAge,      \* elapsed since the permit in reality = the server's MONOTONIC clock (6b-2a)
    \* ---- network ----
    permitReq,    \* a send-permit request in flight (may arrive late, even after the app gave up)
    rep,          \* a report in flight: none, succeeded, failed, unknown (may arrive again, or be lost)
    \* ---- app (main process) ----
    ph,           \* idle, claimed (holds the secret), checked (re-read the facts: unchanged),
                  \*   asking (asked for the permit), permitted (got it), sent
    ap,           \* the plan that app is working on
    el,           \* elapsed since just before asking for the permit (the app's clocks; capped at PERMIT)
    \* ---- the site (what really happened) ----
    sends,        \* how many times this plan's write reached the site (capped at 2)
    landed,       \* this plan's write changed the site
    site,         \* the target: before (as when the plan was made), after (as planned), other
    edited,       \* a person changed the target directly on the site's own screen (at most once)
    badSend       \* a send happened without approval and a live permit (history read by R2)

vars == <<planSt, approvedEver, exSt, holder, lock, srvAge, realAge, permitReq, rep, ph, ap, el, sends, landed, site, edited, badSend>>
srvVars == <<planSt, approvedEver, exSt, holder, lock, srvAge, realAge>>
appVars == <<ph, ap, el>>
siteVars == <<sends, landed, site, edited, badSend>>

Init ==
    /\ planSt = [p \in Plans |-> "none"] /\ approvedEver = [p \in Plans |-> FALSE]
    /\ exSt = [p \in Plans |-> "none"] /\ holder = [p \in Plans |-> "none"] /\ lock = "none"
    /\ srvAge = [p \in Plans |-> 0] /\ realAge = [p \in Plans |-> 0]
    /\ permitReq = [p \in Plans |-> FALSE] /\ rep = [p \in Plans |-> "none"]
    /\ ph = [a \in Apps |-> "idle"] /\ ap = [a \in Apps |-> "none"] /\ el = [a \in Apps |-> 0]
    /\ sends = [p \in Plans |-> 0] /\ landed = [p \in Plans |-> FALSE]
    /\ site = "before" /\ edited = FALSE /\ badSend = FALSE

\* browser-plans.ts finish: the execution moves to a final state, only ITS lock goes, the plan is done
Fin(p, to) ==
    /\ exSt' = [exSt EXCEPT ![p] = to]
    /\ lock' = IF lock = p THEN "none" ELSE lock
    /\ planSt' = [planSt EXCEPT ![p] = "done"]

ToIdle(a) == ph' = [ph EXCEPT ![a] = "idle"] /\ ap' = [ap EXCEPT ![a] = "none"] /\ el' = [el EXCEPT ![a] = 0]

\* =========================== server ===========================

\* browser-plans.ts register (POST /browser-plans): a draft from the facts the checker read. The facts
\* are the target as it was when the plan was made (before).
Register(p) ==
    /\ planSt[p] = "none" /\ site = "before"
    /\ planSt' = [planSt EXCEPT ![p] = "draft"]
    /\ UNCHANGED <<approvedEver, exSt, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* browser-plans.ts approve: the member approves on the card; the hash they saw equals the current one;
\* compare-and-set draft -> approved.
Approve(p) ==
    /\ planSt[p] = "draft"
    /\ planSt' = [planSt EXCEPT ![p] = "approved"] /\ approvedEver' = [approvedEver EXCEPT ![p] = TRUE]
    /\ UNCHANGED <<exSt, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* browser-plans.ts cancel (「やめる」), settlePlan (an hour after creation) or memberLeft: draft / approved -> closed
CloseOpen(p) ==
    /\ planSt[p] \in {"draft", "approved"}
    /\ planSt' = [planSt EXCEPT ![p] = "closed"]
    /\ UNCHANGED <<approvedEver, exSt, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* browser-plans.ts claim (the same press as approving, in the app): only approved and only while the
\* lock is free; execution, secret and lock in one transaction. The answer arrives or is lost (then the
\* plan is used up: the secret is never sent again). A timed-out holder is settled first (VoidClaimed).
Claim(a, p) ==
    /\ ph[a] = "idle" /\ planSt[p] = "approved" /\ lock = "none"
    /\ planSt' = [planSt EXCEPT ![p] = "claimed"]
    /\ exSt' = [exSt EXCEPT ![p] = "claimed"] /\ holder' = [holder EXCEPT ![p] = a] /\ lock' = p
    /\ \/ ph' = [ph EXCEPT ![a] = "claimed"] /\ ap' = [ap EXCEPT ![a] = p]
       \/ UNCHANGED <<ph, ap>>
    /\ UNCHANGED <<approvedEver, srvAge, realAge, permitReq, rep, el, siteVars>>

\* claimed -> void: browser-plans.ts cancel, settleExecution (2 minutes after the claim, or the plan's
\* hour), memberLeft. No permit was given, so nothing was sent.
VoidClaimed(p) ==
    /\ exSt[p] = "claimed"
    /\ Fin(p, "void")
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* browser-plans.ts permit (send-permit): only the app holding the secret gets here. claimed -> permitted
\* once (the time is the server's clock), or the gate refuses (AI stopped, setting, grant, retired
\* combination, app version) and the execution becomes void. Not claimed: refused (BROWSER_PERMIT_USED, ...).
\* The answer reaches the asking app if it is still waiting, or is lost.
AnswerTo(p, newPh) ==
    LET a == holder[p] IN
    \/ /\ ph[a] = "asking" /\ ap[a] = p
       /\ IF newPh = "idle" THEN ToIdle(a) ELSE (ph' = [ph EXCEPT ![a] = newPh] /\ UNCHANGED <<ap, el>>)
    \/ UNCHANGED appVars

ServerPermits(p) ==
    /\ permitReq[p] /\ exSt[p] = "claimed"
    /\ permitReq' = [permitReq EXCEPT ![p] = FALSE]
    /\ exSt' = [exSt EXCEPT ![p] = "permitted"]
    /\ srvAge' = [srvAge EXCEPT ![p] = 0] /\ realAge' = [realAge EXCEPT ![p] = 0]
    /\ AnswerTo(p, "permitted")
    /\ UNCHANGED <<planSt, approvedEver, holder, lock, rep, siteVars>>

ServerRefusesPermit(p) ==
    /\ permitReq[p]
    /\ permitReq' = [permitReq EXCEPT ![p] = FALSE]
    /\ IF exSt[p] = "claimed"
         THEN Fin(p, "void")
         ELSE UNCHANGED <<exSt, lock, planSt>>
    /\ AnswerTo(p, "idle")
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, rep, siteVars>>

\* browser-plans.ts pastWindow (6b-2a, the clock fix): permit + 5 s + 30 s have passed on BOTH the
\* server's wall clock and its monotonic clock (since the permit on the same process start, since the
\* start after a restart: never earlier than the real elapsed time, so realAge is the safe reading).
Past(p) == srvAge[p] >= CAP /\ realAge[p] >= CAP

\* browser-plans.ts settleExecution: permitted and silent past the window (Past) -> unknown. Judged on
\* every read and touch.
ServerSettlesUnknown(p) ==
    /\ exSt[p] = "permitted" /\ Past(p)
    /\ exSt' = [exSt EXCEPT ![p] = "unknown"]
    /\ UNCHANGED <<planSt, approvedEver, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* browser-plans.ts report (the secret alone; also after the member left): time-outs are judged first.
\* permitted: succeeded / failed are final, unknown -> unknown. unknown: only succeeded moves it.
\* Anything else is recorded only (the state does not change).
ServerGetsReport(p) ==
    /\ rep[p] # "none"
    /\ LET r == rep[p]
           s == IF exSt[p] = "permitted" /\ Past(p) THEN "unknown" ELSE exSt[p]
       IN IF s = "permitted" /\ r \in {"succeeded", "failed"} THEN Fin(p, r)
          ELSE IF s = "permitted" /\ r = "unknown" THEN (exSt' = [exSt EXCEPT ![p] = "unknown"] /\ UNCHANGED <<lock, planSt>>)
          ELSE IF s = "unknown" /\ r = "succeeded" THEN Fin(p, "succeeded")
          ELSE (exSt' = [exSt EXCEPT ![p] = s] /\ UNCHANGED <<lock, planSt>>)
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* A report is lost (all of the app's resends fail)
ReportLost(p) ==
    /\ rep[p] # "none"
    /\ rep' = [rep EXCEPT ![p] = "none"]
    /\ UNCHANGED <<srvVars, permitReq, appVars, siteVars>>

\* browser-plans.ts confirm 「確かめた」: only unknown and only past the window on both clocks (Past).
\* The person looks at the site and answers truthfully.
PersonConfirms(p) ==
    /\ exSt[p] = "unknown" /\ Past(p)
    /\ Fin(p, IF landed[p] THEN "cdone" ELSE "cnotdone")
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* Time passes (since the permit, and since the app's last clock reading before asking)
Tick ==
    /\ \/ \E p \in Plans : exSt[p] \in {"permitted", "unknown"} /\ (srvAge[p] < CAP \/ realAge[p] < CAP)
       \/ \E a \in Apps : ph[a] \in {"asking", "permitted"} /\ el[a] < PERMIT
    /\ srvAge' = [p \in Plans |-> IF exSt[p] \in {"permitted", "unknown"} THEN Min(srvAge[p] + 1, CAP) ELSE srvAge[p]]
    /\ realAge' = [p \in Plans |-> IF exSt[p] \in {"permitted", "unknown"} THEN Min(realAge[p] + 1, CAP) ELSE realAge[p]]
    /\ el' = [a \in Apps |-> IF ph[a] \in {"asking", "permitted"} THEN Min(el[a] + 1, PERMIT) ELSE el[a]]
    /\ UNCHANGED <<planSt, approvedEver, exSt, holder, lock, permitReq, rep, ph, ap, siteVars>>

\* =========================== app (6b-2 design) ===========================

\* The app crashes or quits at any step. The secret lives only in memory and is lost (no report:
\* the server's time-outs settle it).
AppCrashes(a) ==
    /\ ph[a] # "idle"
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, rep, siteVars>>

\* Design 6b-2 §5.2: after the claim, re-read every fixed fact and compare. Unchanged: may ask for the permit.
AppRereadSame(a) ==
    /\ ph[a] = "claimed" /\ site = "before"
    /\ ph' = [ph EXCEPT ![a] = "checked"]
    /\ UNCHANGED <<srvVars, permitReq, rep, ap, el, siteVars>>

\* Stop before the permit: facts changed, context changed, the conversation stopped, the member pressed
\* 「やめる」. Sends cancel (void if it arrives; otherwise void 2 minutes after the claim). No report.
AppDropsBeforePermit(a) ==
    /\ ph[a] \in {"claimed", "checked"}
    /\ ToIdle(a)
    /\ \/ (exSt[ap[a]] = "claimed" /\ Fin(ap[a], "void"))
       \/ UNCHANGED <<exSt, lock, planSt>>
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, siteVars>>

\* Ask for the permit (both clocks read just before; no automatic retry)
AppAsksPermit(a) ==
    /\ ph[a] = "checked"
    /\ ph' = [ph EXCEPT ![a] = "asking"] /\ el' = [el EXCEPT ![a] = 0]
    /\ permitReq' = [permitReq EXCEPT ![ap[a]] = TRUE]
    /\ UNCHANGED <<srvVars, rep, ap, siteVars>>

\* No permit answer within 5 s: do not send; report failed (permit-unanswered). The request may still arrive.
AppPermitUnanswered(a) ==
    /\ ph[a] = "asking" /\ el[a] >= PERMIT
    /\ rep' = [rep EXCEPT ![ap[a]] = "failed"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

\* Send (beforeSend: under 5 s by both clocks, same context, not stopped; then request.end with no await
\* in between). The write is lost, or arrives and the site changes, or arrives and the site refuses it.
AppSends(a) ==
    /\ ph[a] = "permitted" /\ el[a] < PERMIT
    /\ LET p == ap[a] IN
       /\ badSend' = (badSend \/ ~(approvedEver[p] /\ exSt[p] = "permitted" /\ holder[p] = a /\ realAge[p] < PERMIT))
       /\ \/ UNCHANGED <<sends, landed, site>>
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)] /\ landed' = [landed EXCEPT ![p] = TRUE]
             /\ site' = IF site = "before" THEN "after" ELSE "other"
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)]
             /\ UNCHANGED <<landed, site>>
    /\ ph' = [ph EXCEPT ![a] = "sent"]
    /\ UNCHANGED <<srvVars, permitReq, rep, ap, el, edited>>

\* After the permit, the last check before sending stops it (permit-late, context-changed, stopped):
\* nothing went out. Report failed.
AppStopsBeforeSend(a) ==
    /\ ph[a] = "permitted"
    /\ rep' = [rep EXCEPT ![ap[a]] = "failed"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

\* After the send: everything read and as planned (after) = succeeded. Anything else (unreadable, 4xx,
\* unchanged, another state) = unknown — never failed once the write may have gone out.
AppReadsAfter(a) ==
    /\ ph[a] = "sent"
    /\ rep' = [rep EXCEPT ![ap[a]] = IF site = "after" THEN "succeeded" ELSE "unknown"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

\* The read after the send failed (reread-failed): unknown
AppRereadAfterFails(a) ==
    /\ ph[a] = "sent"
    /\ rep' = [rep EXCEPT ![ap[a]] = "unknown"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

\* =========================== surroundings ===========================

\* A person changes the target directly on the site (any time, at most once)
SomeoneEdits ==
    /\ ~edited
    /\ site' = "other" /\ edited' = TRUE
    /\ UNCHANGED <<srvVars, permitReq, rep, appVars, sends, landed, badSend>>

\* Nothing left to do (a stutter step so that the deadlock check does not call this a dead end)
\* The environment: the server's wall clock jumps FORWARD by 35 s or more right after a permit (a
\* one-shot NTP correction, a VM's time sync). Only srvAge moves; the monotonic clock (realAge) does not.
\* With Past requiring both, the server does not turn the execution unknown or take 「確かめた」 early
\* (6a judged by the wall clock alone and broke R5 here; broken/BrokenNoMonotonicWindow).
ServerClockJumps(p) ==
    /\ exSt[p] = "permitted" /\ srvAge[p] < CAP
    /\ srvAge' = [srvAge EXCEPT ![p] = CAP]
    /\ UNCHANGED <<planSt, approvedEver, exSt, holder, lock, realAge, permitReq, rep, appVars, siteVars>>

Done ==
    /\ \A a \in Apps : ph[a] = "idle"
    /\ \A p \in Plans : exSt[p] \notin {"claimed", "permitted", "unknown"} /\ rep[p] = "none" /\ ~permitReq[p]
    /\ UNCHANGED vars

ServerNext ==
    \E p \in Plans :
        \/ Register(p) \/ Approve(p) \/ CloseOpen(p) \/ VoidClaimed(p)
        \/ ServerPermits(p) \/ ServerRefusesPermit(p) \/ ServerSettlesUnknown(p)
        \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p) \/ ServerClockJumps(p)

AppNext ==
    \E a \in Apps :
        \/ AppCrashes(a) \/ AppRereadSame(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
        \/ AppPermitUnanswered(a) \/ AppSends(a) \/ AppStopsBeforeSend(a) \/ AppReadsAfter(a) \/ AppRereadAfterFails(a)

ClaimNext == \E a \in Apps, p \in Plans : Claim(a, p)

Next == ServerNext \/ ClaimNext \/ AppNext \/ Tick \/ SomeoneEdits \/ Done

Spec == Init /\ [][Next]_vars

\* =========================== rules ===========================

TypeOK ==
    /\ planSt \in [Plans -> {"none", "draft", "approved", "claimed", "closed", "done"}]
    /\ approvedEver \in [Plans -> BOOLEAN]
    /\ exSt \in [Plans -> {"none", "claimed", "permitted", "unknown", "succeeded", "failed", "cdone", "cnotdone", "void"}]
    /\ holder \in [Plans -> Apps \cup {"none"}]
    /\ lock \in Plans \cup {"none"}
    /\ srvAge \in [Plans -> 0..CAP] /\ realAge \in [Plans -> 0..CAP]
    /\ permitReq \in [Plans -> BOOLEAN] /\ rep \in [Plans -> {"none", "succeeded", "failed", "unknown"}]
    /\ ph \in [Apps -> {"idle", "claimed", "checked", "asking", "permitted", "sent"}]
    /\ ap \in [Apps -> Plans \cup {"none"}] /\ el \in [Apps -> 0..PERMIT]
    /\ sends \in [Plans -> 0..2] /\ landed \in [Plans -> BOOLEAN]
    /\ site \in {"before", "after", "other"} /\ edited \in BOOLEAN /\ badSend \in BOOLEAN

\* R1 One plan's write reaches the site at most once
R1_AtMostOneSendPerPlan == \A p \in Plans : sends[p] <= 1

\* R2 Nothing is sent without approval and a live permit (that execution permitted, the claiming app,
\*    under 5 s since the permit)
R2_NoSendWithoutApprovalAndLivePermit == ~badSend

\* R3 On one target, at most one execution is open (claimed, permitted, unknown). While one is
\*    "unknown" no other starts (what is not known is never retried automatically)
R3_OneOpenExecutionPerTarget ==
    \A p, q \in Plans : (p # q /\ exSt[p] \in {"claimed", "permitted", "unknown"}) => exSt[q] \notin {"claimed", "permitted", "unknown"}

\* R4 A failed ("not sent") execution's write never reached the site
R4_FailedOnlyIfNotSent == \A p \in Plans : exSt[p] = "failed" => sends[p] = 0

\* R5 An execution confirmed "not done" did not change the site later either (a confirmation never
\*    turns false afterwards)
R5_NotDoneStaysTrue == \A p \in Plans : exSt[p] = "cnotdone" => ~landed[p]

\* R6 The same change never lands twice (the site is "other" only when a person changed it directly)
R6_NoDoubleApply == site = "other" => edited

\* R7 From every reachable state, a settled state (every app idle, no execution claimed / permitted /
\*    unknown, the lock free) can be reached. Not a state formula: reach.mjs reads the checker's state
\*    graph (the "\* REACH" line of PlanLife.cfg). Settled is the same predicate reach.mjs applies.
Settled ==
    /\ \A a \in Apps : ph[a] = "idle"
    /\ \A p \in Plans : exSt[p] \notin {"claimed", "permitted", "unknown"}
    /\ lock = "none"

====

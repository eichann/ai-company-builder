---- MODULE StepsLife ----
\* The life of one execution with SEVERAL ORDERED WRITES (browser operation generalization, PR 1): the
\* execution and write-state table of agent-browser.md "Executions with several writes" in TLA+.
\* DESIGN AHEAD OF CODE: nothing implements it yet. The server half lands in PR 4 (shape-2 plans, a permit
\* and a report per write, the common lock key), the app half in PR 5 (the writes in order, finding what
\* was created). Until then this model IS the contract those PRs copy; each action names the state-table
\* row it is. PlanLife.tla stays the copy of today's one-write code (lstep@0.6.x), unchanged.
\*
\* No site is named: "an existing object" (E), "a folder" (where a create lands), "what this execution
\* created" (ours) and "what a person created meanwhile in the same folder" (theirs) are the map's words.
\* Site properties (whether a create re-uses a child something else already references) are assumptions
\* outside the model, checked per site by its map's reviewed promise and a test object (design C2, C15).
\*
\* Two plans: p1 = a new-path plan of three ordered writes; its shape is one of two candidates, one that
\* keeps the harmless-prefix rule (create a child, change it, change E last) and one that does not
\* (create, change E, change the child): the line judge must keep the second from ever running.
\* p2 = an old-path plan (today's one write) to the same E: both paths must take the same lock key (C11).
\* p2's own life (approval, permit, report, confirm) is PlanLife's, folded into claim -> write -> end.
\* One app runs p1 (a second PC cannot hold the plan: claim once, PlanLife R1-R3). Abstract time as in
\* PlanLife. The execution's "confirmed" stands for confirmed_done / confirmed_not_done (the write's
\* state says which). What is left out: README "What StepsLife leaves out".
EXTENDS Naturals

Plans == {"p1", "p2"}
NewPlans == {"p1"}  \* the plans with the several-writes life (p2's life is PlanLife's, folded: OldPath*)
Idx == 1..3
PERMIT == 1         \* one write's 5 s permit (BROWSER_PLAN_TIMES.permit)
GRACE == 1          \* the 30 s grace after it
CAP == PERMIT + GRACE
LIMIT == CAP + 1    \* the whole plan's limit counted from its first permit (design §4-2: about 2 minutes)
Min(x, y) == IF x < y THEN x ELSE y

\* The candidate shapes of p1 (design §4-1). "create" = create a child in a folder; "updC" = change what
\* this execution created; "updE" = change an object that existed before the plan.
GoodShape == [k \in Idx |-> CASE k = 1 -> "create" [] k = 2 -> "updC" [] OTHER -> "updE"]
BadShape  == [k \in Idx |-> CASE k = 1 -> "create" [] k = 2 -> "updE" [] OTHER -> "updC"]
Shapes == {GoodShape, BadShape}
Last(p) == IF p = "p1" THEN 3 ELSE 1
Steps(p) == 1..Last(p)
Open == {"claimed", "running", "unknown"}
Keys == {"E", "Eold"}

VARIABLES
    shape,        \* p1's shape (chosen once: the line as written)
    \* ---- server (browser_executions + the per-write table of PR 4) ----
    planSt,       \* approved, claimed, done
    exSt,         \* execution: none, claimed, running, unknown, succeeded, partial, failed, confirmed, void
    st,           \* per write: pending, permitted, done, notsent, unknown, cdone, cnotdone, skipped, na
    age,          \* elapsed since the permit of the write now permitted / unknown (capped at CAP)
    ageFirst,     \* elapsed since the execution's first permit (capped at LIMIT)
    made,         \* what the server recorded as created by p: none, ours (this execution's new object), theirs
    lock,         \* lock key -> the plan holding it
    everUnknown,  \* history: the execution was unknown at some point
    contAfter,    \* history: a write was permitted after the execution had been unknown
    \* ---- network ----
    permitReq,    \* the write a permit request in flight is for (0 = none)
    rep,          \* per write: a report in flight: none, done, notsent, unknown (may come again, late, or never)
    repMade,      \* what the create write's done report names as created
    \* ---- app (main process), one per plan ----
    ph,           \* idle (not started), ready (claimed, before the next write), asking, permitted, sent, gone
    cur,          \* the write the app is at
    \* ---- the site ----
    eSt,          \* the existing object: before, after (as planned), other
    ours,         \* what this execution created: absent, made, changed
    oursShared,   \* the site made "ours" re-using a child something else already references (C1)
    theirs,       \* a person's own new object in the same folder: absent, made, changed
    sends,        \* per write: how many times it reached the site (capped at 2)
    landed,       \* per write: it changed the site
    edited,       \* a person changed E directly (at most once)
    badSend       \* history: a send without a live permit for that write

vars == <<shape, planSt, exSt, st, age, ageFirst, made, lock, everUnknown, contAfter, permitReq, rep, repMade,
          ph, cur, eSt, ours, oursShared, theirs, sends, landed, edited, badSend>>
srvVars == <<planSt, exSt, st, age, ageFirst, made, lock, everUnknown, contAfter>>
netVars == <<permitReq, rep, repMade>>
appVars == <<ph, cur>>
siteVars == <<eSt, ours, oursShared, theirs, sends, landed, edited, badSend>>

Kind(p, k) == IF p = "p1" THEN shape[k] ELSE IF k = 1 THEN "updE" ELSE "na"

\* The line judge (design §4-1, I4; PR 2's browserLineProblem, at approval and when the server loads the
\* list): before the last write, a plan writes only to what it created itself; a change of what it created
\* comes after the create.
HarmlessPrefix(p) ==
    /\ \A k \in Steps(p) : k < Last(p) => Kind(p, k) \in {"create", "updC"}
    /\ \A k \in Steps(p) : Kind(p, k) = "updC" => \E j \in 1..(k - 1) : Kind(p, j) = "create"

\* C11: the lock key comes from the map (company, host, account, object kind, id), the same on both paths
KeyE(p) == "E"

Init ==
    /\ shape \in Shapes
    /\ planSt = [p \in Plans |-> "approved"] /\ exSt = [p \in Plans |-> "none"]
    /\ st = [p \in Plans |-> [k \in Idx |-> IF k \in Steps(p) THEN "pending" ELSE "na"]]
    /\ age = [p \in Plans |-> 0] /\ ageFirst = [p \in Plans |-> 0]
    /\ made = [p \in Plans |-> "none"] /\ lock = [x \in Keys |-> "none"]
    /\ everUnknown = [p \in Plans |-> FALSE] /\ contAfter = [p \in Plans |-> FALSE]
    /\ permitReq = [p \in Plans |-> 0] /\ rep = [p \in Plans |-> [k \in Idx |-> "none"]]
    /\ repMade = [p \in Plans |-> "none"]
    /\ ph = [p \in Plans |-> "idle"] /\ cur = [p \in Plans |-> 1]
    /\ eSt = "before" /\ ours = "absent" /\ oursShared = FALSE /\ theirs = "absent"
    /\ sends = [p \in Plans |-> [k \in Idx |-> 0]] /\ landed = [p \in Plans |-> [k \in Idx |-> FALSE]]
    /\ edited = FALSE /\ badSend = FALSE

\* ---- helpers for the server's state table ----
\* A final state: only p's locks go, the plan is done
Fin(p, to) ==
    /\ exSt' = [exSt EXCEPT ![p] = to]
    /\ lock' = [x \in Keys |-> IF lock[x] = p THEN "none" ELSE lock[x]]
    /\ planSt' = [planSt EXCEPT ![p] = "done"]
\* The writes after k that were never permitted become "skipped" (never tried; never sent)
Row(p, k, s) == [j \in Idx |-> IF j = k THEN s ELSE IF j > k /\ st[p][j] = "pending" THEN "skipped" ELSE st[p][j]]
\* Write k-1's state ("done" before the first write: nothing has to come before it)
Prev(p, k) == IF k > 1 THEN st[p][k - 1] ELSE "done"
\* From write k on, the writes never permitted become "skipped"; the ones before k stay as they are
Keep(p, k) == [j \in Idx |-> IF j >= k /\ st[p][j] = "pending" THEN "skipped" ELSE st[p][j]]
NoneOpen(p) ==\A k \in Idx : st[p][k] \notin {"permitted", "unknown"}
Past(p) == age[p] >= CAP

AnswerTo(p, newPh) ==
    \/ ph[p] = "asking" /\ ph' = [ph EXCEPT ![p] = newPh] /\ UNCHANGED cur
    \/ UNCHANGED appVars

\* =========================== server ===========================

\* Claim: once per plan; only a line the judge accepts (a line that does not is never loaded); every lock
\* key the plan names in one transaction (busy -> nothing changes). The answer may be lost.
Claim(p) ==
    /\ planSt[p] = "approved" /\ HarmlessPrefix(p) /\ lock[KeyE(p)] = "none"
    /\ planSt' = [planSt EXCEPT ![p] = "claimed"] /\ exSt' = [exSt EXCEPT ![p] = "claimed"]
    /\ lock' = [lock EXCEPT ![KeyE(p)] = p]
    /\ \/ ph' = [ph EXCEPT ![p] = "ready"]
       \/ UNCHANGED ph
    /\ UNCHANGED <<shape, st, age, ageFirst, made, everUnknown, contAfter, netVars, cur, siteVars>>

\* Row "claimed -> void": cancel, the 2-minute claim limit, leaving. No permit: nothing sent.
VoidClaimed(p) ==
    /\ exSt[p] = "claimed"
    /\ Fin(p, "void")
    /\ UNCHANGED <<shape, st, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

\* Row "permit write k": the execution claimed (k = 1) or running, write k pending, write k-1 DONE
\* (reported done and recorded; I5, R8), no write permitted or unknown, the whole plan's limit not past.
\* claimed/running -> running, write k -> permitted. A permit is given once per write.
ServerPermits(p) ==
    \E k \in Idx :
    /\ permitReq[p] = k /\ exSt[p] \in {"claimed", "running"} /\ st[p][k] = "pending"
    /\ Prev(p, k) = "done" /\ NoneOpen(p)
    /\ (exSt[p] = "claimed" \/ ageFirst[p] < LIMIT)
    /\ permitReq' = [permitReq EXCEPT ![p] = 0]
    /\ st' = [st EXCEPT ![p][k] = "permitted"] /\ exSt' = [exSt EXCEPT ![p] = "running"]
    /\ age' = [age EXCEPT ![p] = 0]
    /\ ageFirst' = IF k = 1 THEN [ageFirst EXCEPT ![p] = 0] ELSE ageFirst
    /\ contAfter' = [contAfter EXCEPT ![p] = contAfter[p] \/ everUnknown[p]]
    /\ AnswerTo(p, "permitted")
    /\ UNCHANGED <<shape, planSt, made, lock, everUnknown, rep, repMade, siteVars>>

\* Row "permit asked while write k-1 is still permitted" (its report not in yet): "not yet", nothing
\* changes; the app may ask again (a permit is still given once per write).
ServerSaysNotYet(p) ==
    \E k \in Idx :
    /\ permitReq[p] = k /\ Prev(p, k) = "permitted"
    /\ permitReq' = [permitReq EXCEPT ![p] = 0]
    /\ AnswerTo(p, "ready")
    /\ UNCHANGED <<shape, srvVars, rep, repMade, siteVars>>

\* Row "the gate refuses a permit" (AI stopped, setting, grant, retired line, app version, the plan's
\* limit): claimed -> void; running with nothing open -> partial (the writes so far done, the rest
\* skipped); a write open -> the execution is left to its report / time-out.
ServerRefusesPermit(p) ==
    \E k \in Idx :
    /\ permitReq[p] = k
    /\ permitReq' = [permitReq EXCEPT ![p] = 0]
    /\ IF exSt[p] = "claimed"
         THEN Fin(p, "void") /\ UNCHANGED st
         ELSE IF exSt[p] = "running" /\ NoneOpen(p)
           THEN Fin(p, "partial") /\ st' = [st EXCEPT ![p] = Keep(p, k)]
           ELSE UNCHANGED <<exSt, lock, planSt, st>>
    /\ AnswerTo(p, "gone")
    /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, rep, repMade, siteVars>>

\* Row "permitted and silent past the window": write k -> unknown, the rest skipped, the execution
\* unknown (for good: it never runs again, R10). Counted from THIS write's permit (the last time
\* something could have been sent), not from the first.
ServerSettlesUnknown(p) ==
    \E k \in Idx :
        /\ st[p][k] = "permitted" /\ Past(p)
        /\ st' = [st EXCEPT ![p] = Row(p, k, "unknown")]
        /\ exSt' = [exSt EXCEPT ![p] = "unknown"] /\ everUnknown' = [everUnknown EXCEPT ![p] = TRUE]
        /\ UNCHANGED <<shape, planSt, age, ageFirst, made, lock, contAfter, netVars, appVars, siteVars>>

\* Row "running, nothing open, the next write never asked within the plan's limit" (the app stopped or
\* crashed between two writes, C12): partial. The writes so far are done for sure, the rest never sent.
ServerEndsGap(p) ==
    /\ exSt[p] = "running" /\ NoneOpen(p) /\ ageFirst[p] >= LIMIT
    /\ \E k \in Idx :
        /\ st[p][k] = "pending" /\ Prev(p, k) = "done"
        /\ st' = [st EXCEPT ![p] = Keep(p, k)]
    /\ Fin(p, "partial")
    /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

\* Row "a report for write k" (the secret; the report names its write; the same report may come again,
\* late, or never). Judged after the time-out (ServerSettlesUnknown first). Per write k's state:
\*   permitted + done     -> done (a create also records what it created); the last write -> succeeded
\*   permitted + notsent  -> notsent, the rest skipped; first write -> failed, else partial
\*   permitted + unknown  -> unknown, the rest skipped, the execution unknown (for good)
\*   unknown   + done     -> done (late and sure); the execution ends succeeded (last) / partial — never runs on
\*   anything else        -> recorded only (same / conflict); the state does not move backwards
ServerGetsReport(p) ==
    \E k \in Idx :
        /\ rep[p][k] # "none" /\ ~(st[p][k] = "permitted" /\ Past(p))
        /\ LET r == rep[p][k]
               s == st[p][k]
               mk == IF Kind(p, k) = "create" THEN [made EXCEPT ![p] = repMade[p]] ELSE made
           IN CASE s = "permitted" /\ r = "done" ->
                     /\ st' = [st EXCEPT ![p][k] = "done"] /\ made' = mk
                     /\ IF k = Last(p) THEN Fin(p, "succeeded") ELSE UNCHANGED <<exSt, lock, planSt>>
                     /\ UNCHANGED everUnknown
                [] s = "permitted" /\ r = "notsent" ->
                     /\ st' = [st EXCEPT ![p] = Row(p, k, "notsent")]
                     /\ Fin(p, IF k = 1 THEN "failed" ELSE "partial")
                     /\ UNCHANGED <<made, everUnknown>>
                [] s = "permitted" /\ r = "unknown" ->
                     /\ st' = [st EXCEPT ![p] = Row(p, k, "unknown")]
                     /\ exSt' = [exSt EXCEPT ![p] = "unknown"] /\ everUnknown' = [everUnknown EXCEPT ![p] = TRUE]
                     /\ UNCHANGED <<made, lock, planSt>>
                [] s = "unknown" /\ r = "done" ->
                     /\ st' = [st EXCEPT ![p][k] = "done"] /\ made' = mk
                     /\ Fin(p, IF k = Last(p) THEN "succeeded" ELSE "partial")
                     /\ UNCHANGED everUnknown
                [] OTHER -> UNCHANGED <<st, made, exSt, lock, planSt, everUnknown>>
        /\ \/ rep' = [rep EXCEPT ![p][k] = "none"]
           \/ UNCHANGED rep    \* the same report arrives again
        /\ UNCHANGED <<shape, age, ageFirst, contAfter, permitReq, repMade, appVars, siteVars>>

ReportLost(p) ==
    \E k \in Idx :
        /\ rep[p][k] # "none"
        /\ rep' = [rep EXCEPT ![p][k] = "none"]
        /\ UNCHANGED <<shape, srvVars, permitReq, repMade, appVars, siteVars>>

\* Row "confirm" 「済んでいた / されていなかった」: only for the unknown write, only past its own window.
\* The person looks at the site and answers truthfully. The execution ends confirmed; nothing more is sent.
PersonConfirms(p) ==
    \E k \in Idx :
        /\ st[p][k] = "unknown" /\ Past(p)
        /\ st' = [st EXCEPT ![p][k] = IF landed[p][k] THEN "cdone" ELSE "cnotdone"]
        /\ Fin(p, "confirmed")
        /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

Tick ==
    /\ \E p \in NewPlans :
        \/ (\E k \in Idx : st[p][k] \in {"permitted", "unknown"}) /\ age[p] < CAP
        \/ exSt[p] \in {"running", "unknown"} /\ ageFirst[p] < LIMIT
    /\ age' = [p \in Plans |-> IF p \in NewPlans /\ \E k \in Idx : st[p][k] \in {"permitted", "unknown"} THEN Min(age[p] + 1, CAP) ELSE age[p]]
    /\ ageFirst' = [p \in Plans |-> IF p \in NewPlans /\ exSt[p] \in {"running", "unknown"} THEN Min(ageFirst[p] + 1, LIMIT) ELSE ageFirst[p]]
    /\ UNCHANGED <<shape, planSt, exSt, st, made, lock, everUnknown, contAfter, netVars, appVars, siteVars>>

\* =========================== app ===========================

\* Before each write the app reads its target again (I2): a create needs nothing (the folder); a change
\* of what was created reads the object the SERVER recorded (the permit binds it; the app cannot name
\* another) and expects it as the create left it; a change of E expects E as approved.
Target(p) == IF made[p] = "ours" THEN ours ELSE IF made[p] = "theirs" THEN theirs ELSE "absent"
RereadSame(p) ==
    LET k == cur[p] IN
    CASE Kind(p, k) = "create" -> TRUE
      [] Kind(p, k) = "updC" -> Target(p) = "made"
      [] OTHER -> eSt = "before"

AppAsksPermit(p) ==
    /\ ph[p] = "ready" /\ RereadSame(p) /\ permitReq[p] = 0
    /\ ph' = [ph EXCEPT ![p] = "asking"] /\ permitReq' = [permitReq EXCEPT ![p] = cur[p]]
    /\ UNCHANGED <<shape, srvVars, rep, repMade, cur, siteVars>>

\* Any stop before asking write k's permit (the re-read differs, the window, the setting, the stop): the
\* app gives the rest back (cancel). Arrives -> claimed: void; running with nothing open: partial. Or lost
\* (then the claim limit / the plan's limit settle it).
AppStopsBetween(p) ==
    /\ ph[p] = "ready"
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ \/ exSt[p] = "claimed" /\ Fin(p, "void") /\ UNCHANGED st
       \/ /\ exSt[p] = "running" /\ NoneOpen(p) /\ st[p][cur[p]] = "pending"
          /\ st' = [st EXCEPT ![p] = Keep(p, cur[p])]
          /\ Fin(p, "partial")
       \/ UNCHANGED <<exSt, lock, planSt, st>>
    /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, cur, siteVars>>

\* No usable permit answer within 5 s (or asking threw): write k not sent -> report notsent
AppPermitUnanswered(p) ==
    /\ ph[p] = "asking"
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "notsent"]
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<shape, srvVars, permitReq, repMade, cur, siteVars>>

\* The last check before sending (under the permit), then the write. Lost, or lands, or reaches the site
\* and is refused. A create may land as a child re-using one that something else references (oursShared:
\* the site's property). A change of what was created goes to what the server recorded.
AppSends(p) ==
    /\ ph[p] = "permitted" /\ age[p] < PERMIT
    /\ LET k == cur[p] IN
       /\ badSend' = (badSend \/ ~(st[p][k] = "permitted" /\ age[p] < PERMIT))
       /\ \/ UNCHANGED <<sends, landed, eSt, ours, oursShared, theirs>>
          \/ /\ sends' = [sends EXCEPT ![p][k] = Min(sends[p][k] + 1, 2)] /\ landed' = [landed EXCEPT ![p][k] = TRUE]
             /\ CASE Kind(p, k) = "create" ->
                       /\ ours' = "made" /\ oursShared' \in BOOLEAN /\ UNCHANGED <<eSt, theirs>>
                  [] Kind(p, k) = "updC" /\ made[p] = "theirs" ->
                       /\ theirs' = "changed" /\ UNCHANGED <<eSt, ours, oursShared>>
                  [] Kind(p, k) = "updC" ->
                       /\ ours' = "changed" /\ UNCHANGED <<eSt, oursShared, theirs>>
                  [] OTHER ->
                       /\ eSt' = (IF eSt = "before" THEN "after" ELSE "other")
                       /\ UNCHANGED <<ours, oursShared, theirs>>
          \/ /\ sends' = [sends EXCEPT ![p][k] = Min(sends[p][k] + 1, 2)]
             /\ UNCHANGED <<landed, eSt, ours, oursShared, theirs>>
    /\ ph' = [ph EXCEPT ![p] = "sent"]
    /\ UNCHANGED <<shape, srvVars, netVars, cur, edited>>

\* Permitted, but the last check says no (permit late, context changed, stopped): never sent -> notsent
AppStopsBeforeSend(p) ==
    /\ ph[p] = "permitted"
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "notsent"]
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<shape, srvVars, permitReq, repMade, cur, siteVars>>

\* After a send: the app reads again. A create is "done" only when the new object is identified for sure
\* (C3: the site's answer id, the folder's difference, the content as planned, the parent and account)
\* AND nobody else references it (C1); otherwise unknown. A change is done only when its target reads
\* exactly as planned. Done and not the last write -> the app goes on to the next write.
Identified(p) == ours = "made" /\ ~oursShared
AppReadsAfter(p) ==
    /\ ph[p] = "sent"
    /\ LET k == cur[p]
           ok == CASE Kind(p, k) = "create" -> Identified(p)
                   [] Kind(p, k) = "updC" -> Target(p) = "changed"
                   [] OTHER -> eSt = "after"
       IN /\ rep' = [rep EXCEPT ![p][k] = IF ok THEN "done" ELSE "unknown"]
          /\ repMade' = IF ok /\ Kind(p, k) = "create" THEN [repMade EXCEPT ![p] = "ours"] ELSE repMade
          /\ IF ok /\ k < Last(p)
               THEN ph' = [ph EXCEPT ![p] = "ready"] /\ cur' = [cur EXCEPT ![p] = k + 1]
               ELSE ph' = [ph EXCEPT ![p] = "gone"] /\ UNCHANGED cur
    /\ UNCHANGED <<shape, srvVars, permitReq, siteVars>>

\* Sent with no answer, or the read after it failed: unknown
AppRereadAfterFails(p) ==
    /\ ph[p] = "sent"
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "unknown"]
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<shape, srvVars, permitReq, repMade, cur, siteVars>>

\* Crash or quit at any step: the secret is lost; the server's time-outs settle it
AppCrashes(p) ==
    /\ ph[p] \notin {"idle", "gone"}
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<shape, srvVars, netVars, cur, siteVars>>

\* =========================== surroundings ===========================

SomeoneEdits ==
    /\ ~edited
    /\ eSt' = "other" /\ edited' = TRUE
    /\ UNCHANGED <<shape, srvVars, netVars, appVars, ours, oursShared, theirs, sends, landed, badSend>>

\* A person creates their own object in the same folder (any time, once): what C3 must not mistake for ours
PersonCreatesInFolder ==
    /\ theirs = "absent"
    /\ theirs' = "made"
    /\ UNCHANGED <<shape, srvVars, netVars, appVars, eSt, ours, oursShared, sends, landed, edited, badSend>>

Done ==
    /\ \A p \in Plans : ph[p] \in {"idle", "gone"} /\ exSt[p] \notin Open /\ permitReq[p] = 0
    /\ \A p \in Plans, k \in Idx : rep[p][k] = "none"
    /\ UNCHANGED vars

\* =========================== the old path (p2) ===========================
\* Today's one-write plan on the same E, its whole life (PlanLife.tla) folded into three steps: the claim
\* takes the lock key the map gives for E — the SAME key the new path takes (C11) —, then it may write E
\* once (its re-read before the permit: E as approved), then it ends (succeeded when it wrote, else void).
OldKey == KeyE("p2")
OldClaims ==
    /\ planSt["p2"] = "approved" /\ lock[OldKey] = "none"
    /\ planSt' = [planSt EXCEPT !["p2"] = "claimed"] /\ exSt' = [exSt EXCEPT !["p2"] = "claimed"]
    /\ lock' = [lock EXCEPT ![OldKey] = "p2"]
    /\ UNCHANGED <<shape, st, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>
OldWrites ==
    /\ exSt["p2"] = "claimed" /\ eSt = "before" /\ sends["p2"][1] = 0
    /\ st' = [st EXCEPT !["p2"][1] = "permitted"]
    /\ eSt' = "after" /\ sends' = [sends EXCEPT !["p2"][1] = 1] /\ landed' = [landed EXCEPT !["p2"][1] = TRUE]
    /\ UNCHANGED <<shape, planSt, exSt, age, ageFirst, made, lock, everUnknown, contAfter, netVars, appVars,
                   ours, oursShared, theirs, edited, badSend>>
OldEnds ==
    /\ exSt["p2"] = "claimed"
    /\ st' = [st EXCEPT !["p2"][1] = IF landed["p2"][1] THEN "done" ELSE "skipped"]
    /\ Fin("p2", IF landed["p2"][1] THEN "succeeded" ELSE "void")
    /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>
OldPathNext == OldClaims \/ OldWrites \/ OldEnds

ServerNext ==
    \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)

AppNext ==
    \E p \in NewPlans :
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)

Env == Tick \/ SomeoneEdits \/ PersonCreatesInFolder \/ Done

Next == ServerNext \/ AppNext \/ OldPathNext \/ Env

Spec == Init /\ [][Next]_vars

\* =========================== rules ===========================

StepStates == {"pending", "permitted", "done", "notsent", "unknown", "cdone", "cnotdone", "skipped", "na"}
TypeOK ==
    /\ shape \in Shapes
    /\ planSt \in [Plans -> {"approved", "claimed", "done"}]
    /\ exSt \in [Plans -> {"none", "claimed", "running", "unknown", "succeeded", "partial", "failed", "confirmed", "void"}]
    /\ st \in [Plans -> [Idx -> StepStates]]
    /\ age \in [Plans -> 0..CAP] /\ ageFirst \in [Plans -> 0..LIMIT]
    /\ made \in [Plans -> {"none", "ours", "theirs"}]
    /\ lock \in [Keys -> Plans \cup {"none"}]
    /\ everUnknown \in [Plans -> BOOLEAN] /\ contAfter \in [Plans -> BOOLEAN]
    /\ permitReq \in [Plans -> 0..3] /\ rep \in [Plans -> [Idx -> {"none", "done", "notsent", "unknown"}]]
    /\ repMade \in [Plans -> {"none", "ours", "theirs"}]
    /\ ph \in [Plans -> {"idle", "ready", "asking", "permitted", "sent", "gone"}] /\ cur \in [Plans -> Idx]
    /\ eSt \in {"before", "after", "other"} /\ ours \in {"absent", "made", "changed"} /\ oursShared \in BOOLEAN
    /\ theirs \in {"absent", "made", "changed"}
    /\ sends \in [Plans -> [Idx -> 0..2]] /\ landed \in [Plans -> [Idx -> BOOLEAN]]
    /\ edited \in BOOLEAN /\ badSend \in BOOLEAN

\* R1' Each write reaches the site at most once
R1_AtMostOneSendPerWrite == \A p \in Plans, k \in Idx : sends[p][k] <= 1

\* R2' Nothing is sent without a live permit for that very write
R2_NoSendWithoutLivePermit == ~badSend

\* R3 On one object at most one execution is open (claimed, running, unknown) — across the old and the
\*    new path (both write E): one lock key for both (C11), held until the execution is final (C12)
R3_OneOpenExecutionPerObject ==
    \A p, q \in Plans : (p # q /\ exSt[p] \in Open) => exSt[q] \notin Open

\* R4' A write recorded "not sent" or never tried (skipped, still pending) did not reach the site
R4_NotSentMeansNotSent == \A p \in Plans, k \in Idx : st[p][k] \in {"pending", "notsent", "skipped"} => sends[p][k] = 0

\* R5' A write confirmed "not done" did not change the site later either
R5_NotDoneStaysTrue == \A p \in Plans, k \in Idx : st[p][k] = "cnotdone" => ~landed[p][k]

\* R6 The same change never lands twice (E is "other" only when a person changed it directly)
R6_NoDoubleApply == eSt = "other" => edited

\* R8 Write k is permitted only after write k-1 was reported done and recorded
R8_InOrder == \A p \in Plans, k \in Idx : st[p][k] \notin {"pending", "skipped", "na"} => Prev(p, k) = "done"

\* R9 (I4) A stopped execution (partial, failed, void) did not change the existing object: before the
\*    last write a plan changes only what it created
R9_StoppedLeavesExistingAlone ==
    \A p \in Plans : exSt[p] \in {"partial", "failed", "void"} =>
        \A k \in Steps(p) : Kind(p, k) = "updE" => ~landed[p][k]

\* R10 After an execution was unknown, none of its writes is permitted again (not even after a late "done")
R10_NoContinueAfterUnknown == \A p \in Plans : ~contAfter[p]

\* R11 (C1, C3) What the server records as created by an execution is that execution's own new object,
\*     there, and referenced by nothing else (never a person's object, never a child shared with others)
R11_CreatedIsItsOwn == \A p \in Plans : made[p] # "none" => (made[p] = "ours" /\ ours # "absent" /\ ~oursShared)

\* R12 (C12, design §16-3 / R4) A partial execution has no write left unknown: every write is done, or
\*     surely not sent — so the card's "not done" list never holds a write that may have gone out
R12_PartialIsSure ==
    \A p \in Plans : exSt[p] = "partial" => \A k \in Steps(p) : st[p][k] \in {"done", "notsent", "skipped"}

\* R13 (I3) A write recorded done really changed the site as planned (a report counts for the write it names)
R13_DoneMeansLanded == \A p \in Plans, k \in Idx : st[p][k] \in {"done", "cdone"} => landed[p][k]

\* R7 From every reachable state a settled state can be reached (reach.mjs on the state graph)
Settled ==
    /\ \A p \in Plans : ph[p] \in {"idle", "gone"} /\ exSt[p] \notin Open
    /\ \A x \in Keys : lock[x] = "none"

====

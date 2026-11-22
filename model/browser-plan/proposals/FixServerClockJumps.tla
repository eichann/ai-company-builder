---- MODULE FixServerClockJumps ----
\* Proposed fix (must keep every rule, R7 included) for holes/HoleServerClockJumps. The wall clock jumps
\* forward the same way, but at the permit the server also keeps a monotonic clock reading and its boot
\* id, and "becomes unknown" / 「確かめた」 require BOTH the wall-clock elapsed time AND the monotonic
\* elapsed time (since the permit on the same boot; since boot after a restart) to be 35 s or more
\* (internal 6b-2 design memo §7-2). In the model the monotonic elapsed time is the real one (realAge).
\* 6b-2a (the server PR) moves this into PlanLife.tla: README "Open hole".
EXTENDS PlanLife

\* Same action as in holes/HoleServerClockJumps
ServerClockJumps(p) ==
    /\ exSt[p] = "permitted" /\ srvAge[p] < CAP
    /\ srvAge' = [srvAge EXCEPT ![p] = CAP]
    /\ UNCHANGED <<planSt, approvedEver, exSt, holder, lock, realAge, permitReq, rep, appVars, siteVars>>

Past(p) == srvAge[p] >= CAP /\ realAge[p] >= CAP

FixSettlesUnknown(p) ==
    /\ exSt[p] = "permitted" /\ Past(p)
    /\ exSt' = [exSt EXCEPT ![p] = "unknown"]
    /\ UNCHANGED <<planSt, approvedEver, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

FixGetsReport(p) ==
    /\ rep[p] # "none"
    /\ LET r == rep[p]
           s == IF exSt[p] = "permitted" /\ Past(p) THEN "unknown" ELSE exSt[p]
       IN IF s = "permitted" /\ r \in {"succeeded", "failed"} THEN Fin(p, r)
          ELSE IF s = "permitted" /\ r = "unknown" THEN (exSt' = [exSt EXCEPT ![p] = "unknown"] /\ UNCHANGED <<lock, planSt>>)
          ELSE IF s = "unknown" /\ r = "succeeded" THEN Fin(p, "succeeded")
          ELSE (exSt' = [exSt EXCEPT ![p] = s] /\ UNCHANGED <<lock, planSt>>)
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

FixConfirms(p) ==
    /\ exSt[p] = "unknown" /\ Past(p)
    /\ Fin(p, IF landed[p] THEN "cdone" ELSE "cnotdone")
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

\* A report "unknown" still makes it unknown without waiting for Past (as in 6a); the confirmation
\* after it waits for Past
FixNext ==
    \/ ClaimNext \/ AppNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E p \in Plans :
        \/ Register(p) \/ Approve(p) \/ CloseOpen(p) \/ VoidClaimed(p)
        \/ ServerPermits(p) \/ ServerRefusesPermit(p) \/ FixSettlesUnknown(p)
        \/ FixGetsReport(p) \/ ReportLost(p) \/ FixConfirms(p) \/ ServerClockJumps(p)
FixSpec == Init /\ [][FixNext]_vars
====

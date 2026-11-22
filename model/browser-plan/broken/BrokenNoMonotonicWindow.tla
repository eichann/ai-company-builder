---- MODULE BrokenNoMonotonicWindow ----
\* Broken variant (must fail R5): the server judges "past permit + 5 s + 30 s" by its wall clock alone,
\* as 6a did (the monotonic condition of Past removed from settleExecution, report and confirm). With the
\* wall clock jumping forward right after a permit (ServerClockJumps, part of the real model), the
\* execution turns unknown and 「確かめた：されていなかった」 is taken while the app still, correctly,
\* sends inside its 5 s: the "not done" confirmation turns false afterwards.
EXTENDS PlanLife

WallPast(p) == srvAge[p] >= CAP

BrokenSettlesUnknown(p) ==
    /\ exSt[p] = "permitted" /\ WallPast(p)
    /\ exSt' = [exSt EXCEPT ![p] = "unknown"]
    /\ UNCHANGED <<planSt, approvedEver, holder, lock, srvAge, realAge, permitReq, rep, appVars, siteVars>>

BrokenGetsReport(p) ==
    /\ rep[p] # "none"
    /\ LET r == rep[p]
           s == IF exSt[p] = "permitted" /\ WallPast(p) THEN "unknown" ELSE exSt[p]
       IN IF s = "permitted" /\ r \in {"succeeded", "failed"} THEN Fin(p, r)
          ELSE IF s = "permitted" /\ r = "unknown" THEN (exSt' = [exSt EXCEPT ![p] = "unknown"] /\ UNCHANGED <<lock, planSt>>)
          ELSE IF s = "unknown" /\ r = "succeeded" THEN Fin(p, "succeeded")
          ELSE (exSt' = [exSt EXCEPT ![p] = s] /\ UNCHANGED <<lock, planSt>>)
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

BrokenConfirms(p) ==
    /\ exSt[p] = "unknown" /\ WallPast(p)
    /\ Fin(p, IF landed[p] THEN "cdone" ELSE "cnotdone")
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

BrokenNext ==
    \/ ClaimNext \/ AppNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E p \in Plans :
        \/ Register(p) \/ Approve(p) \/ CloseOpen(p) \/ VoidClaimed(p)
        \/ ServerPermits(p) \/ ServerRefusesPermit(p) \/ BrokenSettlesUnknown(p)
        \/ BrokenGetsReport(p) \/ ReportLost(p) \/ BrokenConfirms(p) \/ ServerClockJumps(p)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

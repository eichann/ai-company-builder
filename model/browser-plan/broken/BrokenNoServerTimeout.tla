---- MODULE BrokenNoServerTimeout ----
\* Broken variant (must fail R7 and keep every other rule): the server never turns a silent permitted
\* execution into unknown; it only waits for a report (settleExecution's permitted -> unknown branch and
\* report's own time-out check removed). If the app crashes after the permit, the execution stays
\* permitted, the lock never goes and no person can confirm. The world may always stutter (Wait), so
\* this fails as "cannot reach settled", not as a deadlock.
EXTENDS PlanLife

BrokenGetsReport(p) ==
    /\ rep[p] # "none"
    /\ LET r == rep[p] IN
       IF exSt[p] = "permitted" /\ r \in {"succeeded", "failed"} THEN Fin(p, r)
       ELSE IF exSt[p] = "permitted" /\ r = "unknown" THEN (exSt' = [exSt EXCEPT ![p] = "unknown"] /\ UNCHANGED <<lock, planSt>>)
       ELSE IF exSt[p] = "unknown" /\ r = "succeeded" THEN Fin(p, "succeeded")
       ELSE UNCHANGED <<exSt, lock, planSt>>
    /\ UNCHANGED <<approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

Wait == UNCHANGED vars

BrokenNext ==
    \/ ClaimNext \/ AppNext \/ Tick \/ SomeoneEdits \/ Done \/ Wait
    \/ \E p \in Plans :
        \/ Register(p) \/ Approve(p) \/ CloseOpen(p) \/ VoidClaimed(p)
        \/ ServerPermits(p) \/ ServerRefusesPermit(p)
        \/ BrokenGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

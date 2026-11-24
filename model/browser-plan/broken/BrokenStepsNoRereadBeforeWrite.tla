---- MODULE BrokenStepsNoRereadBeforeWrite ----
\* Broken variant (must fail R6): before a write the app does not read its target again (I2), so the
\* last write changes E after the old path already changed it.
EXTENDS StepsLife

BrokenAsksPermit(p) ==
    /\ ph[p] = "ready" /\ permitReq[p] = 0
    /\ ph' = [ph EXCEPT ![p] = "asking"] /\ permitReq' = [permitReq EXCEPT ![p] = cur[p]]
    /\ UNCHANGED <<shape, srvVars, rep, repMade, cur, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ BrokenAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

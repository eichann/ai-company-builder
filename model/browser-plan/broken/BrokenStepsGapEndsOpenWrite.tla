---- MODULE BrokenStepsGapEndsOpenWrite ----
\* Broken variant (must fail R12): the plan's limit ends the execution as "partial" while a write is still
\* permitted (it may have been sent): the card would list it among the things not done.
EXTENDS StepsLife

BrokenEndsGap(p) ==
    /\ exSt[p] = "running" /\ ageFirst[p] >= LIMIT
    /\ \E k \in Idx : st[p][k] = "permitted"
    /\ st' = [st EXCEPT ![p] = [j \in Idx |-> IF st[p][j] = "pending" THEN "skipped" ELSE st[p][j]]]
    /\ Fin(p, "partial")
    /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ BrokenEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

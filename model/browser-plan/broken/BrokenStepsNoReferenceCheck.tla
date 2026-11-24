---- MODULE BrokenStepsNoReferenceCheck ----
\* Broken variant (must fail R11): after a create the app does not read whether something else already
\* references the new object (C1: a copy sharing its child with the original), so a shared child is
\* recorded as "created by this execution" and the next write would change it for everyone.
EXTENDS StepsLife

BrokenReadsAfter(p) ==
    /\ ph[p] = "sent" /\ Kind(p, cur[p]) = "create" /\ ours = "made" /\ oursShared
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "done"] /\ repMade' = [repMade EXCEPT ![p] = "ours"]
    /\ ph' = [ph EXCEPT ![p] = "ready"] /\ cur' = [cur EXCEPT ![p] = cur[p] + 1]
    /\ UNCHANGED <<shape, srvVars, permitReq, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ BrokenReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

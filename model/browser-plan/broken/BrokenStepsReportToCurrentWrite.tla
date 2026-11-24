---- MODULE BrokenStepsReportToCurrentWrite ----
\* Broken variant (must fail R13): the server applies a report to the write now permitted instead of the
\* write the report names. A late copy of write 1's "done" marks write 2 done before it was sent.
EXTENDS StepsLife

BrokenGetsReport(p) ==
    \E k, j \in Idx :
        /\ rep[p][k] = "done" /\ j # k /\ st[p][j] = "permitted" /\ ~Past(p)
        /\ st' = [st EXCEPT ![p][j] = "done"]
        /\ IF j = Last(p) THEN Fin(p, "succeeded") ELSE UNCHANGED <<exSt, lock, planSt>>
        /\ rep' = [rep EXCEPT ![p][k] = "none"]
        /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, permitReq, repMade, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ BrokenGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenStepsLockFreedAfterWrite ----
\* Broken variant (must fail R3): a write reported done that is not the last frees the execution's locks
\* (today's one-write server frees the lock on "succeeded"; copied as is to several writes). The old path
\* then claims E while the new plan still runs.
EXTENDS StepsLife

BrokenGetsReport(p) ==
    \E k \in Idx :
        /\ rep[p][k] = "done" /\ st[p][k] = "permitted" /\ ~Past(p) /\ k < Last(p)
        /\ st' = [st EXCEPT ![p][k] = "done"]
        /\ made' = IF Kind(p, k) = "create" THEN [made EXCEPT ![p] = repMade[p]] ELSE made
        /\ lock' = [x \in Keys |-> IF lock[x] = p THEN "none" ELSE lock[x]]
        /\ rep' = [rep EXCEPT ![p][k] = "none"]
        /\ UNCHANGED <<shape, planSt, exSt, age, ageFirst, everUnknown, contAfter, permitReq, repMade, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ BrokenGetsReport(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

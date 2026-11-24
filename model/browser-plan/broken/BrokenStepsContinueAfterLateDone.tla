---- MODULE BrokenStepsContinueAfterLateDone ----
\* Broken variant (must fail R10): a late "done" for the unknown write puts the execution back to running
\* and the skipped writes back to pending (today's "unknown + succeeded -> succeeded", read as "go on").
EXTENDS StepsLife

BrokenLateDone(p) ==
    \E k \in Idx :
        /\ rep[p][k] = "done" /\ st[p][k] = "unknown" /\ k < Last(p)
        /\ st' = [st EXCEPT ![p] = [j \in Idx |-> IF j = k THEN "done" ELSE IF j > k /\ st[p][j] = "skipped" THEN "pending" ELSE st[p][j]]]
        /\ made' = IF Kind(p, k) = "create" THEN [made EXCEPT ![p] = repMade[p]] ELSE made
        /\ exSt' = [exSt EXCEPT ![p] = "running"]
        /\ rep' = [rep EXCEPT ![p][k] = "none"]
        /\ UNCHANGED <<shape, planSt, age, ageFirst, lock, everUnknown, contAfter, permitReq, repMade, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ BrokenLateDone(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenStepsPermitPerPlan ----
\* Broken variant (must fail R8): the server permits any pending write of a running execution, without
\* waiting for the write before it to be reported done (a permit per plan, not per write).
EXTENDS StepsLife

BrokenPermits(p) ==
    \E k \in Idx :
    /\ permitReq[p] = k /\ exSt[p] = "running" /\ st[p][k] = "pending" /\ ageFirst[p] < LIMIT
    /\ permitReq' = [permitReq EXCEPT ![p] = 0]
    /\ st' = [st EXCEPT ![p][k] = "permitted"]
    /\ age' = [age EXCEPT ![p] = 0]
    /\ contAfter' = [contAfter EXCEPT ![p] = contAfter[p] \/ everUnknown[p]]
    /\ AnswerTo(p, "permitted")
    /\ UNCHANGED <<shape, planSt, exSt, ageFirst, made, lock, everUnknown, rep, repMade, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ BrokenPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

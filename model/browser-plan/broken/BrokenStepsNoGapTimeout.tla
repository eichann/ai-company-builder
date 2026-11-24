---- MODULE BrokenStepsNoGapTimeout ----
\* Broken variant (must fail R7): no time-out ends an execution whose app stopped between two writes
\* (C12: no write is unknown, so nothing waits for a confirm). It stays running and holds its lock for good.
\* Time goes on there (TimePasses), so the stuck state is no dead end: the checker must find it through R7.
EXTENDS StepsLife

TimePasses == \E p \in NewPlans : exSt[p] = "running" /\ UNCHANGED vars

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ TimePasses \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

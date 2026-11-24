---- MODULE BrokenStepsOldPathOwnKey ----
\* Broken variant (must fail R3): the old path builds its lock key its own way (not the map's common key,
\* C11), so an old-path plan and a new-path plan on the same object are both claimed.
EXTENDS StepsLife

BrokenOldClaims ==
    /\ planSt["p2"] = "approved" /\ lock["Eold"] = "none"
    /\ planSt' = [planSt EXCEPT !["p2"] = "claimed"] /\ exSt' = [exSt EXCEPT !["p2"] = "claimed"]
    /\ lock' = [lock EXCEPT !["Eold"] = "p2"]
    /\ UNCHANGED <<shape, st, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ BrokenOldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

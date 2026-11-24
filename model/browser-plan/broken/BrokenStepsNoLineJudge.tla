---- MODULE BrokenStepsNoLineJudge ----
\* Broken variant (must fail R9): the claim does not ask the line judge (HarmlessPrefix), so a line that
\* changes the existing object before its last write runs; stopped after that write, it leaves the
\* existing object changed and the rest undone.
EXTENDS StepsLife

BrokenClaim(p) ==
    /\ planSt[p] = "approved" /\ lock[KeyE(p)] = "none"
    /\ planSt' = [planSt EXCEPT ![p] = "claimed"] /\ exSt' = [exSt EXCEPT ![p] = "claimed"]
    /\ lock' = [lock EXCEPT ![KeyE(p)] = p]
    /\ \/ ph' = [ph EXCEPT ![p] = "ready"]
       \/ UNCHANGED ph
    /\ UNCHANGED <<shape, st, age, ageFirst, made, everUnknown, contAfter, netVars, cur, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ BrokenClaim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenStepsWindowFromFirstPermit ----
\* Broken variant (must fail R5): the time-out and the confirm count the window from the execution's FIRST
\* permit, not from the permit of the write in question (the last time something could have been sent).
\* A later write is turned unknown and confirmed "not done" while the app still, correctly, sends it.
\* (R2 breaks too, in the same step; this variant checks R5 only, the worst consequence.)
EXTENDS StepsLife

BrokenSettlesUnknown(p) ==
    \E k \in Idx :
        /\ st[p][k] = "permitted" /\ ageFirst[p] >= CAP
        /\ st' = [st EXCEPT ![p] = Row(p, k, "unknown")]
        /\ exSt' = [exSt EXCEPT ![p] = "unknown"] /\ everUnknown' = [everUnknown EXCEPT ![p] = TRUE]
        /\ UNCHANGED <<shape, planSt, age, ageFirst, made, lock, contAfter, netVars, appVars, siteVars>>
BrokenConfirms(p) ==
    \E k \in Idx :
        /\ st[p][k] = "unknown" /\ ageFirst[p] >= CAP
        /\ st' = [st EXCEPT ![p][k] = IF landed[p][k] THEN "cdone" ELSE "cnotdone"]
        /\ Fin(p, "confirmed")
        /\ UNCHANGED <<shape, age, ageFirst, made, everUnknown, contAfter, netVars, appVars, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ BrokenSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p) \/ BrokenConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

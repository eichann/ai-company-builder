---- MODULE BrokenStepsResendAfterNoAnswer ----
\* Broken variant (must fail R1'): a write sent with no answer is sent again while its permit still runs
\* (an automatic retry), instead of being reported unknown.
EXTENDS StepsLife

BrokenResend(p) ==
    /\ ph[p] = "sent" /\ age[p] < PERMIT
    /\ ph' = [ph EXCEPT ![p] = "permitted"]
    /\ UNCHANGED <<shape, srvVars, netVars, cur, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ BrokenResend(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

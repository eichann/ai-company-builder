---- MODULE BrokenStepsSendWithoutPermitCheck ----
\* Broken variant (must fail R2'): the last check before sending does not look at the permit's age, so a
\* write goes out after its 5 s.
EXTENDS StepsLife

BrokenSends(p) ==
    /\ ph[p] = "permitted" /\ age[p] >= PERMIT
    /\ LET k == cur[p] IN
       /\ badSend' = (badSend \/ ~(st[p][k] = "permitted" /\ age[p] < PERMIT))
       /\ sends' = [sends EXCEPT ![p][k] = Min(sends[p][k] + 1, 2)]
    /\ ph' = [ph EXCEPT ![p] = "sent"]
    /\ UNCHANGED <<shape, srvVars, netVars, cur, landed, eSt, ours, oursShared, theirs, edited>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p) \/ BrokenSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

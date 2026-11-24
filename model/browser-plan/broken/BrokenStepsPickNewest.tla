---- MODULE BrokenStepsPickNewest ----
\* Broken variant (must fail R11): the app takes "the one new object in the folder" as what it created
\* (C3), without the site's answer id and the content. Its own create was lost; a person's new object
\* is taken for it.
EXTENDS StepsLife

BrokenReadsAfter(p) ==
    /\ ph[p] = "sent" /\ Kind(p, cur[p]) = "create" /\ ours = "absent" /\ theirs = "made"
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "done"] /\ repMade' = [repMade EXCEPT ![p] = "theirs"]
    /\ ph' = [ph EXCEPT ![p] = "ready"] /\ cur' = [cur EXCEPT ![p] = cur[p] + 1]
    /\ UNCHANGED <<shape, srvVars, permitReq, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ BrokenReadsAfter(p) \/ AppRereadAfterFails(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

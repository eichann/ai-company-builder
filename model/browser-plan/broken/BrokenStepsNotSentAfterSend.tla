---- MODULE BrokenStepsNotSentAfterSend ----
\* Broken variant (must fail R4'): after a send the site refused (or no answer), the app reports
\* "not sent" instead of unknown (today's BrokenFailedOn4xx, per write).
EXTENDS StepsLife

BrokenReportsNotSent(p) ==
    /\ ph[p] = "sent"
    /\ rep' = [rep EXCEPT ![p][cur[p]] = "notsent"]
    /\ ph' = [ph EXCEPT ![p] = "gone"]
    /\ UNCHANGED <<shape, srvVars, permitReq, repMade, cur, siteVars>>

BrokenNext ==
    \/ \E p \in NewPlans :
        \/ Claim(p) \/ VoidClaimed(p) \/ ServerPermits(p) \/ ServerSaysNotYet(p) \/ ServerRefusesPermit(p)
        \/ ServerSettlesUnknown(p) \/ ServerEndsGap(p) \/ ServerGetsReport(p) \/ ReportLost(p) \/ PersonConfirms(p)
        \/ AppAsksPermit(p) \/ AppStopsBetween(p) \/ AppPermitUnanswered(p) \/ AppSends(p)
        \/ AppStopsBeforeSend(p) \/ AppReadsAfter(p) \/ AppRereadAfterFails(p) \/ BrokenReportsNotSent(p) \/ AppCrashes(p)
    \/ OldClaims \/ OldWrites \/ OldEnds \/ Env
BrokenSpec == Init /\ [][BrokenNext]_vars
====

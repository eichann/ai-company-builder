---- MODULE BrokenFailedOn4xx ----
\* Broken variant (must fail R4): after sending, when the site refuses (4xx) and the re-read looks
\* unchanged, the app reports failed ("not sent"). This is the branch today's runner has
\* (client/electron/features/browser/runner.ts: the state from before = failed, reason refused-by-site);
\* the 6b-2 design removes it. The write did reach the site, so "not sent" is false.
EXTENDS PlanLife

BrokenAppReadsAfter(a) ==
    /\ ph[a] = "sent"
    /\ rep' = [rep EXCEPT ![ap[a]] = IF site = "after" THEN "succeeded" ELSE IF site = "before" THEN "failed" ELSE "unknown"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

BrokenNext ==
    \/ ServerNext \/ ClaimNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E a \in Apps :
        \/ AppCrashes(a) \/ AppRereadSame(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
        \/ AppPermitUnanswered(a) \/ AppSends(a) \/ AppStopsBeforeSend(a) \/ BrokenAppReadsAfter(a) \/ AppRereadAfterFails(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

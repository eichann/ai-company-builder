---- MODULE BrokenFailedOn4xx ----
\* Broken variant (must fail R4): after sending, when the site refuses (4xx) and the re-read looks
\* unchanged, the app reports failed ("not sent"). The runner before 6b-2c had this branch (reason
\* refused-by-site); client/electron/features/browser/runner.ts now judges a sent write only by the page
\* read after it (succeeded or unknown). The write did reach the site, so "not sent" is false.
\* In the model this is also the variant for "failed after an error once the request left" (no answer,
\* a disconnect, an exception after request.end): that is the same transition — from "sent" to a
\* "failed" report — so a second variant would be a duplicate. In the code that guard is
\* read-session.ts writeThroughSession ("not sent" only before request.end) and runner.ts settling it
\* unknown; tests/browser-execute.test.ts and tests/browser-read-session.test.ts hold it.
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
        \/ AppPermitUnanswered(a) \/ AppPermitAnswerUnusable(a) \/ AppSends(a) \/ AppStopsBeforeSend(a) \/ BrokenAppReadsAfter(a) \/ AppRereadAfterFails(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

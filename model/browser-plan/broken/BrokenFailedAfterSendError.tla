---- MODULE BrokenFailedAfterSendError ----
\* Broken variant (must fail R4): an error after the request left — no answer, a disconnect, a
\* time-out, an exception after request.end — is reported as failed ("not sent"). In the code the guard
\* is in two places: the shell's send rejects with BrowserNotSentError only before request.end
\* (client/electron/features/browser/read-session.ts writeThroughSession: any other failure is sent
\* with no answer), and client/electron/features/browser/runner.ts settles that as unknown (no-answer),
\* as it does an exception once the permit was asked. The write may have reached the site.
EXTENDS PlanLife

BrokenAppRereadAfterFails(a) ==
    /\ ph[a] = "sent"
    /\ rep' = [rep EXCEPT ![ap[a]] = "failed"]
    /\ ToIdle(a)
    /\ UNCHANGED <<srvVars, permitReq, siteVars>>

BrokenNext ==
    \/ ServerNext \/ ClaimNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E a \in Apps :
        \/ AppCrashes(a) \/ AppRereadSame(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
        \/ AppPermitUnanswered(a) \/ AppSends(a) \/ AppStopsBeforeSend(a) \/ AppReadsAfter(a) \/ BrokenAppRereadAfterFails(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

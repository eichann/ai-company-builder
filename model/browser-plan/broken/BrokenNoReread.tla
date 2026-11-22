---- MODULE BrokenNoReread ----
\* Broken variant (must fail R6): after the claim the app asks for the permit without re-reading the
\* fixed facts. With two approved plans for the same change, the second one applies it again to a site
\* the first already changed.
EXTENDS PlanLife

BrokenAppSkipsReread(a) ==
    /\ ph[a] = "claimed"
    /\ ph' = [ph EXCEPT ![a] = "checked"]
    /\ UNCHANGED <<srvVars, permitReq, rep, ap, el, siteVars>>

BrokenNext ==
    \/ ServerNext \/ ClaimNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E a \in Apps :
        \/ AppCrashes(a) \/ BrokenAppSkipsReread(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
        \/ AppPermitUnanswered(a) \/ AppPermitAnswerUnusable(a) \/ AppSends(a) \/ AppStopsBeforeSend(a) \/ AppReadsAfter(a) \/ AppRereadAfterFails(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

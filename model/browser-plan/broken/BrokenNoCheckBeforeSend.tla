---- MODULE BrokenNoCheckBeforeSend ----
\* Broken variant (must fail R2): the app does not check the permit's age (under 5 s by both clocks)
\* right before sending. If re-reading or preparing the window takes long after the permit arrived,
\* the server's permit has already run out when the write goes.
EXTENDS PlanLife

BrokenAppSends(a) ==
    /\ ph[a] = "permitted"
    /\ LET p == ap[a] IN
       /\ badSend' = (badSend \/ ~(approvedEver[p] /\ exSt[p] = "permitted" /\ holder[p] = a /\ realAge[p] < PERMIT))
       /\ \/ UNCHANGED <<sends, landed, site>>
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)] /\ landed' = [landed EXCEPT ![p] = TRUE]
             /\ site' = IF site = "before" THEN "after" ELSE "other"
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)]
             /\ UNCHANGED <<landed, site>>
    /\ ph' = [ph EXCEPT ![a] = "sent"]
    /\ UNCHANGED <<srvVars, permitReq, rep, ap, el, edited>>

BrokenNext ==
    \/ ServerNext \/ ClaimNext \/ Tick \/ SomeoneEdits \/ Done
    \/ \E a \in Apps :
        \/ AppCrashes(a) \/ AppRereadSame(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
        \/ AppPermitUnanswered(a) \/ BrokenAppSends(a) \/ AppStopsBeforeSend(a) \/ AppReadsAfter(a) \/ AppRereadAfterFails(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

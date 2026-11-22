---- MODULE LimitFrozenAfterCheck ----
\* Remaining limit (fails R2; not a bug to fix: the design states it, design memo §30.1). After the
\* last check before sending (beforeSend) passes, the process freezes before the request leaves (sleep,
\* a paused debugger, a long GC) and resumes after the permit ran out, then sends. The design keeps the
\* window minimal (no await between the check and request.end) and the server's 30 s grace delays
\* 「確かめた」, but the window cannot be zero.
EXTENDS PlanLife

VARIABLE armed   \* the app passed beforeSend and its request has not left yet

LVars == <<vars, armed>>
LInit == Init /\ armed = [a \in Apps |-> FALSE]

PassesCheck(a) ==
    /\ ph[a] = "permitted" /\ el[a] < PERMIT /\ ~armed[a]
    /\ armed' = [armed EXCEPT ![a] = TRUE]
    /\ UNCHANGED vars

\* Time passes while it is frozen (Tick). On resuming, the request leaves without checking again
LNext ==
    \/ (ServerNext \/ ClaimNext \/ Tick \/ SomeoneEdits \/ Done) /\ UNCHANGED armed
    \/ \E a \in Apps :
        \/ PassesCheck(a)
        \/ /\ armed[a]
           /\ LET p == ap[a] IN
              /\ badSend' = (badSend \/ ~(approvedEver[p] /\ exSt[p] = "permitted" /\ holder[p] = a /\ realAge[p] < PERMIT))
              /\ \/ UNCHANGED <<sends, landed, site>>
                 \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)] /\ landed' = [landed EXCEPT ![p] = TRUE]
                    /\ site' = IF site = "before" THEN "after" ELSE "other"
           /\ ph' = [ph EXCEPT ![a] = "sent"] /\ armed' = [armed EXCEPT ![a] = FALSE]
           /\ UNCHANGED <<srvVars, permitReq, rep, ap, el, edited>>
        \/ /\ ~armed[a]
           /\ \/ AppCrashes(a) \/ AppRereadSame(a) \/ AppDropsBeforePermit(a) \/ AppAsksPermit(a)
              \/ AppPermitUnanswered(a) \/ AppPermitAnswerUnusable(a) \/ AppStopsBeforeSend(a) \/ AppReadsAfter(a) \/ AppRereadAfterFails(a)
           /\ UNCHANGED armed

LSpec == LInit /\ [][LNext]_LVars
====

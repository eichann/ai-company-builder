---- MODULE BrokenRetryAfterUnknown ----
\* Broken variant (must fail R1): when the write gets no answer (disconnect, time-out) and the 5 s
\* permit is not over, the app sends the same write again (the usual "retry network failures"). No
\* answer does not mean "did not arrive".
EXTENDS PlanLife

BrokenAppResends(a) ==
    /\ ph[a] = "sent" /\ el[a] < PERMIT
    /\ LET p == ap[a] IN
       /\ badSend' = (badSend \/ ~(approvedEver[p] /\ exSt[p] = "permitted" /\ holder[p] = a /\ realAge[p] < PERMIT))
       /\ \/ UNCHANGED <<sends, landed, site>>
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)] /\ landed' = [landed EXCEPT ![p] = TRUE]
             /\ site' = IF site = "before" THEN "after" ELSE "other"
          \/ /\ sends' = [sends EXCEPT ![p] = Min(sends[p] + 1, 2)]
             /\ UNCHANGED <<landed, site>>
    /\ UNCHANGED <<srvVars, permitReq, rep, appVars, edited>>

BrokenNext == Next \/ \E a \in Apps : BrokenAppResends(a)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

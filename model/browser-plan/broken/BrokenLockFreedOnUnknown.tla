---- MODULE BrokenLockFreedOnUnknown ----
\* Broken variant (must fail R3): when an execution becomes unknown, its target lock is released
\* ("so that the person can ask again"). A second execution then starts on the same target while the
\* first is not known: an automatic retry in all but name.
EXTENDS PlanLife

BrokenSettlesUnknown(p) ==
    /\ exSt[p] = "permitted" /\ srvAge[p] >= CAP
    /\ exSt' = [exSt EXCEPT ![p] = "unknown"]
    /\ lock' = IF lock = p THEN "none" ELSE lock
    /\ UNCHANGED <<planSt, approvedEver, holder, srvAge, realAge, permitReq, rep, appVars, siteVars>>

BrokenNext == Next \/ \E p \in Plans : BrokenSettlesUnknown(p)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

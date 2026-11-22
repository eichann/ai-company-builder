---- MODULE BrokenPermitReplayed ----
\* Broken variant (must fail R2): the server answers send-permit again as "the same answer resent" and
\* does not check that the asker is the PC that claimed (the one holding the execution's secret). A
\* second PC, or the app restarted after a crash, gets the permit by the plan id alone and sends (if the
\* first PC also sends, R1 breaks too).
EXTENDS PlanLife

BrokenServerReplaysPermit(a, p) ==
    /\ exSt[p] = "permitted" /\ ph[a] = "idle" /\ realAge[p] < PERMIT
    /\ ph' = [ph EXCEPT ![a] = "permitted"] /\ ap' = [ap EXCEPT ![a] = p] /\ el' = [el EXCEPT ![a] = 0]
    /\ UNCHANGED <<srvVars, permitReq, rep, siteVars>>

BrokenNext == Next \/ \E a \in Apps, p \in Plans : BrokenServerReplaysPermit(a, p)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenLedgerRefusedTrusted ----
\* Broken variant (must fail R17): the site's error is taken as proof that nothing was saved — a refused write is no doubt
\* for later runs (the rule before "Sent is not done"). A site saved part and answered an error; asked again the next day,
\* the same thing goes on the site twice, blind.
EXTENDS LedgerLife

TrustingDoubt(j) == st[j] \in {"permitted", "unknown"} /\ ans[j] = "none"

BrokenPermit(r) ==
    /\ exSt[r] = "open" /\ st[r] = "none"
    /\ \A j \in Runs : ~TrustingDoubt(j)
    /\ st' = [st EXCEPT ![r] = "permitted"] /\ lock' = [lock EXCEPT ![r] = "held"] /\ live' = [live EXCEPT ![r] = TRUE]
    /\ knownAt' = [knownAt EXCEPT ![r] = {j \in Runs : j # r /\ ~Doubt(j)}]
    /\ ph' \in {[ph EXCEPT ![r] = "permitted"], [ph EXCEPT ![r] = "gone"]}
    /\ UNCHANGED <<exSt, ans, rep, sends, chk>>

BrokenNext == Next \/ \E r \in Runs : BrokenPermit(r)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

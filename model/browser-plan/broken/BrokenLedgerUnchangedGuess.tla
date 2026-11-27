---- MODULE BrokenLedgerUnchangedGuess ----
\* Broken variant (must fail R20): a refused write is marked "found unchanged" without the read showing it (any read, a field
\* it did not compare, an unreadable one taken as unchanged): "not saved" is said of a write that took effect.
EXTENDS LedgerLife

BrokenChecks(r) ==
    /\ st[r] = "refused" /\ ~chk[r] /\ ans[r] = "none"
    /\ chk' = [chk EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<exSt, st, lock, ans, live, ph, rep, sends, knownAt>>

BrokenNext == Next \/ \E r \in Runs : BrokenChecks(r)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

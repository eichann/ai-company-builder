---- MODULE BrokenLedgerReadBackGuess ----
\* Broken variant (must fail R18): the app's read-back reports `done` without the read proving the write landed (a value
\* that was already so, a field it did not compare). The doubt is lifted on a guess, and a write that never took effect
\* is counted done.
EXTENDS LedgerLife

BrokenReadsBack(r) ==
    /\ st[r] = "unknown" /\ ans[r] = "none" /\ rep[r] = "none"
    /\ rep' = [rep EXCEPT ![r] = "done"]
    /\ UNCHANGED <<exSt, st, lock, ans, live, ph, sends, knownAt, chk>>

BrokenNext == Next \/ \E r \in Runs : BrokenReadsBack(r)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

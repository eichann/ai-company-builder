---- MODULE BrokenLedgerDoubtExpires ----
\* Broken variant (must fail R17): the ledger's check looks only at runs not ended — a doubt "expires" with its run's
\* hour, as the run's lock did before the ledger. Created, the answer lost, the run's hour passes, asked again the next
\* day: the same thing twice on the site.
EXTENDS LedgerLife

ExpiringGuard == \A j \in Runs : exSt[j] # "ended" => ~Doubt(j)

BrokenPermit(r) ==
    /\ exSt[r] = "open" /\ st[r] = "none"
    /\ ExpiringGuard
    /\ st' = [st EXCEPT ![r] = "permitted"] /\ lock' = [lock EXCEPT ![r] = "held"] /\ live' = [live EXCEPT ![r] = TRUE]
    /\ knownAt' = [knownAt EXCEPT ![r] = {j \in Runs : j # r /\ ~Doubt(j)}]
    /\ ph' \in {[ph EXCEPT ![r] = "permitted"], [ph EXCEPT ![r] = "gone"]}
    /\ UNCHANGED <<exSt, ans, rep, sends>>

BrokenNext == Next \/ \E r \in Runs : BrokenPermit(r)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

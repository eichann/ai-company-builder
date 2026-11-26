---- MODULE BrokenReserveNoCut ----
\* Broken variant (must fail R5): the reservation takes a whole range whatever is left of the day (the cut to what is left removed; only "something left" checked).
EXTENDS DriveView

BrokenReserve(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "meta"
    /\ IF Min(MCAP - usedM[m], CCAP - used) > 0
       THEN /\ ph' = [ph EXCEPT ![r] = "reserved"] /\ reserved' = [reserved EXCEPT ![r] = CH]
            /\ usedM' = [usedM EXCEPT ![m] = usedM[m] + CH] /\ used' = used + CH /\ UNCHANGED slots
       ELSE EndHolding(r, "refused")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ BrokenReserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

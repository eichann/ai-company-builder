---- MODULE BrokenReserveStale ----
\* Broken variant (must fail R5): the reservation uses what was left of the day when the caps were checked, not the counts
\* read again after the metadata's await — two answers that passed the caps together each reserve from the same leftover.
EXTENDS DriveView

VARIABLE seenLeft   \* what was left of the day when this request passed the caps

BrokenCaps(r) ==
    LET m == Who[r] IN
    /\ Caps(r)
    /\ seenLeft' = [seenLeft EXCEPT ![r] = Min(MCAP - usedM[m], CCAP - used)]

BrokenReserve(r) ==
    LET m == Who[r]
        len == Min(CH, seenLeft[r]) IN
    /\ ph[r] = "meta"
    /\ IF seenLeft[r] > 0
       THEN /\ ph' = [ph EXCEPT ![r] = "reserved"] /\ reserved' = [reserved EXCEPT ![r] = len]
            /\ usedM' = [usedM EXCEPT ![m] = usedM[m] + len] /\ used' = used + len /\ UNCHANGED slots
       ELSE EndHolding(r, "refused")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags, seenLeft>>

Others(r) == Check(r) \/ Meta(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r) \/ Deadline(r)
BrokenInit == Init /\ seenLeft = [r \in Reqs |-> 0]
BrokenNext ==
    \/ (PickNext \/ EnvNext \/ Done \/ (\E r \in Reqs : Others(r))) /\ UNCHANGED seenLeft
    \/ \E r \in Reqs : BrokenCaps(r) \/ BrokenReserve(r)
BrokenSpec == BrokenInit /\ [][BrokenNext]_<<vars, seenLeft>>
====

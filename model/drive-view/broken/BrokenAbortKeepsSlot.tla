---- MODULE BrokenAbortKeepsSlot ----
\* Broken variant (must fail R4): the viewer leaving (the body cancelled, the request aborted) does not release the slot: a leak that refuses every later answer.
EXTENDS DriveView

BrokenAbort(r) ==
    LET m == Who[r] IN
    /\ ph[r] \in Holding
    /\ ph' = [ph EXCEPT ![r] = "aborted"]
    /\ usedM' = [usedM EXCEPT ![m] = usedM[m] - (reserved[r] - delivered[r])]
    /\ used' = used - (reserved[r] - delivered[r])
    /\ reserved' = [reserved EXCEPT ![r] = delivered[r]]
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, slots, flags>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ BrokenAbort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

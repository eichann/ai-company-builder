---- MODULE BrokenAbortNoGiveBack ----
\* Broken variant (must fail R5): an answer ended early keeps its whole reservation counted (the unsent bytes are not given back).
EXTENDS DriveView

BrokenAbort(r) ==
    LET m == Who[r] IN
    /\ ph[r] \in Holding
    /\ ph' = [ph EXCEPT ![r] = "aborted"]
    /\ slots' = [slots EXCEPT ![m] = slots[m] - 1]
    /\ UNCHANGED <<pickVars, envVars, others, seen, reserved, delivered, usedM, used, flags>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ BrokenAbort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenNoStreamCap ----
\* Broken variant (must fail R4): the caps do not count the answers being streamed (the slot check removed).
EXTENDS DriveView

BrokenCaps(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "picked"
    /\ IF usedM[m] < MCAP /\ used < CCAP
       THEN ph' = [ph EXCEPT ![r] = "slot"] /\ slots' = [slots EXCEPT ![m] = slots[m] + 1]
       ELSE ph' = [ph EXCEPT ![r] = "refused"] /\ UNCHANGED slots
    /\ UNCHANGED <<pickVars, envVars, others, seen, reserved, delivered, usedM, used, flags>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ BrokenCaps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

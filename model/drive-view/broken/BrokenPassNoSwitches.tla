---- MODULE BrokenPassNoSwitches ----
\* Broken variant (must fail R2): the call leaves without the last checks (the switches, the grant, the member): a revocation between the pick check and the call does not stop it — a new chunk outlives the revocation.
EXTENDS DriveView

BrokenPass(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "reserved"
    /\ ph' = [ph EXCEPT ![r] = "inflight"] /\ UNCHANGED <<slots, usedM, used, reserved>>
    /\ badPass' = (badPass \/ ~(SwitchesOn(m) /\ grantId[m] = seen[r]))
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, badStart>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ BrokenPass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

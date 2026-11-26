---- MODULE BrokenPassAnyGrant ----
\* Broken variant (must fail R2): streamMedia does not compare the grant with the one the pick check saw (`grant-changed` removed): after a re-consent with another Google account, the call leaves under the new grant.
EXTENDS DriveView

BrokenPass(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "reserved"
    /\ IF SwitchesOn(m)
       THEN ph' = [ph EXCEPT ![r] = "inflight"] /\ UNCHANGED <<slots, usedM, used, reserved>>
            /\ badPass' = (badPass \/ ~(SwitchesOn(m) /\ grantId[m] = seen[r]))
       ELSE EndHolding(r, "failed") /\ UNCHANGED badPass
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, badStart>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ BrokenPass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

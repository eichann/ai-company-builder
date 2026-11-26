---- MODULE BrokenCheckNoAccount ----
\* Broken variant (must fail R2): useViewPick looks the view pick up without the Google account (a pick made under another account counts).
EXTENDS DriveView

BrokenCheck(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "idle"
    /\ IF m = "m1" /\ pickSt[FileOf[r]] = "live" /\ SwitchesOn(m)
       THEN ph' = [ph EXCEPT ![r] = "picked"] /\ seen' = [seen EXCEPT ![r] = grantId[m]]
            /\ badStart' = (badStart \/ ~(LivePick(m, FileOf[r]) /\ SwitchesOn(m)))
       ELSE ph' = [ph EXCEPT ![r] = "refused"] /\ UNCHANGED <<seen, badStart>>
    /\ UNCHANGED <<pickVars, envVars, others, reserved, delivered, slots, usedM, used, badPass>>

BrokenNext == PickNext \/ EnvNext \/ (\E r \in Reqs : BrokenCheck(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r)) \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

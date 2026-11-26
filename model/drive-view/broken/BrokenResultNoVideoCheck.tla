---- MODULE BrokenResultNoVideoCheck ----
\* Broken variant (must fail R1): pageResult keeps the bound file whatever Google says it is (drivePickableFor view / `not-video` removed).
EXTENDS DriveView

BrokenResultFinish ==
    /\ tk = "saving"
    /\ tk' = "done"
    /\ IF tkPress = Bound /\ SwitchesOn("m1") /\ grantAcct["m1"] = tkAcct
       THEN pickSt' = [pickSt EXCEPT ![tkPress] = "live"] /\ pickAcct' = [pickAcct EXCEPT ![tkPress] = tkAcct]
       ELSE UNCHANGED <<pickSt, pickAcct>>
    /\ UNCHANGED <<typeOf, tkPress, tkAcct, aiPicks, readPressed, envVars, reqVars, flags>>

BrokenNext == OpenTicket \/ BrokenResultFinish \/ ReadPick("f2") \/ (\E f \in Files : ResultStart(f) \/ Expire(f)) \/ EnvNext \/ StreamNext \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

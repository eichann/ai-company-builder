---- MODULE BrokenResultKeepsAnyId ----
\* Broken variant (must fail R1): pageResult keeps whatever id the member pressed, not only the id the ticket was bound to (the `not-requested` check removed).
EXTENDS DriveView

BrokenResultFinish ==
    /\ tk = "saving"
    /\ tk' = "done"
    /\ IF typeOf[tkPress] = "video" /\ SwitchesOn("m1") /\ grantAcct["m1"] = tkAcct
       THEN pickSt' = [pickSt EXCEPT ![tkPress] = "live"] /\ pickAcct' = [pickAcct EXCEPT ![tkPress] = tkAcct]
       ELSE UNCHANGED <<pickSt, pickAcct>>
    /\ UNCHANGED <<typeOf, tkPress, tkAcct, aiPicks, readPressed, envVars, reqVars, flags>>

BrokenNext == OpenTicket \/ BrokenResultFinish \/ ReadPick("f2") \/ (\E f \in Files : ResultStart(f) \/ Expire(f)) \/ EnvNext \/ StreamNext \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenViewKeepsAiPick ----
\* Broken variant (must fail R6): a view result is also kept as an ordinary pick (the purpose falling back to `read`), so the AI could read it.
EXTENDS DriveView

BrokenResultFinish ==
    /\ tk = "saving"
    /\ tk' = "done"
    /\ IF tkPress = Bound /\ typeOf[tkPress] = "video" /\ SwitchesOn("m1") /\ grantAcct["m1"] = tkAcct
       THEN pickSt' = [pickSt EXCEPT ![tkPress] = "live"] /\ pickAcct' = [pickAcct EXCEPT ![tkPress] = tkAcct]
            /\ aiPicks' = aiPicks \cup {tkPress}
       ELSE UNCHANGED <<pickSt, pickAcct, aiPicks>>
    /\ UNCHANGED <<typeOf, tkPress, tkAcct, readPressed, envVars, reqVars, flags>>

BrokenNext == OpenTicket \/ BrokenResultFinish \/ ReadPick("f2") \/ (\E f \in Files : ResultStart(f) \/ Expire(f)) \/ EnvNext \/ StreamNext \/ Done
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenFramesConfirmBeforeWindow ----
\* Broken variant (must fail R5): the person's answer is taken before the write's permit + 5 s + 30 s, while the write may
\* still be on its way: されていなかった is true when given and turns false when the request lands afterwards.
EXTENDS FramesLife

BrokenConfirms(k) ==
    /\ k = n /\ st[k] = "unknown" /\ sends[k] = 0
    /\ st' = [st EXCEPT ![k] = "cnotdone"]
    /\ UNCHANGED <<exSt, approved, n, fr, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, outPermit, rep, ph, sends>>

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E k \in Ids : BrokenConfirms(k)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

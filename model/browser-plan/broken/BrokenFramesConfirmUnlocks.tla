---- MODULE BrokenFramesConfirmUnlocks ----
\* Broken variant (must fail R10): the person's answer されていなかった unlocks the run (locked -> open), so its next page
\* write is permitted and sent although the write in doubt rests on the person's word, not the site's.
EXTENDS FramesLife

BrokenConfirms(k) ==
    /\ k = n /\ st[k] = "unknown" /\ Past /\ sends[k] = 0
    /\ st' = [st EXCEPT ![k] = "cnotdone"]
    /\ exSt' = IF exSt = "locked" THEN "open" ELSE exSt
    /\ UNCHANGED <<approved, n, fr, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, outPermit, rep, ph, sends>>

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E k \in Ids : BrokenConfirms(k)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

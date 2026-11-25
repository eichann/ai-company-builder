---- MODULE BrokenFramesTwoInFlight ----
\* Broken variant (must fail R15): `permit` does not wait for the write in flight (the one-in-flight check and the
\* partial unique index removed): a second page write goes out before the first's result is recorded.
EXTENDS FramesLife

BrokenPermits(w) ==
    /\ ph[w] \in Asking /\ exSt = "open" /\ gate = "open"
    /\ Used(FrameOf(ph[w])) < MaxOf(FrameOf(ph[w])) /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

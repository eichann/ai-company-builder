---- MODULE BrokenFramesUsedAfterEnd ----
\* Broken variant (must fail R2): an ended run's unused frames do not vanish — `permit` still gives one.
EXTENDS FramesLife

BrokenPermits(w) ==
    /\ ph[w] \in Asking /\ exSt \in {"open", "ended"} /\ gate = "open" /\ lock = "none"
    /\ Used(FrameOf(ph[w])) < MaxOf(FrameOf(ph[w])) /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

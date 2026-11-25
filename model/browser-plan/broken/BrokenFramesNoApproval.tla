---- MODULE BrokenFramesNoApproval ----
\* Broken variant (must fail R2): `permit` is given while the run still waits for the person's approval of its plan.
EXTENDS FramesLife

BrokenPermits(w) ==
    /\ ph[w] \in Asking /\ exSt \in {"waiting", "open"} /\ gate = "open" /\ lock = "none"
    /\ Used(FrameOf(ph[w])) < MaxOf(FrameOf(ph[w])) /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

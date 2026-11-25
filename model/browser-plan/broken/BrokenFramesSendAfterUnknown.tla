---- MODULE BrokenFramesSendAfterUnknown ----
\* Broken variant (must fail R10): `permit` also gives a permit in a locked run (a write of it was unknown), so the next
\* page write is sent although the last one may already have reached the site.
EXTENDS FramesLife

BrokenPermits(w) ==
    /\ ph[w] \in Asking /\ exSt \in {"open", "locked"} /\ gate = "open" /\ lock = "none"
    /\ Used(FrameOf(ph[w])) < MaxOf(FrameOf(ph[w])) /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenFramesExceedFrame ----
\* Broken variant (must fail R14): `permit` takes a unit of the frame without checking that one is left (the
\* service's `takeUnit` compare-and-set and the table's CHECK used <= max removed).
EXTENDS FramesLife

BrokenPermits(w) == ph[w] \in Asking /\ exSt = "open" /\ gate = "open" /\ lock = "none" /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

---- MODULE BrokenFramesNoPromiseCheck ----
\* Broken variant (must fail R19): `permit` gives a held write outside the run's promise its permit without asking the
\* promise (`browserPromiseVerdict` removed from the server's permit, and the app's own check with it).
EXTENDS FramesLife

BrokenPermits(w) == ph[w] = "out_a" /\ MayPermit("a") /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

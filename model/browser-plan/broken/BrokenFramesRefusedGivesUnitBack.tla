---- MODULE BrokenFramesRefusedGivesUnitBack ----
\* Broken variant (must fail R14): a write the site refused gives its frame's unit back — `permit` counts a frame's used
\* units without the refused writes (the never-given-back rule, `takeUnit` and the trigger's one-way `used`, removed) —, so
\* a corrected try and more take the frame past its max.
EXTENDS FramesLife

UsedNotRefused(f) == Cardinality({k \in Ids : fr[k] = f /\ st[k] # "refused"})

BrokenPermits(w) ==
    /\ ph[w] \in Asking /\ exSt = "open" /\ gate = "open" /\ lock = "none"
    /\ UsedNotRefused(FrameOf(ph[w])) < MaxOf(FrameOf(ph[w])) /\ n < N /\ Permit(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenPermits(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

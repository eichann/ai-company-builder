---- MODULE BrokenFramesSendAfterStop ----
\* Broken variant (must fail R16): the app's last check before the request leaves looks at the permit's age only, not
\* at the AI stop: a permit given before the stop is still used.
EXTENDS FramesLife

BrokenSends(w) == ph[w] = "permitted" /\ age < PERMIT /\ SendNow(w)

BrokenNext == ServerNext \/ AppNext \/ Env \/ \E w \in Workers : BrokenSends(w)
BrokenSpec == Init /\ [][BrokenNext]_vars
====

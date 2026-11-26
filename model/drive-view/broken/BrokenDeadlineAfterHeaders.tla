---- MODULE BrokenDeadlineAfterHeaders ----
\* Broken variant (must fail R7): the answer's deadline (and the viewer's abort) are installed only once Google's media
\* headers arrived (Codex re-review of #875): an answer whose metadata, token or media headers stall holds its slot and its
\* reserved bytes for ever. The deadline exists, fairly, but only for an answer in flight.
EXTENDS DriveView

LateDeadline(r) ==
    /\ ph[r] = "inflight"
    /\ EndHolding(r, "failed")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

LateNext ==
    \/ PickNext \/ EnvNext \/ Done
    \/ \E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r) \/ LateDeadline(r)
BrokenFair == \A r \in Reqs : WF_vars(Caps(r)) /\ WF_vars(Reserve(r)) /\ WF_vars(LateDeadline(r))
BrokenSpec == Init /\ [][LateNext]_vars /\ BrokenFair
====

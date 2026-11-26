---- MODULE BrokenNoAnswerDeadline ----
\* Broken variant (must fail R7): the answer has no deadline of its own — it ends only when the viewer reads it to the end,
\* leaves, or Google fails (review 2026-11-27: a viewer that stops reading but keeps the connection kept its slot and its
\* reserved bytes for ever). The step is still possible, but nothing makes it happen (no fairness on it).
EXTENDS DriveView

BrokenFair == \A r \in Reqs : WF_vars(Caps(r)) /\ WF_vars(Meta(r)) /\ WF_vars(Reserve(r)) /\ WF_vars(Pass(r))
BrokenSpec == Spec /\ BrokenFair
====

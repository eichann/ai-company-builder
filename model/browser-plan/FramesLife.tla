---- MODULE FramesLife ----
\* The life of one run of FREE OPERATION WITHIN FRAMES (redesign step ⑤a): the AI operates a registered domain's
\* page; each write the page makes is held, matched to a frame of the run (a write target × at most `max` uses), sent
\* once under a permit of the server, and reported. Unlike StepsLife, the writes are not known in advance: a run holds
\* only an upper bound per frame. agent-browser.md "Writes within frames" is the contract; each server action names its
\* function in server/src/services/browser-frames.ts (the server's state table, one owner). The app's half (holding the
\* page's write, sending it once through the core's own write connection) is step ⑤b and copies the App* actions.
\* StepsLife.tla stays the model of the safe pattern (ordered writes known in advance); PlanLife.tla today's one write.
\*
\* No site is named. Two frames: "a" (at most 2 uses) and "b" (at most 1); at most N writes in all (a bound for the
\* checker; the frames bound them first). Page writes that come at the same time: the app's one worker (its queue of
\* held page writes) asks for the next one as soon as it sent the previous — before that one's result is recorded —, so
\* the server's one-in-flight rule is what makes the second wait. A second worker would also ask while a permit is
\* held and not yet used — the same rule refuses it — and needs over 4 GB of the checker (left out; the server tests
\* race two permits on the real code). Abstract time as in PlanLife: the 5 s permit = 1, the 30 s grace = 1.
\* A run either needs the person's approval of its plan first (an ad-hoc plan, a `per_run` Skill, a Skill whose text
\* changed) or starts open (a `pre_approved` Skill: an owner / admin approved that version before).
\* `gate`: "stopped" is the AI stop, which the app's window and the server both see (the app checks it right before the
\* request leaves); "closed" folds every cause only the server re-checks at each permit (the person lowered to 見るだけ,
\* the site removed or lowered, the Skill's approval revoked or its declaration changed, another PC, the run's hour).
\* Either way the server refuses every later permit and ends the run; a permit already given stays good for its 5 s
\* under "closed" (the app cannot know), never under "stopped". What is left out: README "What FramesLife leaves out".
EXTENDS Naturals, FiniteSets

Frames == {"a", "b"}
MaxOf(f) == IF f = "a" THEN 2 ELSE 1
Workers == {1}
N == 3
Ids == 1..N
PERMIT == 1         \* a permit's 5 s (BROWSER_PLAN_TIMES.permit)
GRACE == 1          \* the 30 s grace after it
CAP == PERMIT + GRACE
Min(x, y) == IF x < y THEN x ELSE y
Asking == {"ask_a", "ask_b"}
FrameOf(p) == IF p = "ask_a" THEN "a" ELSE "b"

VARIABLES
    \* ---- server (browser_frame_runs, browser_frames, browser_frame_writes) ----
    exSt,         \* the run: waiting (its plan not approved yet), open, locked (a write was unknown), ended
    approved,     \* the plan was approved (by the person on the card, or before: a pre-approved Skill version)
    n,            \* the writes made so far (a row per permit; write n is the latest)
    fr,           \* per write: the frame whose unit its permit took ("-" = not made)
    st,           \* per write: none, permitted, done, notsent, unknown
    age,          \* elapsed since the latest permit (capped at CAP): only one write is ever permitted at a time
    lock,         \* the run's one in-flight slot: none, held
    gate,         \* open, stopped (the AI stop: app and server see it), closed (a cause only the server sees): for good
    \* ---- history ----
    everUnknown,  \* a write of this run was unknown at some point
    afterUnknown, \* a permit was given or a write sent after that
    badPermit,    \* a permit given before the plan was approved, or after the run ended (its frames gone)
    badSend,      \* a send without a live permit for that write
    stopSend,     \* a send after the AI was stopped
    \* ---- network ----
    rep,          \* per write: a report in flight: none, done, notsent, unknown (may come again, late, or never)
    \* ---- app (main process): the worker that handles the held page writes one by one ----
    ph,           \* per worker: idle, ask_a / ask_b (a permit asked for that frame), permitted, sent, gone; a worker
                  \* that is permitted or sent holds write n (the only one ever in flight)
    \* ---- the site ----
    sends         \* per write: how many times it reached the site (capped at 2)

vars == <<exSt, approved, n, fr, st, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>
srvVars == <<exSt, approved, n, fr, st, age, lock, gate, everUnknown, afterUnknown, badPermit>>

Init ==
    /\ approved \in BOOLEAN
    /\ exSt = IF approved THEN "open" ELSE "waiting"
    /\ n = 0 /\ fr = [k \in Ids |-> "-"] /\ st = [k \in Ids |-> "none"] /\ age = 0
    /\ lock = "none" /\ gate = "open"
    /\ everUnknown = FALSE /\ afterUnknown = FALSE /\ badPermit = FALSE /\ badSend = FALSE /\ stopSend = FALSE
    /\ rep = [k \in Ids |-> "none"]
    /\ ph = [w \in Workers |-> "idle"]
    /\ sends = [k \in Ids |-> 0]

Used(f) == Cardinality({k \in Ids : fr[k] = f})
Past == age >= CAP
\* What `permit` requires of the run and the frame (one transaction)
MayPermit(f) == exSt = "open" /\ gate = "open" /\ lock = "none" /\ Used(f) < MaxOf(f) /\ n < N

\* =========================== server (browser-frames.ts) ===========================

\* `approve`: the person approves the plan they saw on the card (its hash), the gate open: waiting -> open.
PersonApproves ==
    /\ exSt = "waiting" /\ gate = "open"
    /\ exSt' = "open" /\ approved' = TRUE
    /\ UNCHANGED <<n, fr, st, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>

\* `permit` (one transaction): the run open (approved, not locked, not ended), the gate open, nothing in flight, the
\* frame's units not used up — then a write row `permitted`, one unit of the frame taken, the in-flight slot held. The
\* answer may be lost (the worker gives that page write up; the write then times out unknown and the run locks).
Permit(w) ==
    LET k == n + 1 IN
    /\ n' = k /\ fr' = [fr EXCEPT ![k] = FrameOf(ph[w])] /\ st' = [st EXCEPT ![k] = "permitted"] /\ age' = 0
    /\ lock' = "held"
    /\ afterUnknown' = (afterUnknown \/ everUnknown)
    /\ badPermit' = (badPermit \/ ~approved \/ exSt = "ended")
    /\ \/ ph' = [ph EXCEPT ![w] = "permitted"]
       \/ ph' = [ph EXCEPT ![w] = "gone"]
    /\ UNCHANGED <<exSt, approved, gate, everUnknown, badSend, stopSend, rep, sends>>
ServerPermits(w) == ph[w] \in Asking /\ MayPermit(FrameOf(ph[w])) /\ Permit(w)

\* `permit` refused: not open (waiting: BROWSER_RUN_NOT_APPROVED; locked: BROWSER_RUN_AFTER_UNKNOWN; ended), a write in
\* flight (BROWSER_RUN_WRITE_IN_FLIGHT: the second page write waits and asks again), the frame used up, or the gate
\* closed — which ends the run (its frames vanish). The worker holds its page write again, or gives it up.
ServerRefuses(w) ==
    /\ ph[w] \in Asking /\ ~MayPermit(FrameOf(ph[w]))
    /\ exSt' = IF gate # "open" /\ exSt \in {"waiting", "open"} THEN "ended" ELSE exSt
    /\ \/ ph' = [ph EXCEPT ![w] = "idle"]
       \/ ph' = [ph EXCEPT ![w] = "gone"]
    /\ UNCHANGED <<approved, n, fr, st, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, sends>>

\* `settle`: the write permitted and silent past permit + 5 s + 30 s (both clocks) -> unknown; the run locks for good.
ServerSettlesUnknown ==
    /\ n > 0 /\ st[n] = "permitted" /\ Past
    /\ st' = [st EXCEPT ![n] = "unknown"] /\ lock' = "none" /\ everUnknown' = TRUE
    /\ exSt' = IF exSt = "open" THEN "locked" ELSE exSt
    /\ UNCHANGED <<approved, n, fr, age, gate, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>

\* `report` (judged after the time-out): permitted + done / not_sent / unknown -> that state, the slot free; unknown
\* locks the run. unknown + done -> done (late and sure), the run stays locked. Anything else: kept as it was.
ServerGetsReport(k) ==
    /\ rep[k] # "none" /\ ~(st[k] = "permitted" /\ Past)
    /\ LET r == rep[k]
           s == st[k]
       IN CASE s = "permitted" /\ r = "done" ->
                 st' = [st EXCEPT ![k] = "done"] /\ lock' = "none" /\ UNCHANGED <<exSt, everUnknown>>
            [] s = "permitted" /\ r = "notsent" ->
                 st' = [st EXCEPT ![k] = "notsent"] /\ lock' = "none" /\ UNCHANGED <<exSt, everUnknown>>
            [] s = "permitted" /\ r = "unknown" ->
                 /\ st' = [st EXCEPT ![k] = "unknown"] /\ lock' = "none" /\ everUnknown' = TRUE
                 /\ exSt' = IF exSt = "open" THEN "locked" ELSE exSt
            [] s = "unknown" /\ r = "done" ->
                 st' = [st EXCEPT ![k] = "done"] /\ UNCHANGED <<lock, exSt, everUnknown>>
            [] OTHER -> UNCHANGED <<st, lock, exSt, everUnknown>>
    /\ \/ rep' = [rep EXCEPT ![k] = "none"]
       \/ UNCHANGED rep    \* the same report arrives again
    /\ UNCHANGED <<approved, n, fr, age, gate, afterUnknown, badPermit, badSend, stopSend, ph, sends>>

ReportLost(k) ==
    /\ rep[k] # "none"
    /\ rep' = [rep EXCEPT ![k] = "none"]
    /\ UNCHANGED <<srvVars, badSend, stopSend, ph, sends>>

\* `end` (the person or the AI ends the run, the run's hour, leaving): the run ends and its unused frames vanish. A
\* write still permitted is left to its report or time-out (it may be on its way).
RunEnds ==
    /\ exSt \in {"waiting", "open", "locked"}
    /\ exSt' = "ended"
    /\ UNCHANGED <<approved, n, fr, st, age, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>

Tick ==
    /\ n > 0 /\ st[n] = "permitted" /\ age < CAP
    /\ age' = age + 1
    /\ UNCHANGED <<exSt, approved, n, fr, st, lock, gate, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>

\* =========================== app (step ⑤b) ===========================

\* The page made a write; the window's gate holds it; it matches a frame (a write matching none is refused at once and
\* never asked for: not modelled). The worker asks the server for a permit for that frame.
AppAsks(w) ==
    /\ ph[w] = "idle"
    /\ \E p \in Asking : ph' = [ph EXCEPT ![w] = p]
    /\ UNCHANGED <<srvVars, badSend, stopSend, rep, sends>>

\* The last check right before the request leaves: the permit live (both clocks) and the AI not stopped; then the page's
\* write goes out ONCE through the core's own write connection (lost, or reaches the site).
SendNow(w) ==
    /\ badSend' = (badSend \/ ~(st[n] = "permitted" /\ age < PERMIT))
    /\ stopSend' = (stopSend \/ gate = "stopped")
    /\ afterUnknown' = (afterUnknown \/ everUnknown)
    /\ \/ UNCHANGED sends
       \/ sends' = [sends EXCEPT ![n] = Min(sends[n] + 1, 2)]
    /\ ph' = [ph EXCEPT ![w] = "sent"]
    /\ UNCHANGED <<exSt, approved, n, fr, st, age, lock, gate, everUnknown, badPermit, rep>>
AppSends(w) == ph[w] = "permitted" /\ age < PERMIT /\ gate # "stopped" /\ SendNow(w)

\* Permitted, but the last check says no (the permit late, stopped, the window gone): never sent -> not_sent.
AppStopsBeforeSend(w) ==
    /\ ph[w] = "permitted"
    /\ rep' = [rep EXCEPT ![n] = "notsent"]
    /\ ph' = [ph EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<srvVars, badSend, stopSend, sends>>

\* After the send: the site's answer -> done ("the site returned success"; never the machine-verified value of a safe
\* pattern); no answer -> unknown. Never sent again. The worker is free for the next page write.
AppAfterSend(w) ==
    /\ ph[w] = "sent"
    /\ \E r \in {"done", "unknown"} : rep' = [rep EXCEPT ![n] = r]
    /\ ph' = [ph EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<srvVars, badSend, stopSend, sends>>

\* Crash or quit at any step: what it held is lost; the server's time-outs settle it.
AppCrashes(w) ==
    /\ ph[w] \notin {"idle", "gone"}
    /\ ph' = [ph EXCEPT ![w] = "gone"]
    /\ UNCHANGED <<srvVars, badSend, stopSend, rep, sends>>

\* =========================== surroundings ===========================

\* The AI is stopped (whole AI, `web`, `mcp-external`; both sides see it), or a cause only the server sees at the next
\* permit happens (the person lowered to 見るだけ, the approval revoked, …): once, at any time, for good in this run.
GateCloses ==
    /\ gate = "open"
    /\ gate' \in {"stopped", "closed"}
    /\ UNCHANGED <<exSt, approved, n, fr, st, age, lock, everUnknown, afterUnknown, badPermit, badSend, stopSend, rep, ph, sends>>

Done ==
    /\ exSt = "ended" /\ lock = "none"
    /\ \A w \in Workers : ph[w] \in {"idle", "gone"}
    /\ \A k \in Ids : rep[k] = "none"
    /\ UNCHANGED vars

ServerNext ==
    \/ PersonApproves \/ RunEnds \/ Tick \/ ServerSettlesUnknown
    \/ \E w \in Workers : ServerPermits(w) \/ ServerRefuses(w)
    \/ \E k \in Ids : ServerGetsReport(k) \/ ReportLost(k)

AppNext ==
    \E w \in Workers : AppAsks(w) \/ AppSends(w) \/ AppStopsBeforeSend(w) \/ AppAfterSend(w) \/ AppCrashes(w)

Env == GateCloses \/ Done

Next == ServerNext \/ AppNext \/ Env

Spec == Init /\ [][Next]_vars

\* =========================== rules ===========================

TypeOK ==
    /\ exSt \in {"waiting", "open", "locked", "ended"} /\ approved \in BOOLEAN
    /\ n \in 0..N /\ fr \in [Ids -> Frames \cup {"-"}] /\ st \in [Ids -> {"none", "permitted", "done", "notsent", "unknown"}]
    /\ age \in 0..CAP /\ lock \in {"none", "held"} /\ gate \in {"open", "stopped", "closed"}
    /\ everUnknown \in BOOLEAN /\ afterUnknown \in BOOLEAN /\ badPermit \in BOOLEAN /\ badSend \in BOOLEAN /\ stopSend \in BOOLEAN
    /\ rep \in [Ids -> {"none", "done", "notsent", "unknown"}]
    /\ ph \in [Workers -> {"idle", "ask_a", "ask_b", "permitted", "sent", "gone"}]
    /\ sends \in [Ids -> 0..2]

\* R1 Each write reaches the site at most once (never resent automatically)
R1_AtMostOneSendPerWrite == \A k \in Ids : sends[k] <= 1

\* R2 Nothing is sent without a live permit for that very write, and no permit before the plan was approved or after
\*    the run ended (its unused frames are gone; a locked run is R10's)
R2_NoSendWithoutApprovalAndLivePermit == ~badSend /\ ~badPermit

\* R4 A write recorded "not sent" (or never permitted) did not reach the site
R4_NotSentMeansNotSent == \A k \in Ids : st[k] \in {"none", "notsent"} => sends[k] = 0

\* R10 After a write of the run was unknown, nothing more is permitted or sent in that run (not even after a late "done")
R10_NothingAfterUnknown == ~afterUnknown

\* R14 A frame is never used more than its max (the permits that took one of its units)
R14_WithinFrames == \A f \in Frames : Used(f) <= MaxOf(f)

\* R15 One write of the run on its way at a time: the second page write waits until the first's result is recorded
R15_OneWriteAtATime == Cardinality({k \in Ids : st[k] = "permitted"}) <= 1

\* R16 Nothing is sent after the AI was stopped (the causes only the server sees stop every later permit: R2)
R16_NoSendAfterStop == ~stopSend

\* R7 From every reachable state a settled state can be reached (reach.mjs on the state graph): every app worker idle
\*    or gone, the run ended (its frames gone), nothing in flight
Settled ==
    /\ \A w \in Workers : ph[w] \in {"idle", "gone"}
    /\ exSt = "ended"
    /\ lock = "none"

====

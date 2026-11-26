---- MODULE DriveView ----
\* Viewing a picked Drive video: the view pick and the streaming of its bytes, with the rules they keep.
\* Copied BY HAND from the code; each action names what it copies. A PR that changes the view pick or the
\* streaming route changes this file in the same PR (google-drive.md "Streaming a picked video").
\*   The pick:   server/src/services/google-drive.ts (startPick with purpose view, pageResult, keepViewPicks,
\*               useViewPick) and shared/core/google-drive.ts (DRIVE_VIEW_MIMES, drivePickableFor).
\*   The stream: server/src/services/google-drive-view.ts (open: the pick, the caps, the session's metadata, the
\*               bytes reserved, the answer ending once) and server/src/services/google-client.ts (streamMedia: the
\*               last checks before the call leaves, the grant the check saw).
\* One company. Two members: m1 picks, m2 never does. Two files: f1 (the one a document asks for: the view ticket is
\* bound to it) and f2 (another file the member could press in the Picker; the AI's reading ticket may pick it).
\* Three requests (each one range of the player = one answer): r1, r2 by m1 for f1, r3 by m2 for f1.
\* Bytes are abstract units: a range is at most CH; the day's caps are MCAP per member and CCAP for the company.
\* What is left out: README "What the model leaves out".
EXTENDS Naturals, FiniteSets

Members == {"m1", "m2"}
Files == {"f1", "f2"}
Accounts == {"A", "B"}
Reqs == {"r1", "r2", "r3"}
Who == [r \in Reqs |-> IF r = "r3" THEN "m2" ELSE "m1"]
FileOf == [r \in Reqs |-> "f1"]
Bound == "f1"
CH == 2
MCAP == 3
CCAP == 4
MAXS == 1
Min(x, y) == IF x < y THEN x ELSE y

\* A request's phases (google-drive-view.ts open):
\*   idle → picked (useViewPick passed) → slot (the caps passed, a stream slot taken) → meta (type and size read)
\*   → reserved (the bytes reserved) → inflight (streamMedia's last checks passed: the call left) → done
\*   refused: before a slot; failed / aborted: after one (the slot released, the unsent bytes given back)
Holding == {"slot", "meta", "reserved", "inflight"}
Final == {"refused", "done", "failed", "aborted"}

VARIABLES
    \* ---- the pick (google_drive_pick_tickets, google_drive_view_picks, google_drive_picks) ----
    typeOf,       \* what Google reports each file to be: video or pdf (fixed at the start)
    tk,           \* the view ticket bound to f1: none, open, saving (the result is being checked with Google), done
    tkPress,      \* the file the member pressed 選択 on in the Picker
    tkAcct,       \* the grant's account read before Google was asked
    pickSt,       \* m1's view pick of each file: none, live, expired
    pickAcct,     \* the account it was made under
    aiPicks,      \* the files m1's AI may read (ordinary picks)
    readPressed,  \* the files m1 pressed in a reading ticket (history read by R6)
    \* ---- Google and the company ----
    grant,        \* each member's grant: active, revoked
    grantAcct,    \* the Google account the grant has
    grantId,      \* the grant's id (a re-consent makes a new one)
    driveOn,      \* the company's Drive switch (「会社で使うもの」) — the member's own Drive switch acts alike
    inCo,         \* still a member of the company
    envUsed,      \* environment events used up (each at most once, to keep the model finite)
    \* ---- the requests ----
    ph,           \* the phase (above)
    seen,         \* the grant id the pick check saw
    reserved,     \* bytes reserved before the call
    delivered,    \* bytes passed on to the viewer
    slots,        \* answers being streamed per member (google-drive-view.ts `open`)
    usedM,        \* bytes counted today per member (broker_usage, drive-view:bytes)
    used,         \* bytes counted today in the company (every member)
    others,       \* bytes other members' answers reserved today (folded into one step: they follow the same rule)
    \* ---- history read by the rules ----
    badStart,     \* a request got past the pick check without a live view pick of that member, file and account, or
                  \*   with the grant / switches / membership off
    badPass       \* a request's call left (inflight) while the grant was not the one checked, or anything was off

vars == <<typeOf, tk, tkPress, tkAcct, pickSt, pickAcct, aiPicks, readPressed, grant, grantAcct, grantId, driveOn, inCo, envUsed,
          ph, seen, reserved, delivered, slots, usedM, used, others, badStart, badPass>>
pickVars == <<typeOf, tk, tkPress, tkAcct, pickSt, pickAcct, aiPicks, readPressed>>
envVars == <<grant, grantAcct, grantId, driveOn, inCo, envUsed>>
reqVars == <<ph, seen, reserved, delivered, slots, usedM, used, others>>
flags == <<badStart, badPass>>

Init ==
    /\ typeOf \in [Files -> {"video", "pdf"}] /\ typeOf["f2"] = "video"
    /\ tk = "none" /\ tkPress = "none" /\ tkAcct = "none"
    /\ pickSt = [f \in Files |-> "none"] /\ pickAcct = [f \in Files |-> "none"]
    /\ aiPicks = {} /\ readPressed = {}
    /\ grant = [m \in Members |-> "active"] /\ grantAcct = [m \in Members |-> "A"] /\ grantId = [m \in Members |-> 0]
    /\ driveOn = TRUE /\ inCo = [m \in Members |-> TRUE] /\ envUsed = {}
    /\ ph = [r \in Reqs |-> "idle"] /\ seen = [r \in Reqs |-> 0]
    /\ reserved = [r \in Reqs |-> 0] /\ delivered = [r \in Reqs |-> 0]
    /\ slots = [m \in Members |-> 0] /\ usedM = [m \in Members |-> 0] /\ used = 0 /\ others = 0
    /\ badStart = FALSE /\ badPass = FALSE

\* The member may use Drive now: what useViewPick checks besides the pick, and streamMedia before the call leaves.
SwitchesOn(m) == grant[m] = "active" /\ driveOn /\ inCo[m]
\* A live view pick of that file by that member under the account the grant has now (only m1 ever picks).
LivePick(m, f) == m = "m1" /\ pickSt[f] = "live" /\ pickAcct[f] = grantAcct[m]

\* =========================== the pick ===========================

\* google-drive.ts startPick (purpose view): files mode, exactly one id — the ticket is bound to it (f1). Session only;
\* the grant active with drive.file and Drive on (else no ticket).
OpenTicket ==
    /\ tk = "none" /\ SwitchesOn("m1")
    /\ tk' = "open"
    /\ UNCHANGED <<typeOf, tkPress, tkAcct, pickSt, pickAcct, aiPicks, readPressed, envVars, reqVars, flags>>

\* The Picker page's result (google-drive.ts pageResult), first half: the pressed id (the page drops another id, but
\* the server does not trust the page); the grant read before Google is asked (else nothing asked, the ticket fails).
ResultStart(f) ==
    /\ tk = "open"
    /\ IF SwitchesOn("m1")
       THEN tk' = "saving" /\ tkPress' = f /\ tkAcct' = grantAcct["m1"]
       ELSE tk' = "done" /\ UNCHANGED <<tkPress, tkAcct>>
    /\ UNCHANGED <<typeOf, pickSt, pickAcct, aiPicks, readPressed, envVars, reqVars, flags>>

\* pageResult, second half (after Google answered checkPicks): kept only when the id is the bound one
\* (`not-requested` otherwise, before Google), Google says it is a video (drivePickableFor view = DRIVE_VIEW_MIMES),
\* and the grant is still active under the same account (`GOOGLE_ACCOUNT_CHANGED` otherwise). keepViewPicks writes
\* google_drive_view_picks only — never an ordinary pick.
ResultFinish ==
    /\ tk = "saving"
    /\ tk' = "done"
    /\ IF tkPress = Bound /\ typeOf[tkPress] = "video" /\ SwitchesOn("m1") /\ grantAcct["m1"] = tkAcct
       THEN pickSt' = [pickSt EXCEPT ![tkPress] = "live"] /\ pickAcct' = [pickAcct EXCEPT ![tkPress] = tkAcct]
       ELSE UNCHANGED <<pickSt, pickAcct>>
    /\ UNCHANGED <<typeOf, tkPress, tkAcct, aiPicks, readPressed, envVars, reqVars, flags>>

\* The AI's reading ticket (purpose read, another path): what the member presses there becomes a pick the AI reads.
ReadPick(f) ==
    /\ "read" \notin envUsed /\ SwitchesOn("m1")
    /\ aiPicks' = aiPicks \cup {f} /\ readPressed' = readPressed \cup {f}
    /\ envUsed' = envUsed \cup {"read"}
    /\ UNCHANGED <<typeOf, tk, tkPress, tkAcct, pickSt, pickAcct, grant, grantAcct, grantId, driveOn, inCo, reqVars, flags>>

\* 90 days without a play (DRIVE_VIEW_PICK_TTL_MS): the view pick lapses (at any time here — wider, safe side).
Expire(f) ==
    /\ pickSt[f] = "live" /\ ("expire" \notin envUsed)
    /\ pickSt' = [pickSt EXCEPT ![f] = "expired"] /\ envUsed' = envUsed \cup {"expire"}
    /\ UNCHANGED <<typeOf, tk, tkPress, tkAcct, pickAcct, aiPicks, readPressed, grant, grantAcct, grantId, driveOn, inCo, reqVars, flags>>

\* =========================== the environment ===========================

\* At most two of the revocation events in one run (any two, in any order, at any time): keeps the model finite and
\* small; each pair of them is still explored against every point of every request.
Room == Cardinality(envUsed \cap {"revoke", "reconsent", "driveoff", "remove"}) < 2

\* An admin's 「止める」, 「すべての鍵を止める」, the member's 「許可をやめる」, Google's invalid_grant.
Revoke(m) ==
    /\ grant[m] = "active" /\ ("revoke" \notin envUsed) /\ Room
    /\ grant' = [grant EXCEPT ![m] = "revoked"] /\ envUsed' = envUsed \cup {"revoke"}
    /\ UNCHANGED <<pickVars, grantAcct, grantId, driveOn, inCo, reqVars, flags>>

\* 「Google で許可」 again: a new grant (a new id), under the same or another Google account.
Reconsent(m, a) ==
    /\ ("reconsent" \notin envUsed) /\ inCo[m] /\ Room
    /\ grant' = [grant EXCEPT ![m] = "active"] /\ grantAcct' = [grantAcct EXCEPT ![m] = a]
    /\ grantId' = [grantId EXCEPT ![m] = grantId[m] + 1] /\ envUsed' = envUsed \cup {"reconsent"}
    /\ UNCHANGED <<pickVars, driveOn, inCo, reqVars, flags>>

\* The company's Drive switch off (the member's own Drive switch, the company's Google off and the operator's stop act
\* alike: useViewPick and streamMedia check them all).
DriveOff ==
    /\ driveOn /\ ("driveoff" \notin envUsed) /\ Room
    /\ driveOn' = FALSE /\ envUsed' = envUsed \cup {"driveoff"}
    /\ UNCHANGED <<pickVars, grant, grantAcct, grantId, inCo, reqVars, flags>>

\* Other members' answers reserve the company's bytes by the same rule as Reserve (cut to what is left of the day).
OthersStream ==
    LET left == CCAP - used IN
    /\ others = 0 /\ left > 0
    /\ others' = Min(CH, left) /\ used' = used + Min(CH, left)
    /\ UNCHANGED <<pickVars, envVars, ph, seen, reserved, delivered, slots, usedM, flags>>

\* The member removed from the company (forgetMember also deletes their view picks).
Remove(m) ==
    /\ inCo[m] /\ ("remove" \notin envUsed) /\ Room
    /\ inCo' = [inCo EXCEPT ![m] = FALSE] /\ envUsed' = envUsed \cup {"remove"}
    /\ IF m = "m1" THEN pickSt' = [f \in Files |-> "none"] ELSE UNCHANGED pickSt
    /\ UNCHANGED <<typeOf, tk, tkPress, tkAcct, pickAcct, aiPicks, readPressed, grant, grantAcct, grantId, driveOn, reqVars, flags>>

\* =========================== the stream ===========================

\* What every way out after a slot does once (google-drive-view.ts `release` and `giveBack`): the slot released, the
\* bytes reserved but not passed on given back.
EndHolding(r, to) ==
    LET m == Who[r] IN
    /\ ph' = [ph EXCEPT ![r] = to]
    /\ slots' = [slots EXCEPT ![m] = slots[m] - 1]
    /\ usedM' = [usedM EXCEPT ![m] = usedM[m] - (reserved[r] - delivered[r])]
    /\ used' = used - (reserved[r] - delivered[r])
    /\ reserved' = [reserved EXCEPT ![r] = delivered[r]]

\* open step 1: googleDrive.useViewPick (google-drive.ts): the company's Google and Drive switch, the grant active with
\* drive.file, a live view pick of exactly that file by that member under the account the grant has now. Remembers the
\* grant it saw (DriveViewUse.grantId).
Check(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "idle"
    /\ IF LivePick(m, FileOf[r]) /\ SwitchesOn(m)
       THEN ph' = [ph EXCEPT ![r] = "picked"] /\ seen' = [seen EXCEPT ![r] = grantId[m]]
            /\ badStart' = (badStart \/ ~(LivePick(m, FileOf[r]) /\ SwitchesOn(m)))
       ELSE ph' = [ph EXCEPT ![r] = "refused"] /\ UNCHANGED <<seen, badStart>>
    /\ UNCHANGED <<pickVars, envVars, others, reserved, delivered, slots, usedM, used, badPass>>

\* open step 3: the caps in one synchronous stretch with taking the slot (answers at once, the day's bytes).
Caps(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "picked"
    /\ IF slots[m] < MAXS /\ usedM[m] < MCAP /\ used < CCAP
       THEN ph' = [ph EXCEPT ![r] = "slot"] /\ slots' = [slots EXCEPT ![m] = slots[m] + 1]
       ELSE ph' = [ph EXCEPT ![r] = "refused"] /\ UNCHANGED slots
    /\ UNCHANGED <<pickVars, envVars, others, seen, reserved, delivered, usedM, used, flags>>

\* open step 4: the session's type and size, read from Google (an await: anything may happen meanwhile); a failure
\* or a type not on the list ends the answer.
Meta(r) ==
    /\ ph[r] = "slot"
    /\ \/ ph' = [ph EXCEPT ![r] = "meta"] /\ UNCHANGED <<slots, usedM, used, reserved>>
       \/ EndHolding(r, "failed")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* open step 5: the bytes reserved, read again in one synchronous stretch: at most CH, cut to what is left of the
\* member's and the company's day; nothing left → 429.
Reserve(r) ==
    LET m == Who[r]
        left == Min(MCAP - usedM[m], CCAP - used)
        len == Min(CH, left) IN
    /\ ph[r] = "meta"
    /\ IF left > 0
       THEN /\ ph' = [ph EXCEPT ![r] = "reserved"] /\ reserved' = [reserved EXCEPT ![r] = len]
            /\ usedM' = [usedM EXCEPT ![m] = usedM[m] + len] /\ used' = used + len /\ UNCHANGED slots
       ELSE EndHolding(r, "refused")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* google-client.ts streamMedia: every switch, the grant active and still the one the pick check saw (`grant-changed`
\* otherwise), drive.file, Drive on — checked before the access token and again after it (a refresh can take seconds),
\* and from that last check to the call leaving nothing is awaited: this step is that last check. Not passing: nothing
\* sent, the slot released.
Pass(r) ==
    LET m == Who[r] IN
    /\ ph[r] = "reserved"
    /\ IF SwitchesOn(m) /\ grantId[m] = seen[r]
       THEN ph' = [ph EXCEPT ![r] = "inflight"] /\ UNCHANGED <<slots, usedM, used, reserved>>
            /\ badPass' = (badPass \/ ~(SwitchesOn(m) /\ grantId[m] = seen[r]))
       ELSE EndHolding(r, "failed") /\ UNCHANGED badPass
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, badStart>>

\* The answer's bytes pass on to the viewer as Google sends them, never more than reserved (the pull's cut).
Deliver(r) ==
    /\ ph[r] = "inflight" /\ delivered[r] < reserved[r]
    /\ delivered' = [delivered EXCEPT ![r] = delivered[r] + 1]
    /\ UNCHANGED <<pickVars, envVars, others, ph, seen, reserved, slots, usedM, used, flags>>

\* The last byte passed on: `finish(true)`.
Finish(r) ==
    /\ ph[r] = "inflight" /\ delivered[r] = reserved[r]
    /\ EndHolding(r, "done")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* The viewer left (the request's signal, the body cancelled) at any point after the slot: the call to Google is
\* aborted (or never sent), `finish(false)`.
Abort(r) ==
    /\ ph[r] \in Holding
    /\ EndHolding(r, "aborted")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* Google failed mid-answer or ended short: `fail('failed')` (the stream errors).
Fail(r) ==
    /\ ph[r] = "inflight"
    /\ EndHolding(r, "failed")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* The answer's own deadline (`answerMs`, a timer of the server's: it fires whether or not the viewer reads): the same
\* ending. Under weak fairness it is what makes R7 hold for a viewer that keeps the connection open and reads nothing.
Deadline(r) ==
    /\ ph[r] = "inflight"
    /\ EndHolding(r, "failed")
    /\ UNCHANGED <<pickVars, envVars, others, seen, delivered, flags>>

\* Settled: every request ended, the ticket closed (a stuttering step, so a finished run is not a dead end).
Settled == (\A r \in Reqs : ph[r] \in Final) /\ tk \in {"none", "done"}
Done == Settled /\ UNCHANGED vars

PickNext == OpenTicket \/ ResultFinish \/ ReadPick("f2") \/ (\E f \in Files : ResultStart(f) \/ Expire(f))
EnvNext == DriveOff \/ OthersStream \/(\E m \in Members : Revoke(m) \/ Remove(m) \/ (\E a \in Accounts : Reconsent(m, a)))
StreamNext == \E r \in Reqs : Check(r) \/ Caps(r) \/ Meta(r) \/ Reserve(r) \/ Pass(r) \/ Deliver(r) \/ Finish(r) \/ Abort(r) \/ Fail(r) \/ Deadline(r)

Next == PickNext \/ EnvNext \/ StreamNext \/ Done
Spec == Init /\ [][Next]_vars

\* The server's own steps are weakly fair (each awaits something with a time limit: the metadata, the token, its
\* deadline); the viewer's (Deliver, Abort) and Google's (Fail) are not — a viewer may read nothing for ever.
ServerFair == \A r \in Reqs : WF_vars(Caps(r)) /\ WF_vars(Meta(r)) /\ WF_vars(Reserve(r)) /\ WF_vars(Pass(r)) /\ WF_vars(Deadline(r))
LiveSpec == Spec /\ ServerFair

\* R7 (liveness, under ServerFair) A held stream slot is always released: every answer that took a slot ends
R7_SlotReleased == \A r \in Reqs : (ph[r] \in Holding) ~> (ph[r] \in Final)

\* =========================== the rules ===========================

TypeOK ==
    /\ typeOf \in [Files -> {"video", "pdf"}]
    /\ tk \in {"none", "open", "saving", "done"} /\ tkPress \in Files \cup {"none"} /\ tkAcct \in Accounts \cup {"none"}
    /\ pickSt \in [Files -> {"none", "live", "expired"}] /\ pickAcct \in [Files -> Accounts \cup {"none"}]
    /\ aiPicks \subseteq Files /\ readPressed \subseteq Files
    /\ grant \in [Members -> {"active", "revoked"}] /\ grantAcct \in [Members -> Accounts] /\ grantId \in [Members -> 0..1]
    /\ driveOn \in BOOLEAN /\ inCo \in [Members -> BOOLEAN]
    /\ ph \in [Reqs -> {"idle", "picked", "slot", "meta", "reserved", "inflight", "refused", "done", "failed", "aborted"}]
    /\ seen \in [Reqs -> 0..1] /\ reserved \in [Reqs -> 0..CH] /\ delivered \in [Reqs -> 0..CH]
    \* The shapes only (the caps themselves are R4's and R5's, so a broken variant fails on the rule it breaks)
    /\ slots \in [Members -> 0..3] /\ usedM \in [Members -> 0..(3 * CH)] /\ used \in 0..(4 * CH) /\ others \in 0..CH
    /\ badStart \in BOOLEAN /\ badPass \in BOOLEAN

\* R1 A view pick exists only for the file its ticket was bound to, and only when Google said it is a video
R1_ViewPickOnlyBoundVideo == \A f \in Files : pickSt[f] # "none" => f = Bound /\ typeOf[f] = "video"

\* R2 A stream starts only for a live view pick of that member, file and Google account, with the grant active, the
\*    switches on and the member in the company (when the pick was checked), and its call leaves only under the very
\*    grant that check saw, with every switch still on (when the call leaves)
R2_StreamOnlyForLivePick == ~badStart /\ ~badPass

\* R3 No stream outlives a revocation (grant revoked or replaced, Drive off, member removed) by more than what was
\*    already in flight: a request not yet in flight never leaves while revoked (R2's second half), and what is in
\*    flight is at most MAXS answers of the member, each at most CH bytes
R3_OnlyInFlightOutlivesRevocation ==
    \A m \in Members :
        /\ Cardinality({r \in Reqs : Who[r] = m /\ ph[r] = "inflight"}) <= MAXS
        /\ \A r \in Reqs : Who[r] = m /\ ph[r] = "inflight" => delivered[r] <= reserved[r] /\ reserved[r] <= CH

\* R4 Answers being streamed per member stay within the cap, and the count is exactly the answers holding a slot
\*    (released on finish, abort and failure: no leak)
R4_StreamsPerMember ==
    \A m \in Members :
        /\ slots[m] <= MAXS
        /\ slots[m] = Cardinality({r \in Reqs : Who[r] = m /\ ph[r] \in Holding})

\* R5 The day's bytes stay within the member's and the company's caps, and what is counted is exactly what is reserved
\*    by answers under way plus what ended answers passed on
Counted(r) == IF ph[r] \in {"reserved", "inflight", "done", "failed", "aborted"} THEN reserved[r] ELSE 0
R5_BytesPerDay ==
    /\ \A m \in Members : usedM[m] <= MCAP
    /\ used <= CCAP
    /\ usedM["m1"] = Counted("r1") + Counted("r2")
    /\ usedM["m2"] = Counted("r3")
    /\ used = usedM["m1"] + usedM["m2"] + others
    /\ \A r \in Reqs : ph[r] \in Final => reserved[r] = delivered[r]

\* R6 A view pick never becomes an AI-readable pick: the AI's picks are only files pressed in a reading ticket
R6_ViewPickNeverAiPick == aiPicks \subseteq readPressed

====

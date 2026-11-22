---- MODULE HoleServerClockJumps ----
\* OPEN HOLE in today's code (fails R5; expected to fail until 6b-2a fixes the server). The server's
\* wall clock jumps FORWARD by 35 s or more right after a permit (a one-shot NTP correction, a VM's time
\* sync). server/src/services/browser-plans.ts judges every time-out by the wall clock (settleExecution,
\* report, confirm: `now >= permittedAt + permit + grace`) and refuses only a clock that went BACK
\* (BROWSER_CLOCK_BACKWARDS). So the server believes 35 s have passed, turns the execution unknown,
\* accepts the person's 「確かめた：されていなかった」 (confirmed_not_done) and releases the lock — while in
\* reality the 5 s permit is still running and the app sends, correctly by its own clocks. The
\* "not done" confirmation turns false afterwards, and the next plan may enter the same target.
\* The fix (proposals/FixServerClockJumps: also require the monotonic elapsed time) passes every rule.
EXTENDS PlanLife

\* Same action as in proposals/FixServerClockJumps
ServerClockJumps(p) ==
    /\ exSt[p] = "permitted" /\ srvAge[p] < CAP
    /\ srvAge' = [srvAge EXCEPT ![p] = CAP]
    /\ UNCHANGED <<planSt, approvedEver, exSt, holder, lock, realAge, permitReq, rep, appVars, siteVars>>

\* Tick caps srvAge at CAP, so after the jump only the real elapsed time (realAge) and the app's (el) move
HoleNext == Next \/ \E p \in Plans : ServerClockJumps(p)
HoleSpec == Init /\ [][HoleNext]_vars
====

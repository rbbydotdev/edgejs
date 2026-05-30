// Pre-patch on lib/internal/timers.js: wrap binding.scheduleTimer and
// binding.toggleImmediateRef so a JS-side setTimeout / setImmediate
// notifies a parked poll_oneoff.
//
// THE BUG
//
// Our libuv-wasix `poll_oneoff` parks inside `Atomics.wait(wake, 0, ...)`
// for up to ~30 seconds with no JS-side wake when a host-driven call
// (corpus driver, lib's deferred work, ...) queues a timer or immediate
// while wasm is already parked.  Without this patch a `setTimeout(fn, 0)`
// scheduled after the user-script sync portion completes waits the full
// 30-second `Atomics.wait` timeout before fire.
//
// The wake notify pattern (`Atomics.add + Atomics.notify` on the wake
// slot) is the same one used by `pushRequest` and `requestExit` inside
// `wasi-shim.ts` (lines 726-727 and 2168-2169).  Adding it here closes
// the gap for the missing "host queued a timer" wake source.
//
// THE FIX
//
// `worker.ts` installs `globalThis.__edgeWakePoll()` after the shim is
// created.  This patch intercepts:
//
//   binding.scheduleTimer(msecs)
//     called from lib/internal/timers.js insert() whenever the new
//     timer expires sooner than the prior nextExpiry. Wrap to notify
//     wake after the underlying call returns.
//
//   binding.toggleImmediateRef(true)
//     called when an Immediate transitions to ref'd state, including
//     when the first setImmediate of a batch fires (Immediate.ref
//     line 696).  Wrap to notify wake after.
//
// CAVEATS
//
// - Subsequent setImmediates (after the first ref'd one) don't go
//   through the binding at all — they queue via immediateQueue + bump
//   immediateInfo[kCount] directly.  Those don't get a wake from this
//   patch, but they don't need one: poll_oneoff would already be
//   unparked from the first wake, and libuv will process the whole
//   queue in the check phase.
//
// - process.nextTick / queueMicrotask are NOT covered by this patch.
//   queueMicrotask is intercepted by `task-queue-enqueue-fix` and
//   routed to the host's native queueMicrotask, which drains
//   independently of libuv's loop.  nextTick uses a C++ tick callback
//   that runs between libuv operations; while wasm is parked in
//   poll_oneoff, nextTick can't fire — but that's only a concern when
//   nextTick is queued from OUTSIDE wasm (rare).

;(function patchPollWakeOnSchedule() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("timers"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgePollWakePatched) return;

  function notifyWake() {
    var wake = globalThis.__edgeWakePoll;
    if (typeof wake === "function") {
      try { wake(); } catch (_e) { void _e; }
    }
  }

  if (typeof b.scheduleTimer === "function") {
    var origScheduleTimer = b.scheduleTimer;
    b.scheduleTimer = function scheduleTimer(msecs) {
      var ret = origScheduleTimer.call(this, msecs);
      notifyWake();
      return ret;
    };
  }
  if (typeof b.toggleImmediateRef === "function") {
    var origToggleImmediateRef = b.toggleImmediateRef;
    b.toggleImmediateRef = function toggleImmediateRef(ref) {
      var ret = origToggleImmediateRef.call(this, ref);
      if (ref) notifyWake();
      return ret;
    };
  }
  b.__edgePollWakePatched = true;
})();

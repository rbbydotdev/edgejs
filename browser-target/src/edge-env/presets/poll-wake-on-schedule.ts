// poll-wake-on-schedule preset.
//
// Wakes a parked `poll_oneoff` whenever lib/internal/timers schedules a
// new timer or first-immediate.  Closes the wake-source gap documented
// in NOTES.md `corpus-mustcall-not-verified` — host-driven setTimeout /
// setImmediate calls used to wait up to ~30 seconds for the wasm
// `Atomics.wait` to time out before the timer would fire.
//
// Depends on `worker.ts` installing `globalThis.__edgeWakePoll()` after
// the wasi-shim is created.  See `poll-wake-on-schedule.patch.js` for
// the full rationale + caveats.

import type { Preset } from "../types";
import pollWakeSrc from "./poll-wake-on-schedule/poll-wake-on-schedule.patch.js?raw";

export const pollWakeOnSchedule: Preset = {
  name: "poll-wake-on-schedule",
  description:
    "Wrap internalBinding('timers').scheduleTimer and toggleImmediateRef " +
    "to call globalThis.__edgeWakePoll() after scheduling — wakes the " +
    "parked wasi-shim poll_oneoff so the libuv loop processes the new " +
    "timer immediately instead of waiting ~30s for the Atomics.wait " +
    "default to time out.  Required for honest mustCall verification " +
    "on async-event-driven tests.",
  patch: {
    "internal/timers": { pre: pollWakeSrc },
  },
};

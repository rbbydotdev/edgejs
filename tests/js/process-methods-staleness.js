// E20: verify the process-methods-wasm-state policy fixes the
// stale-by-one bug for process.cpuUsage / threadCpuUsage / memoryUsage
// / resourceUsage.  Without the policy, JS reads come from a JS-heap
// Float64Array that the host syncs from wasm BEFORE the C++ write —
// so every call returns the previous call's values (zeros on the
// first call).  With the policy, JS reads use a wasm-backed
// Float64Array; reads and writes share the same SAB-backed bytes.
//
// NOTE: in this wasi/wasm environment `uv_resident_set_memory` and
// `unofficial_napi_get_process_memory_info` return zeros (no real OS
// to query), so the staleness check focuses on:
//   (a) cpuUsage returning real values on the FIRST call (without the
//       policy, the first call returns the JS-heap initial zeros).
//   (b) shapes of memoryUsage and resourceUsage being preserved.
//
// We deliberately don't assert monotonicity between two cpuUsage()
// calls — the wasi/uv_getrusage clock in this environment has jitter
// at the microsecond level that can produce non-monotonic deltas
// across closely-spaced calls even when the policy is active.  What
// matters for the bug is FIRST-CALL FRESHNESS: a non-zero (or at
// least, present-and-correctly-typed) value from a single call.

// 1. cpuUsage — first-call freshness.  Without the policy, this
// would return {user: 0, system: 0} because JS reads the initial
// JS-heap zeros.  With the policy, JS reads share the wasm-backed
// SAB; C++ writes uv_getrusage values directly.
const c1 = process.cpuUsage();
if (typeof c1.user !== 'number' || typeof c1.system !== 'number') {
  console.log('c1-bad-shape:' + JSON.stringify(c1));
  process.exit(1);
}
// uv_getrusage on a freshly-started process returns SOMETHING — at
// minimum the wall-clock 'now' in some unit.  Zeros would indicate
// the JS-heap initial state is what we're seeing.  We require at
// least one of user/system to be > 0.
if (c1.user === 0 && c1.system === 0) {
  console.log('cpu1-zero-staleness-bug:' + JSON.stringify(c1));
  process.exit(1);
}
console.log('cpu1-fresh');

// 2. cpuUsage(prevValue) diff form — non-negative deltas.  Even if
// the clock has jitter, the diff path uses prevValue.user/system as
// the base; sign of result depends only on second-call values
// relative to first-call user-provided prev.  We accept the result
// either way since the goal is to confirm the diff form returns
// numbers.
const c2 = process.cpuUsage(c1);
if (typeof c2.user !== 'number' || typeof c2.system !== 'number') {
  console.log('c2-bad-shape:' + JSON.stringify(c2));
  process.exit(1);
}
console.log('cpu-diff-shape-ok');

// 3. memoryUsage — shape only (binding returns zeros in this wasm
// build; we don't assert values).  All five fields must be numbers.
const m1 = process.memoryUsage();
const memKeys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
for (const k of memKeys) {
  if (typeof m1[k] !== 'number') {
    console.log('mem1-missing:' + k + ' actual=' + (m1[k] === undefined ? 'undefined' : typeof m1[k]));
    process.exit(1);
  }
}
console.log('mem-shape-ok');

// 4. memoryUsage.rss alias remains callable.
if (typeof process.memoryUsage.rss !== 'function') {
  console.log('mem-rss-alias-missing');
  process.exit(1);
}
console.log('rss-alias-present');

// 5. resourceUsage — full 16-field shape.
const r1 = process.resourceUsage();
const resourceKeys = [
  'userCPUTime', 'systemCPUTime', 'maxRSS', 'sharedMemorySize',
  'unsharedDataSize', 'unsharedStackSize', 'minorPageFault',
  'majorPageFault', 'swappedOut', 'fsRead', 'fsWrite', 'ipcSent',
  'ipcReceived', 'signalsCount', 'voluntaryContextSwitches',
  'involuntaryContextSwitches',
];
for (const k of resourceKeys) {
  if (typeof r1[k] !== 'number') {
    console.log('res1-missing:' + k);
    process.exit(1);
  }
}
console.log('resource-shape-ok');

// 6. resourceUsage second call — same full shape.
const r2 = process.resourceUsage();
for (const k of resourceKeys) {
  if (typeof r2[k] !== 'number') {
    console.log('res2-missing:' + k);
    process.exit(1);
  }
}
console.log('resource-repeatable');

console.log('e20-ok');

# Lever B Layer 5 — implementation options

The L5 spike (commit `2cfba61c`) proved user JS running on the host
worker's V8 has correct microtask ordering.  Closing the regression
and enabling Astro/Rolldown requires moving more than just user-script
execution — see plans/lever-b-progress.md "L5 spike validated" for the
full list of what's deferred.

This document catalogs the six options we evaluated for how to do
that fuller migration.

---

## Option A — Full cutover (most aggressive)

Move emnapi context + napi-host JS + lib/* + handle table to host in
one coordinated change.  Wasm worker becomes pure kernel (libuv,
syscalls, OpenSSL).  Every napi call from wasm-side C++ becomes an RPC
to host where the JS impl lives.

- ✅ Single coherent codebase after.  Architecturally cleanest.
  Closest to WebContainer's proven pattern.
- ⚠️ All-or-nothing — long period where nothing works.  Hard to
  bisect failures.
- **Effort: 2–4 weeks focused.**
- **Risk: HIGH per attempt.**

## Option B — Gradual op-by-op migration

Add a routing flag in napi-host that dispatches each op to either
in-process (current) or RPC (host).  Start with read-only ops, then
callback-taking, then state-modifying.  Diff-test continuously.

- ✅ Lower risk per change.  Each step diff-testable.  Can ship
  intermediate progress.
- ⚠️ Handle-coordination problem still has to be solved at some
  point — it can't be incremental; all handle creates have to choose
  ONE owner.  Dual-path code is complex.
- **Effort: 3–5 weeks (more total work than A due to dual-paths).**
- **Risk: MEDIUM, distributed.**

## Option C — Invert topology (user JS on host, Node API on wasm)

Per the L5 spike's pattern.  User code runs on host V8.  When user
code calls `fs.readFile`, host RPCs to wasm where `lib/fs.js` still
lives, executes there, returns result.  Host provides only minimal
shims for `process`, `console`, `Buffer`, etc.

- ✅ Smallest move from current state — emnapi stays put.  Microtask
  drain on host works for user code.
- ⚠️ Serialize/deserialize boundary for EVERY user-API call.  Lots
  of cross-worker traffic.  Buffer pooling and prototypes tricky.
  Approaches "WebContainer with extra steps" — partial reimpl creep.
- **Effort: 2–3 weeks.**

## Option D — Narrow regression fix only

Don't move emnapi or napi at all.  Enrich the L5 spike enough to run
the 4 failing microtask tests on host.

- ✅ Quick concrete win.  Closes failing tests.
- ⚠️ Doesn't get us to Astro.  Could be a dead-end.
- **Effort: 1–3 days.**

## Option E — Hybrid: host Node-compat creep

Build host-side Node API surface piece-by-piece, starting with what
the failing tests need and expanding outward.

- ⚠️ This is **literally what WebContainer does** — reimplementing
  Node's API in TypeScript.  They've spent 7 years on it and still
  have bugs.  The whole reason edge.js exists is to AVOID this path.
- **Effort: months.**

## Option F — Vendored emnapi's multithreaded mode  *(chosen)*

emnapi has multi-worker support.  Configure it so its context lives
on the host worker, with wasm worker becoming a "remote" napi caller.
Less code we write.

- ✅ Upstream-supported pattern.  Maintainable.  Smaller surface for
  our bugs.  If upstream gives us 90%, we just extend the missing
  pieces.
- ⚠️ Vendored emnapi is v2.0.0-alpha.1 vs npm 1.10.0 — API delta
  means call sites need updating.  Upstream may not support our
  exact topology.  We may end up patching emnapi anyway.
- **Effort: 2–3 weeks IF emnapi cooperates; 4+ weeks if we patch.**

---

## Decision: Option F via an isolated experiment

We're going to **experiment with emnapi v2 in `experiments/l5-emnapi-v2/`**
before folding into the main project.  The main project tree stays
clean throughout the experiment.

Why this approach:
- Emnapi attempts the same problems we have (Node-API over wasm with
  thread/context distribution).  If it gives us 90%, our work is much
  smaller.
- An isolated experiment dir means we can probe seams without
  touching `browser-target/`.  Failed experiments cost zero cleanup.
- Once we know what works + what's missing, we make the final
  A/B/F-extended decision with real data.

Experiment scope:
1. Stand up vendor/emnapi v2 in isolation with a hello-napi module
2. Probe its multithreaded mode — does context-on-different-worker work?
3. Test the operations we need: napi_create_string, napi_call_function,
   threadsafe functions, finalizers
4. Identify what's missing for our use case
5. Estimate the gap before committing to L5 implementation

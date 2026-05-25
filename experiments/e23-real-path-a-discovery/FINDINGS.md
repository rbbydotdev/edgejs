# E23 — Real Path A discovery: findings

Live probe ran end-to-end (vite + Playwright Chromium with JSPI).
`probe.mjs` patches `browser-target/src/worker.ts` in-place with
diagnostic blocks, runs through the existing dev-server harness,
scrapes DOM `#log` lines, then reverts `worker.ts`.  Verified clean:
`git status` shows no diff to `worker.ts` after the run.

Reproduce: `cd experiments/e23-real-path-a-discovery && node probe.mjs`.

## Captured probe output

```
[e23] exports: uv_default_loop=function uv_handle_size=function uv_async_init=function uv_async_send=function itab=yes guestMalloc=function
[e23] uv_handle_size(UV_ASYNC=1)=64
[e23] uv_handle_size(UNKNOWN=0)=-1 uv_handle_size(TIMER=13)=88
[e23] uv_default_loop() BEFORE _start = 13673328
[e23] indirect_function_table length=7017
[e23] itab.get(0) type=object   (null trampoline)
[e23] itab firstFunction-in-200=1
[e23] pre-start: uv_async_init(loop, handle, cb=1) rc=0
[e23] pre-start: uv_async_send(handle) rc=0
[e23] during-start: uv_default_loop()=13673328 matches BEFORE? true
[e23] during-start: uv_async_init rc=0 (handle=56333808)
[e23] during-start: uv_async_send rc=0 -- HOST CALLED WASM EXPORT WHILE _start SUSPENDED, no trap
[e23] sentinel: _start ran 323 ms (exit=0)
```

## Q1 — Loop identity: GREEN

`uv_default_loop()` returns the SAME pointer (`13673328`) before
`_start` and during JSPI-suspended `_start`.  The loop is real and
initialized.

Under `__wasi__`, wasix-libuv picks the posix-poll backend
(`deps/libuv-wasix/include/uv/unix.h:65-71`).  `uv__platform_loop_init`
is a no-op returning 0 (`deps/libuv-wasix/src/unix/posix-poll.c:36-42`).
`uv_loop_init` then runs
`uv_async_init(loop, &loop->wq_async, uv__work_done)`
(`deps/libuv-wasix/src/unix/loop.c:97`), which goes through
`uv__make_pipe` → wasi-shim's SAB-backed `fd_pipe`
(`browser-target/src/wasi-shim.ts:1829`).  `_start`'s `uv_run` polls
via `uv__io_poll` → `poll_oneoff` (also shimmed).  Async wakes posted
to that loop ARE visible on the next `uv_run` iteration after `_start`
resumes from JSPI suspension.

## Q2 — JSPI re-entry safety: GREEN

Host JS called `uv_async_init` + `uv_async_send` from a `setTimeout`
callback that fired while `_start` was JSPI-suspended on
`poll_oneoff`.  Both returned 0 with no trap; `_start` ran to clean
`exit=0`.

`uv_async_send` is pure C11 atomics + a non-blocking 1-byte `write` to
the async pipe wfd (`deps/libuv-wasix/src/unix/async.c:93-115`).  It
does NOT call any Suspending import.  Same shape as the already-
shipping TSFN dispatch at `browser-target/src/worker.ts:521-526`,
which calls `napi_call_threadsafe_function` from host JS during
`_start` suspension and is in production today.

The funcref-table promising-depth wrapper at
`browser-target/src/napi-host/index.ts:670-692` is NOT relevant — it
only intercepts `wasmTable.get(idx)(...)` invocations.  Direct
`instance.exports.uv_async_send(...)` bypasses it entirely.

## Q3 — `uv_async_t` size: GREEN

**`uv_handle_size(UV_ASYNC) = 64 bytes`** (verbatim probe result; live
wasm export).

`UV_ASYNC = 1` confirmed by `node/deps/uv/include/uv.h:200-207` —
`UV_UNKNOWN_HANDLE = 0` then `UV_HANDLE_TYPE_MAP(XX)` whose first entry
is `XX(ASYNC, async)` (line 164).  Sanity check probe: `UV_TIMER=13 →
88 bytes`, `UV_UNKNOWN=0 → -1`.

Layout = `UV_HANDLE_FIELDS + UV_ASYNC_PRIVATE_FIELDS`
(`include/uv.h:949-952` + `include/uv/unix.h:327-330`); opaque from
host POV — just `guestMalloc(64)`, zero-fill, pass pointer to
`uv_async_init`.

## Q4 — Callback funcref: GREEN — pass NULL (cb=0)

**Resolved (post-E23 live probe, `probe-cb.mjs`):**

`uv_async_init(loop, handle, /*cb=*/0)` returns 0 and `_start` runs to
clean `exit=0` after `uv_async_send` is called.  libuv's own dispatch
loop has the documented NULL guard at
`node/deps/uv/src/unix/async.c:205-206`:

```c
if (h->async_cb == NULL)
  continue;
h->async_cb(h);
```

So no funcref is needed at all.  The wake-up is what matters — the
message payload rides on the existing `OP_INVOKE_WASM_CALLBACK`
reverse-RPC funcref dispatch (`browser-target/src/host-worker/
callback-dispatch.ts:320-360`), which the wasm microtask checkpoint
drains after `uv_run` yields.

Probe output (verbatim):

```
[e23-cb] (pre-start) uv_async_init(loop=13673328, handle=22118688, cb=0) rc=0
[e23-cb] (pre-start) uv_async_send(handle) rc=0
[e23-cb] (during-start) cb=0 init rc=0 send rc=0 handle=56331552
[e23-cb] sentinel: _start ran 479 ms (exit=0)
```

Worker.ts revert verified clean.  No funcref table modification
required; no `WebAssembly.Function` shim; no risk of dispatching a
wrong-signature function pointer.

### Alternative considered (`__do_nothing` funcref index 103)

A subagent investigation found `funcref index 103` in the wasm's
elem-section points to `_ZNSt3__212__do_nothingEPv` —
`std::__1::__do_nothing(void*)`, a single-`end`-opcode no-op with
matching `(i32) -> void` signature.  Would also work, but adds a
runtime dependency on a libc++ symbol whose index could shift on
future wasm rebuilds.  **Rejected in favor of NULL** because libuv
documents the NULL-skip path and the safety analysis is trivial.

## Q4 (legacy analysis, kept for reference) — Callback funcref: YELLOW (implementation choice)

**(a) Pre-built Node callback?** No.  `strings browser-target/edgejs.wasm
| grep -i messag` finds only stdlib `messages<>` locale facets.  Node's
`MessagePort::OnMessage` / `node_messaging.cc` are NOT compiled into
the wasm.  So we cannot reuse the upstream MessagePort callback.

**(b/c) Funcref index choice:** `__indirect_function_table` has 7017
entries; `get(0)` is the null trampoline (a non-function object),
`get(1)` and on are real functions.  Probe passed `cb=1` to
`uv_async_init` and it succeeded (rc=0) — `uv_async_init` only STORES
the pointer.  The trap WOULD occur when `uv__io_poll` later dispatches
the cb with the wrong signature, which we did not exercise (handle
never fired during the test).

**Recommended path (sidesteps the trampoline-writing problem):** Use
`uv_async_send` purely as a "kick `_start` out of `poll_oneoff` early"
mechanism.  Pass an existing wasm function with signature
`(uv_async_t*) → void` as `cb` — `uv__work_done` is a natural
candidate.  The actual MessagePort payload is delivered through the
EXISTING reverse-channel funcref dispatch at
`browser-target/src/host-worker/callback-dispatch.ts:320-360` (already
shipping, used by all callback-bound napi ops in F-9 batches 1-3).
The async-send becomes a wake-only signal; the message lands via the
L2 SAB ring + `OP_INVOKE_WASM_CALLBACK`.

Implementation sketch (host side of `parentPort.postMessage`):
```ts
// 1. publish OP_DELIVER_MESSAGE_TO_CHILD on the reverse SAB ring (already exists)
// 2. wasm.exports.uv_async_send(asyncHandle);  // wakes uv_run early
// wasm side: libuv dispatches cb (uv__work_done — no-op effect here), then
// microtask checkpoint drains OP_INVOKE_WASM_CALLBACK which runs user handler
```

## Go/no-go: GREEN — proceed to implementation

All four exports are live and callable from host JS during JSPI
suspension.  Sizes are fixed (64B per uv_async_t).  The callback-
trampoline problem has a clean shortcut via the existing reverse-RPC
machinery.  Hybrid TSFN dispatch already proves direct wasm-export
calls during `_start` suspension are safe.

## Open implementation questions (not blockers)

1. **Pick the cb funcref index.**  Scan exports for `uv__work_done` and
   use that funcref index; if not exported, grow
   `__indirect_function_table` by 1 and install a JS-defined
   `WebAssembly.Function` of signature `(i32) → ()`.
2. **`uv_close(handle, cb)` for teardown** — confirm it behaves like
   `uv_async_send` (almost certainly yes; same property: synchronous
   wasm export, no JSPI suspension).
3. **JS keepalive stays for now.**  The `setInterval` keepalive in
   `policies/worker-threads-per-thread.ts` continues to hold the
   WORKER thread alive.  The wasm-side uv loop already gets a pending
   handle from our async (`uv_ref`'d) — that satisfies `uv_loop_alive`
   — but the worker's JS event loop needs a separate wake-up signal
   until worker shutdown is routed through the wasm exit path.  Drop
   the JS keepalive in a follow-up batch.

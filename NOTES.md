# Edge.js NOTES

Running log of deviations, questions, and things to consider while building
out the browser target. Newest entries first.

---

## 2026-05-21 — Capability probe + chunk H (timers) free-win

Switched worker args temporarily to small probes after chunk C landed:

- **Timers — work for free.**  `setTimeout(cb, 100)` and `setTimeout(cb, 250)`
  fire correctly in order, `process.exit(0)` returns cleanly.
  ```
  [stdout] before
  [stdout] after 100ms
  [stdout] after 250ms
  _start ran 386 ms (returned)
  ```
  Chunk H is done with zero work — `poll_oneoff` (built for sockets in
  chunk C) with `Atomics.wait` timeout handling is exactly what libuv's
  timer scheduler needs.  No separate timer implementation required.

- **`fs.writeFileSync` fails** with `ENOENT: no such file or directory,
  open '/tmp/test.txt'` — as expected.  The `bundled` adapter is
  read-only and `/tmp` isn't a served prefix.  Unblocks: chunk B (OPFS).

- **`require('crypto')` fails** at module load.  Stack:
  ```
  TypeError: Cannot read properties of undefined (reading 'value')
    at emnapiDefineProperty (.../@emnapi_core.js:4906:50)
    at napi_define_class (.../@emnapi_core.js:5148:11)
    at createNativeKeyObjectClass (eval at emnapiCreateFunction ...)
    at node:internal/crypto/keys:107:5
  ```
  Bug is inside emnapi's `napi_define_class` — reads `.value` on an
  undefined property descriptor.  Property descriptor format mismatch
  between what edge passes and what emnapi expects.  Not in our shim;
  needs either an emnapi adapter or a `napi_define_class` override.
  Tracked as new follow-up.

Worker args restored to the chunk-C HTTP demo (`http.createServer`
running, ready for fetch).

---

## 2026-05-20 — MILESTONE: edge.js serves HTTP in browser (chunk C)

```js
// Worker runs:
require('http').createServer((req,res) => res.end('hi from edge\n')).listen(3000, () => console.log('listening'));

// Page does:
await fetch('/_edge/test').then(r => r.text());
// → "hi from edge\n"  (status 200)
```

Full HTTP roundtrip end-to-end through the browser.  Real Node
`http.createServer` callback fires for each request, real response is
shipped back to the `fetch()` caller on the page.

### Architecture

```
page fetch('/_edge/*')
  → Service Worker intercepts
  → posts {edge-req} to page (SAB doesn't cross postMessage→SW on Chrome 148)
  → page writes JSON into bridgeSab, Atomics.notify(wakeSab, 0)
  → worker's blocked Atomics.wait wakes
  → drainBridgeSab() pulls request out of SAB
  → bus.pushRequest() queues it on listening socket
  → sock_accept_v2 dequeues, allocates conn fd, stages raw HTTP/1.1 bytes
  → edge calls fd_fdstat_get (we classify as SOCKET_STREAM = 6)
  → edge calls fd_read, copies the HTTP request into wasm memory
  → edge's lib/http parses, dispatches to user handler
  → user handler: res.end('hi from edge\n')
  → edge calls fd_write with full HTTP response (~108 bytes)
  → shim auto-detects complete response (parses Content-Length), closes
  → closeConnection parses sendBuf, fires responder
  → worker postMessages {page-edge-res} to page
  → page sw.postMessage()s to SW
  → SW resolves the original fetch event with the Response
```

### Bug chain hit during bring-up (all fixed)

1. **`fd_fdstat_get` returned CHARACTER_DEVICE for socket fds.**  Edge's
   libuv treated the fd as a tty and skipped recv entirely.  Fixed: return
   `6` (SOCKET_STREAM) when `sockets.has(fd)`.

2. **Edge writes the response but never calls `fd_close` or `sock_shutdown`.**
   HTTP/1.1 server expects the client to close after `Connection: close`.
   Our virtual loopback has no real client.  Fixed: added `sock_shutdown`
   impl (was falling through to ENOSYS stub), and added an
   `isHttpResponseComplete()` heuristic that auto-closes the connection
   in `writeBytesToFd` as soon as the sendBuf holds a full HTTP/1.1
   response (Content-Length detected).

3. **SAB doesn't cross MessagePort.postMessage into a Service Worker on
   Chrome 148.**  Plain objects on the same port arrive fine, anything
   containing a SAB silently drops with no error event.  Routing through
   the page (SW → Clients.postMessage → page → SAB write + Atomics.notify)
   is the only working path.

### #!~debt added

- `single-listener` — one listening socket at a time
- `no-keep-alive` — request synthesizer adds `Connection: close`
- `no-chunked-encoding` — auto-flush requires Content-Length in response
- `no-outbound` — `sock_connect` returns ENOSYS
- `no-socketpair` — `sock_pair` returns ENOSYS
- `no-sendfile` — `sock_send_file` returns ENOSYS
- `sw-sab-incompat` — workaround for Chrome's SW/SAB issue
- `single-flight` — one inflight request at a time in `sw.js`

---

## 2026-05-20 — `unofficial_napi_*` phantom-arg audit (FIXED)

Systematic audit of all 80 `unofficial_napi_*` impls in
[browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts)
against the ground-truth wasm signatures in
[napi/src/guest/napi.rs](napi/src/guest/napi.rs).

The wasm-visible signature for each `guest_unofficial_napi_xxx` is the Rust
function signature **minus** the `FunctionEnvMut<NapiEnv>` first parameter
(that's a wasmer host construct, not a wasm arg).

### Results

| Function | Wasm args | Our args (before) | Status (before) | Action |
|---|---|---|---|---|
| `set_flags_from_string` | 2 | 2 | OK | none |
| `create_env` | 3 | 3 | OK | none |
| `create_env_with_options` | 4 | 4 | OK | none |
| `release_env` | 1 | 1 | OK | none |
| `release_env_with_loop` | 2 | 2 | OK | none |
| `low_memory_notification` | 1 | 1 | OK | none |
| `process_microtasks` | 1 | 2 | phantom env | FIXED |
| `request_gc_for_testing` | 1 | 2 | phantom env | FIXED |
| `set_prepare_stack_trace_callback` | 2 | 2 | OK | none |
| `get_promise_details` | 5 | 5 | OK (just fixed) | u8 fix for has_result_ptr |
| `get_proxy_details` | 4 | 5 | phantom env + bogus is_proxy_out | FIXED |
| `preview_entries` | 4 | 5 | phantom env + arg-order swap | FIXED |
| `get_call_sites` | 3 | 4 | phantom env | FIXED |
| `get_caller_location` | 2 | 3 | phantom env | FIXED |
| `arraybuffer_view_has_buffer` | 3 | 4 | phantom env + u8 width | FIXED |
| `get_constructor_name` | 3 | 4 | phantom env | FIXED |
| `create_private_symbol` | 4 | 4 | OK | none |
| `get_continuation_preserved_embedder_data` | 2 | 3 | phantom env | FIXED |
| `set_continuation_preserved_embedder_data` | 2 | 3 | phantom env | FIXED |
| `notify_datetime_configuration_change` | 1 | 2 | phantom env | FIXED |
| `set_enqueue_foreground_task_callback` | 3 | 3 | OK | none |
| `set_fatal_error_callbacks` | 3 | 3 | OK | none |
| `terminate_execution` | 1 | 2 | phantom env | FIXED |
| `cancel_terminate_execution` | 1 | 2 | phantom env | FIXED |
| `request_interrupt` | 3 | 4 | phantom env | FIXED |
| `structured_clone` | 3 | 5 | wrong sig (was wired to 4-arg with-transfer body) | FIXED |
| `structured_clone_with_transfer` | 4 | 5 | phantom env | FIXED |
| `serialize_value` | 3 | 4 | phantom env | FIXED |
| `deserialize_value` | 3 | 4 | phantom env | FIXED |
| `release_serialized_value` | 1 (void) | 2 (returned 0) | phantom env + non-void return | FIXED |
| `set_promise_hooks` | 5 | 5 | OK | none |
| `get_own_non_index_properties` | 4 | 5 | phantom env | FIXED |
| `get_process_memory_info` | 5 | 7 | phantom env + bogus rss arg + u64 instead of f64 | FIXED |
| `get_hash_seed` | 2 | 3 | phantom env | FIXED |
| `get_error_source_positions` | 3 (one struct ptr) | 6 (four scalar ptrs) | phantom env + wrong struct layout | FIXED |
| `preserve_error_source_message` | 2 | 3 | phantom env | FIXED |
| `mark_promise_as_handled` | 2 | 3 | phantom env | FIXED |
| `get_heap_statistics` | 2 | 3 | phantom env + 13 vs 14 fields | FIXED |
| `get_heap_space_count` | 2 | 3 | phantom env | FIXED |
| `get_heap_space_statistics` | 3 | 4 | phantom env + wrong struct size (was 32, is 80) | FIXED |
| `get_heap_code_statistics` | 2 | 3 | phantom env | FIXED |
| `set_stack_limit` | 2 | 3 | phantom env | FIXED |
| `set_near_heap_limit_callback` | 3 | 4 | phantom env | FIXED |
| `remove_near_heap_limit_callback` | 2 | 3 | phantom env | FIXED |
| `free_buffer` | 1 (void) | 2 (returned 0) | phantom env + non-void return | FIXED |
| `start_cpu_profile` | 3 | 4 | phantom env + wrong args (was title/options) | FIXED |
| `stop_cpu_profile` | 5 | 4 | phantom env + missing args | FIXED |
| `start_heap_profile` | 2 | 3 | phantom env + bogus options arg | FIXED |
| `stop_heap_profile` | 4 | 3 | phantom env + missing args | FIXED |
| `take_heap_snapshot` | 4 | 3 | phantom env + missing args | FIXED |
| `create_serdes_binding` | 2 | 3 | phantom env | FIXED |
| `contextify_make_context` | 9 | 7 | phantom env + missing args | FIXED |
| `contextify_dispose_context` | 2 | (missing) | impl was absent, fallback worked | ADDED |
| `contextify_run_script` | 12 | 12 | OK (just fixed) | none |
| `contextify_compile_function` | 12 | 12 | OK | none |
| `contextify_compile_function_for_cjs_loader` | 6 | 6 | OK | none |
| `contextify_contains_module_syntax` | 6 | 7 | phantom env + missing cjs_var_in_scope | FIXED |
| `contextify_create_cached_data` | 7 | 7 | phantom env + missing host_defined_option_id | FIXED |
| `module_wrap_create_source_text` | 9 | 10 | phantom env + missing context_or_undefined + extra host_defined_option_id | FIXED |
| `module_wrap_create_synthetic` | 7 | 7 | phantom env + missing context_or_undefined | FIXED |
| `module_wrap_create_required_module_facade` | 3 | 4 | phantom env | FIXED |
| `module_wrap_create_cached_data` | 3 | 4 | phantom env | FIXED |
| `module_wrap_destroy` | 2 | 3 | phantom env | FIXED |
| `module_wrap_get_module_requests` | 3 | 4 | phantom env | FIXED |
| `module_wrap_link` | 4 | 5 | phantom env | FIXED |
| `module_wrap_instantiate` | 2 | 3 | phantom env | FIXED |
| `module_wrap_evaluate` | 5 | 4 | phantom env + missing timeout (i64) + break_on_sigint | FIXED |
| `module_wrap_evaluate_sync` | 5 | 4 | phantom env + missing filename + parent_filename | FIXED |
| `module_wrap_get_namespace` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_status` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_error` | 3 | 4 | phantom env | FIXED |
| `module_wrap_has_top_level_await` | 3 | 4 | phantom env + u8 width | FIXED |
| `module_wrap_has_async_graph` | 3 | 4 | phantom env + u8 width | FIXED |
| `module_wrap_check_unsettled_top_level_await` | 4 | 4 | OK (default-value just fixed) | added missing `warnings` arg + u8 width |
| `module_wrap_set_export` | 4 | 5 | phantom env | FIXED |
| `module_wrap_set_module_source_object` | 3 | 4 | phantom env | FIXED |
| `module_wrap_get_module_source_object` | 3 | 4 | phantom env | FIXED |
| `module_wrap_set_import_module_dynamically_callback` | 2 | 3 | phantom env | FIXED |
| `module_wrap_set_initialize_import_meta_object_callback` | 2 | 3 | phantom env | FIXED |
| `module_wrap_import_module_dynamically` (stub) | 4 | 6 | phantom env + extra args; should return 1 | FIXED + return 1 |
| `get_current_stack_trace` (stub) | 3 | 4 | phantom env; should return 1 | FIXED + return 1 |

### Summary

- Total impls audited: 79 (matching the registered wasm imports in
  `napi/src/guest/napi.rs:5051-5145`).
- Fully aligned before audit: 13.
- Misaligned (phantom env or other arity drift): 65.
- Missing impl, falling through to the namespace fallback (which returned 0):
  1 (`contextify_dispose_context`; added).
- Type-width fixes folded in: 9 instances of "boolean" out-pointers were
  writing 4 bytes via `setInt32` where Rust uses `write_guest_u8` (1 byte) —
  fixed to `setUint8`.  These are: `get_promise_details.has_result_ptr`,
  `arraybuffer_view_has_buffer.result_ptr`, `preview_entries.is_key_value_ptr`,
  `module_wrap_has_top_level_await.result_ptr`,
  `module_wrap_has_async_graph.result_ptr`,
  `module_wrap_check_unsettled_top_level_await.settled_ptr`,
  `contextify_contains_module_syntax.result_ptr`,
  `stop_cpu_profile.found_ptr`, `start_heap_profile.started_ptr`,
  `stop_heap_profile.found_ptr`.
- `get_process_memory_info` was writing zero-filled u64s into what wasm reads
  as f64 — same bit-pattern as +0.0, so no observable difference, but the
  declared type was wrong.  Fixed to `setFloat64`.
- `get_heap_statistics` struct in Rust has 14 fields, not 13 (impl had one
  field short, which would leave the last field uninitialized in caller
  memory).  Fixed.

### Verification

- `cd browser-target && npx tsc --noEmit` is clean (no errors).
- Browser run `edge -e "console.log('hello from edgejs in browser')"`
  passes: stdout shows the message, `_start ran ... (returned)` with no
  exit/error.  See verification log near the milestone entry below.

### Not addressed

- The five impls completely missing from `unofficial.ts` (and thus relying on
  the per-namespace fallback returning 0) are NOT added by this audit, since
  they're not wrong, just minimal: `set_embedder_hooks`, `enqueue_microtask`,
  `set_promise_reject_callback`, `set_source_maps_enabled`,
  `set_get_source_map_error_source_callback`, `get_error_source_line_for_stderr`,
  `get_error_thrown_at`, `take_preserved_error_formatting`.  Promote when a
  workload needs them.

---

## 2026-05-20 — MILESTONE: edge.js runs user JS in browser

```
[stdout] hello from edgejs in browser
_start ran 164 ms (returned)
```

`edge -e "console.log('hello from edgejs in browser')"` executed cleanly
in the browser harness.  Real Node.js code running inside the wasm,
writing to stdout via fd_write, returning normally (no error exit).

What got us here in this session:

1. **#14 uv_cwd EIO** — root-caused to edge mutating `globalThis.TextEncoder`
   mid-bootstrap; fixed by caching the native instance at module load.
   See entry below.
2. **`compile_function_for_cjs_loader` wrong signature** — was 13 args,
   native is 6.  Fixed to match `napi/src/guest/napi.rs:5182` and
   synthesize the CJS params array internally.
3. **`this`-binding bug in 3 delegation sites** — `wrapImpl` in
   `imports-generated.ts` drops `this`.  Refactored to `impls.X`
   closure pattern.
4. **Exit code 13 = kUnsettledTopLevelAwait** (NOT kGenericUserError as
   originally diagnosed).  Three impl bugs caused it:
   - `get_promise_details` had a phantom `_napiEnv` arg that shifted the
     state_ptr write to the wrong address; edge's IsPromisePending then
     read its stack-default 0 (pending), cascading into the TLA gate.
   - `module_wrap_check_unsettled_top_level_await` defaulted to 0
     (unsettled).  Flipped to 1 (settled) since our module_wrap impls
     are stubs that don't host real TLA semantics.
   - `contextify_run_script` had a phantom `_ctx` arg that shifted
     `sourceHandle` to read the *filename* ("[eval]") instead of the
     user code.  `new Function("return ([eval]);")` returned a JS array
     instead of executing console.log.

### #!~debt: systemic phantom `_napiEnv` in unofficial_napi_* impls

A pattern audit found that **several `unofficial_napi_*` impls have an
extra `_napiEnv` parameter that doesn't exist in the wasm signature.**
The wasmer host's `FunctionEnvMut<NapiEnv>` is implicit on the Rust side,
so wasm calls have exactly one env handle, not two.

Confirmed misaligned (only `get_promise_details`, `contextify_run_script`,
and `check_unsettled_top_level_await` correctly-aligned-but-wrong-default
were fixed above):

- `unofficial_napi_get_proxy_details` — wasm 4 args, our 5
- `unofficial_napi_contextify_make_context` — wasm 9 args, our 7
- `unofficial_napi_contextify_contains_module_syntax` — wasm 6 args, our 7
- likely more across the 80-function surface

These are silent landmines.  They don't trigger today because they're
not called yet, but they will misbehave once edge runs real workloads.
**Follow-up: systematic audit pass — diff every unofficial_napi_* impl
arity in `unofficial.ts` against the guest sig in
`napi/src/guest/napi.rs`.**  Tracked as a new task.

### Lesson saved to memory

Pattern saved at `~/.claude/projects/-Users-robertpolana-etc-projects-edgejs/memory/project-globalthis-mutation.md`
covering the globalThis mutation issue.  Also worth keeping: the systemic
phantom-arg pattern documented here.

---

## 2026-05-20 — #14 uv_cwd EIO: FIXED

The TextEncoder root cause from attempt #6 (entry below) was fixed by
caching the native `TextEncoder` at module load in
[browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts) and
[browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts),
and by precomputing `FIXED_CWD_BYTES` for `getcwd`.

All `new TextEncoder()` / `new TextDecoder()` constructions inside hot
paths were replaced with the module-level cached instances.  The
instrumentation block in `getcwd` was removed.

### Verification

Browser run after the fix:

```
✓ end-to-end success (exit=0)   ← hello.wasm smoke test
…
[no EIO line — uv_cwd no longer fails]
_start ran 262 ms (exit=1)
```

`_start` now runs for ~800ms (was ~120ms) and dies at a NEW error
downstream:

```
TypeError: Cannot read properties of undefined
  (reading 'unofficial_napi_contextify_compile_function')
at unofficial_napi_contextify_compile_function_for_cjs_loader (unofficial.ts:439:19)
```

This is a `this`-binding bug in our delegation pattern — the wrapImpl
wrapper in `imports-generated.ts` calls `fn(...args)` with no `this`,
so `(this as Record<string, Function>).unofficial_napi_*` is undefined.
Easy fix; tracked as a new task.

### Lesson applied to memory

Anything that's resolved through `globalThis.*` at call time is a
potential bug.  Edge's bootstrap WILL replace constructors and
prototypes mid-run.  Always capture at module load.  The
already-fixed list: `performance.now`, `performance.timeOrigin`,
`TextEncoder`, `TextDecoder`.  Future audit candidates flagged in
attempt #6 entry: `Uint8Array`, `DataView`, `Atomics`, `Math.random`,
`JSON.*`.

---

## 2026-05-20 — uv_cwd EIO: attempt #6 — ROOT CAUSE FOUND (TextEncoder mutation)

**Verdict: the bug is JS-side, not wasm-side.**  Edge.js's bootstrap mutates
`globalThis.TextEncoder` partway through boot, replacing it with a non-native
implementation whose `encode("/")` returns `Uint8Array([0])` instead of
`Uint8Array([0x2f])`.  The WASIX `getcwd` shim
([browser-target/src/wasi-shim.ts:540](browser-target/src/wasi-shim.ts))
re-encodes the cwd per call via `new TextEncoder().encode(FIXED_CWD)`,
so calls after the mutation copy a NUL byte into the guest buffer.
The C++ `TryGetCurrentWorkingDirectoryString` reads `strlen("\0") = 0`
(or sees the resized `std::string` as effectively empty after the
embedded NUL), and synthesizes UV_EIO at func[6035] block J / offset
`0x11fb60`.

### Evidence — instrumented `getcwd` (still in tree as `#!~debt`)

Per-call log captured 21 invocations during boot.  The differentiator is
the first byte of `new TextEncoder().encode("/")`:

| idx | isNative | encBytes | memByteLength |  notes                  |
|-----|----------|----------|---------------|-------------------------|
| 1   | true     | [47]     | 22151168      | edge global mutation not yet applied |
| ... | true     | [47]     | ...           | works                   |
| 18  | true     | [47]     | 22675456      | last successful call    |
| 19  | **false**| **[0]**  | 22872064      | edge mutated TextEncoder; "/" encodes to [0] |
| 20  | false    | [0]      | 22872064      | broken                  |
| 21  | false    | [0]      | 22872064      | **trigger call** — EIO fires |

The mutation happens between calls 18 and 19, coincident with a
`memory.grow` (22675456 → 22872064) — same window the prior attempts
fixated on, but the memory-grow was a coincidence, not the cause.

Additional invariants confirmed during the probe (sanity checks for
discarded candidates):

- `dv.setUint32(bufSizePtr, enc.length, true)` lands correctly all 21
  calls.  `sizeReadBack`, `sizeFreshDv`, `sizeFreshU8` all return 1.
  Candidate 1 (wrong bufSizePtr address) is **ruled out**.
- `mem.set(enc, bufPtr)` writes whatever bytes `enc` contains.  When
  `enc[0] === 47`, `mem[bufPtr] === 47` post-set, verified through
  the same view, a fresh `Uint8Array(memory.buffer)`, and a fresh
  `DataView.getUint8`.  When `enc[0] === 0`, all three readbacks
  return 0.  So `mem.set` is fine — it's the source bytes that are wrong.
- The 21 native getcwd calls have `max_path_len ∈ {256, 4096}` in
  exactly the same distribution we see (3×256, 18×4096), and call
  count matches.  Layout matches; behavior diverges only at the JS
  bridge.

### Why prior attempts missed it

Same root cause as the [Edge mutates `globalThis` mid-run](#2026-05-20--edge-mutates-globalthis-mid-run)
entry already knew about (where `performance.now` got clobbered — fixed by
caching at module load in [worker.ts](browser-target/src/worker.ts) and
[trace.ts](browser-target/src/trace.ts)).  The fix was applied to
`performance` and `performance.now` but **not** to `TextEncoder`/`TextDecoder`,
so the encoder kept being re-resolved through `globalThis.TextEncoder`
per call.  The mem-snapshot / SAB-aliasing / view-staleness rabbit holes
were chasing the symptom (post-mutation writes look "wrong" relative to
expected cwd bytes) rather than the cause (encoder swapped).

### Proposed fix (NOT applied — review first per brief)

1. In [browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts),
   precompute the bytes for `FIXED_CWD` once at module load (or at
   `createWasiShim` entry, before the wasm runs).  Replace
   `const enc = new TextEncoder().encode(FIXED_CWD);` inside `getcwd`
   with a captured `Uint8Array` constant.  Example:

   ```ts
   // Capture before wasm bootstrap mutates globalThis.TextEncoder.
   const FIXED_CWD = "/";
   const FIXED_CWD_BYTES = new TextEncoder().encode(FIXED_CWD);
   ```

2. Audit all other `new TextEncoder()` / `new TextDecoder()` sites
   (grepped: `wasi-shim.ts:273, 282, 430, 442, 455, 468`,
   `napi-host/unofficial.ts:109, 112, 480, 497`).  Each one needs
   either:
   - Module-level capture of the constructor:
     `const NativeTextEncoder = globalThis.TextEncoder;`
     and use `new NativeTextEncoder()` everywhere.
   - Or one cached instance: `const encoder = new TextEncoder()`
     (which we already do for the decoder at `wasi-shim.ts:80`).

   The latter is the simpler pattern; matches what `wasi-shim.ts` already
   does for `decoder`.  Extend `captured` at line 84 to include
   `TextEncoder` and `TextDecoder` constructors — for any path that
   needs a fresh instance — plus a module-level `encoder` like the
   existing `decoder`.

3. Once fix is in, the existing `#!~debt instrumentation` block at the
   top of `getcwd` will show `isNative: true` and `encBytes: [47]` for
   ALL 21 calls, and the EIO will not fire.  Remove the instrumentation
   block then.

### What's still uncertain (low probability)

- Are there OTHER shims that use stale globals?  Likely yes:
  `Uint8Array`, `DataView`, `Atomics`, `Math.random` — edge may shadow
  any of these.  Worth a sweep, but doesn't block #14.  Add to follow-up.
- The exact native vs polyfill toString of the post-mutation
  `TextEncoder` isn't captured (`isNative: false` is all we have).
  Could be edge installing a primordials-frozen polyfill, could be
  a Node.js `util.TextEncoder` analog.  Not load-bearing for the fix.

### #!~debt added (one block, still in place)

- `browser-target/src/wasi-shim.ts:540`-ish, the `[diag-getcwd encoder]`
  postLog and the `getcwdCallIdx` counter at line ~125.  Both keep the
  bug visible for re-runs.  Remove once the fix lands and is validated.

### Path forward

1. Apply the cached-TextEncoder fix (see above).
2. Rerun browser; confirm 21 getcwd calls all log `isNative: true`,
   no EIO thrown.
3. Sweep remaining `globalThis`-resolved APIs for similar exposure
   (deferred unless symptoms surface).
4. Mark #14 complete, remove the `#!~debt instrumentation` block.

---

## 2026-05-20 — #!~debt uv_cwd EIO: attempt #5 (diagnose only — Hypotheses A/B tested)

Diagnostic-only attempt — no fixes shipped, no changes to wasi-shim.ts or
mem-snapshot.ts.  Two diagnostics were added under
[browser-target/src/diagnostics/](browser-target/src/diagnostics/):

- `sab-view-aliasing.ts` — pure-JS isolated repro for the Hypothesis A
  scenario (Chrome SAB view caching aliases stale views).  Constructs
  a `WebAssembly.Memory({shared:true})` with the same 337 initial pages
  edge uses, writes a marker through one `new Uint8Array(memory.buffer)`,
  reads back through six independent view constructions
  (`Uint8Array#1/2`, `DataView.getUint8`, `Uint8Array(buf,off,1)`,
  `Atomics.load(Int8Array)`, `subarray`).  Includes a `memory.grow(5)`
  scenario that exercises post-grow buffer-identity changes.
  Page URL: `http://127.0.0.1:5180/?diag=sab-aliasing`.
- `byteLength-watcher.ts` — wraps host import namespaces and logs every
  `memory.buffer.byteLength` and SAB-identity change observed across
  the bootstrap.  Used to test Hypothesis B (memory grows during boot,
  some cached buffer reference goes stale).
  Page URL: `http://127.0.0.1:5180/?diag=bytelen`.

Both are wired through `?diag=...` URL params + a worker-side gate
(`runDiagnosticsFirst`, `watchByteLength` in
[browser-target/src/worker.ts](browser-target/src/worker.ts)).

### Hypothesis A — Chrome SAB view aliasing

NOT supported.  Pure-JS repro across 35 probes spanning pages 330-341,
including post-grow scenarios with explicit buffer-identity change, shows
**zero misses** across six independent read paths.  Writes through one
`new Uint8Array(memory.buffer)` are immediately visible through any other
freshly-constructed view, a `DataView`, an `Atomics.load` on `Int8Array`,
and a `subarray` of a parent.

Output captured at the address range of the real failure
(`__heap_base = 22060144`, page 336+) — same allocation size, same
memory model, same access pattern as `wasi-shim.ts:getcwd`
(`mem.fill(0, bufPtr, bufPtr + maxLen)` then `mem.set(enc, bufPtr)`).
All reads see all writes.

This DOES disprove the "Chrome 148 caches the ArrayBuffer wrapper per
view-construction" speculation from attempt #4's notes.  Cross it off.

### Hypothesis B — Stale buffer reference (memory.grow + cached SAB)

Observed but NOT proven causal.  The wasm DOES call `memory.grow`
multiple times during bootstrap; 4 byteLength-change events fired
across ~175 instrumented calls, with final size 22872064 (= +12
pages from initial 22085632).  One of the change events coincides
with a `wasix_32v1.getcwd` call (#168 in the call sequence, len at
that moment = 22675456).

But: code audit shows zero JS-side caches of `memory.buffer`.  Every
read goes through `new Uint8Array(memory.buffer)` / `new DataView(
memory.buffer)` constructed at the call site.  Files checked:

- `wasi-shim.ts` — `view()` and `bytes()` reconstruct per call.
- `mem-snapshot.ts:32` — `snapshot()` reconstructs per call.
- `napi-host/unofficial.ts:22,101,259,275,283,287` — reconstructs per call.
- `napi-host/instance-proxy.ts` — no memory access.
- `@emnapi/core/dist/emnapi-core.esm-bundler.js` — every HEAP access
  reconstructs from `wasmMemory.buffer`.  Verified across ~40 sites.
- `worker.ts:79` — only reads `memory.buffer.byteLength` once at startup.

Crucially: scenario 2 of the SAB-aliasing test also probed whether a
pre-grow Uint8Array view sees post-grow writes at low addresses.  It
does.  Per spec, SAB-grow extends the same underlying memory; stale
view objects still read/write the same bytes.  So even if some code
held a stale reference, writes would still be visible.

### What attempt #4 actually observed

Attempt #4 reported that `mem-snapshot`'s `after` capture on the LAST
getcwd shows zeros (no `0x2f`), while the shim's in-shim readback
showed `0x2f` at the same address through 3 read paths.

Given Hypothesis A is disproven and Hypothesis B can't account for the
discrepancy under our access patterns, the most likely explanation is
that **the attempt #4 observation was a measurement artifact** of
`mem-snapshot.ts`.  Candidates:

1. The snapshot's `arg0` interpretation (treating any arg ≥
   `ptrThreshold=65536` as a pointer) might have snapshotted the WRONG
   address for the failing call.  The wasix getcwd ABI is
   `(bufPtr, bufSizePtr)` — both args ARE pointers.  `before/after.arg0`
   centers on `bufPtr`, which should be correct.
2. The snapshot's range-truncation (`if (ptr < range) ptr = range`)
   doesn't apply at high addresses.
3. The `[before, after]` text was inspected manually — possibly the
   wrong call's record was read.  21 getcwd calls means 21 snapshots,
   each ≈128 hex chars; easy to misalign in a busy trace.

Without rerunning attempt #4's exact comparison side-by-side with the
in-shim readback, we can't fully rule the artifact theory in or out.
But the pure-JS isolation strongly suggests the wasm's view of memory
is consistent with our writes.

### Conclusion

The EIO source is NOT a memory write-visibility issue.  The shim's
writes land, are visible to wasm, and survive across `memory.grow`.
This shifts probability mass to:

- Hypothesis C (untested this attempt): the wasm reads through a
  different mechanism we don't see — e.g., a struct member set by
  `uv_cwd` that we're not writing.  The exact failure site is known:
  func[6035] block J at offset `0x11fb60`-`0x11fb7d`, which sets
  `*err_out = -29` when `std::string::empty()` is true after the
  resize to `*size_ptr`.  This implies `*size_ptr` was being read as 0
  during the resize, OR the `std::string` got corrupted between
  resize and empty check, OR the shim's `bufSizePtr` write
  (`dv.setUint32(bufSizePtr, enc.length, true)`) isn't landing
  where uv_cwd expects.
- Hypothesis D (untested): something else zeros the buffer after the
  syscall.

**Recommended next attempt**: test Hypothesis C concretely.  Three
parallel paths:

1. **Read uv_cwd's caller frame layout via `wasm-tools print`.**  Find
   what offset `*size_ptr` is at relative to `uv_cwd`'s stack frame.
   Verify our `bufSizePtr` matches that offset (the wasm passes us
   the address — if its caller is reading a DIFFERENT address as
   `size`, the write goes to dead space).
2. **Instrument the bufSizePtr write specifically.**  Right after
   `dv.setUint32(bufSizePtr, enc.length, true)`, read it back via
   the same dv to confirm `enc.length` lands.  Cross-check with a
   fresh DataView too.  We already do similar in-shim readback for
   the cwd bytes; mirror it for the length out-param.
3. **Pre-zero `bufSizePtr+4` through `bufSizePtr+8`** to cover off-by-one
   misalignment by the caller (in case it reads `*(u32*)(bufSizePtr+4)`
   for the length instead of `*(u32*)bufSizePtr`).

If all three rule out (1)-(3), attempt #6 should pivot to the band-aid
paths catalogued in attempt #4: wasm-tools mutate to short-circuit the
EIO synthesis in func[6035] block J, or hijack `napi_create_error` to
no-op the throw.

### #!~debt added

- `sab-view-aliasing-diagnostic` (browser-target/src/diagnostics/sab-view-aliasing.ts)
  — diagnostic-only file; gated behind `?diag=sab-aliasing`.  Adds zero
  runtime cost when the URL param isn't set, but the file is dead code
  on the normal path.  Delete once #14 is unblocked AND we're confident
  Hypothesis A won't resurface for a similar memory-related bug.
- `bytelen-watcher-diagnostic` (browser-target/src/diagnostics/byteLength-watcher.ts)
  — diagnostic-only file; gated behind `?diag=bytelen`.  Same lifecycle.

---

## 2026-05-20 — FileSystem facade + bundled adapter (chunk 1 of browser fs)

Stood up a project-owned FileSystem interface and a `bundled` adapter that
serves real bytes for `/node-lib/**` and `/node/deps/**` from the page
origin via sync XHR.  Replaces the previous "every path → ENOENT" path in
the shim.

New files:

- [browser-target/src/host/fs/types.ts](browser-target/src/host/fs/types.ts)
  — `FileSystem` interface, `FsResult<T>` discriminated union, `FsErrno`
  (WASI-compatible values), `FileType`, `FileStat`, `DirEntry`,
  `OpenOptions`.  Sync, path-first, handle-based, read-only by default.
- [browser-target/src/host/fs/adapters/bundled.ts](browser-target/src/host/fs/adapters/bundled.ts)
  — adapter that fetches `/node-lib/**` and `/node/deps/**` via
  synchronous XMLHttpRequest from the worker.  Body + stat caches keyed
  by absolute path.  Only file in the codebase that knows about HTTP /
  bundled-content URLs.

Wiring in [browser-target/src/wasi-shim.ts](browser-target/src/wasi-shim.ts):

- `path_open`, `path_open2` route through `ctx.fs.open()` for any path
  other than `/dev/{urandom,random}`.
- `fd_read` checks `vfd.fsHandle` and routes through `ctx.fs.read()`.
- `fd_close` releases the FS handle.
- `fd_filestat_get` uses `ctx.fs.fstat()` for FS-backed fds.
- `path_filestat_get` tries `ctx.fs.stat()` first, falls back to the old
  heuristic (still `#!~debt fake-fs-fallback`).
- Helpers `readPath`, `isVirtualUrandom`, `openVirtualUrandom`,
  `openViaFs`, `writeFileStat` deduplicated.

Cleanup:

- `chdir` is now a no-op returning SUCCESS.  Previously referenced the
  removed `currentCwd` variable.  Wasi-libc owns `__wasilibc_cwd`; this
  syscall doesn't update it.

`browser-target/public/node/deps` is a symlink to the repo `deps/` tree
so Vite serves the full deps lazily (no bundling cost — Vite only reads
files actually requested).

### Verification

Reloaded `http://127.0.0.1:5180/`.  Result:

```
[wasi] path_open2 /node/deps/undici/src/package.json → fd 107 (fs)
[bundled-fs] HEAD /node/deps/undici/src/package.json → 200 (6044B)
[bundled-fs] GET  /node/deps/undici/src/package.json → 200 (6044B)
```

Success criterion hit: one path_open2 for a `/node/deps/...` path now
returns SUCCESS instead of errno=44 NOENT.

EIO from `uv_cwd` still surfaces — anticipated.  This chunk was about
opening the path; the EIO is in a different code path (libc cwd cache).

### Discoveries / things to triage

- Edge does NOT request `/node-lib/**` paths during the current
  bootstrap.  The compiled-in builtin catalog handles those.  The brief's
  hypothesis ("bootstrap can't load its own scripts") is wrong; bootstrap
  is loading them through the napi/V8 bridge, not WASI.
- ENOENT paths still hit: `/usr/local/ssl/openssl.cnf`,
  `/test/node_trace.1.log`, `/test/fixtures/tz-version.txt`,
  `/node/config.gypi`.  All match native behavior — edge probes,
  ENOENTs, continues.  Not blocking.
- `bodyCache` and `statCache` in the bundled adapter aren't bounded.
  Fine for known-small bootstrap manifest; unbounded for userland
  reads.  Will need eviction for long-running apps.

### #!~debt added

- `sync-xhr-network-blocking` (bundled.ts) — sync XHR blocks the wasm
  thread for the duration of any cold-cache fetch.  Fine on LAN dev;
  bad for production / slow networks.  Real impl: prefetch via async
  before `_start`, OR move FS to a separate worker w/ SAB+Atomics.
- `no-write-support` (bundled.ts) — `open(write:true)` always returns
  ROFS.  Userland `fs.writeFileSync` on `/tmp` etc. fails.  Needs OPFS
  adapter (future chunk).
- `no-readdir` (bundled.ts) — `readdir()` returns NOTDIR.  Vite has no
  directory listing endpoint and we'd need server-side manifest.
  Bootstrap doesn't readdir; userland will fail.
- `naïve-stat-via-fetch` (bundled.ts) — stat uses HEAD; no mtime/ctime
  propagation (symlink ctimes from disk are wrong anyway).
- `fake-fs-fallback` (wasi-shim.ts path_filestat_get) — paths the FS
  doesn't recognize still report success via the old heuristic.  Kept
  to avoid breaking libc cwd probes that worked before this chunk;
  remove once adapters cover the full path tree.

---

## 2026-05-20 — All 80 unofficial_napi_* now have named impls (#9 + #12)

Filled the remaining 67 in [browser-target/src/napi-host/unofficial.ts](browser-target/src/napi-host/unofficial.ts).
Every entry is marked `#!~debt` because most are best-effort no-ops with
sensible out-param writes; only a handful (`structured_clone`,
`get_constructor_name`, `get_own_non_index_properties`, `preview_entries`,
`contextify_run_script`, `arraybuffer_view_has_buffer`) do meaningful work
backed by browser JS.

Categories:

- **Heap / process / profiling stats** — return zeros; honest for "no V8".
- **Continuation-preserved embedder data** — single per-env slot, round-trips.
- **Promise introspection** — reports pending state, no result.
- **Stack inspection** — returns empty arrays/null.
- **Buffer / ArrayBuffer helpers** — real impls where browser JS suffices.
- **Structured clone family** — uses `globalThis.structuredClone()` with
  JSON fallback; transfer list dropped.
- **Serdes** — JSON-encoded ArrayBuffer roundtrip.
- **Contextify (vm.*)** — `make_context` returns marker, `run_script` evals
  via `new Function(...)`, `contains_module_syntax` is a naïve regex.
- **module_wrap_*** (18 funcs) — return handles that round-trip but don't
  execute.  ESM workloads will fail at link/evaluate; CJS boots fine.

Trace confirms: napi-host now seeds **231 entries** (was 164), zero STUB
fallback calls during edge boot.  Bootstrap timing unchanged (~83ms to EIO).

To promote a given stub to a real impl: pick one with `#!~debt` markers,
cross-reference the Rust behavior in `napi/src/guest/napi.rs`, and ideally
add a regression test asserting the trace's `fields.arg*` / `fields.ret`
matches native.

---

## 2026-05-20 — Service Worker HTTP bridge scaffolded (#5)

The wiring is in place: page registers `/sw.js`, sets up a `MessageChannel`,
hands one port to the SW and the other to the dedicated worker.  `/_edge/*`
fetches from anywhere in the page get intercepted by the SW, forwarded
through the port to the worker, dispatched, and the response is returned.

Verified end-to-end with a 501 stub responder:

```
fetch('/_edge/test', { method: 'POST' })
→ { status: 501, body: "edge bridge stub — POST /test\n#14 must unblock first" }
```

Components:

- `browser-target/public/sw.js` — SW with `/_edge/*` interceptor + port bookkeeping
- `browser-target/src/main.ts:setupBridge()` — registers SW, exchanges ports
- `browser-target/src/worker.ts:onBridgeMessage()` — receives `edge-req`,
  replies with `edge-res`

#!~debt stub responder: real impl needs to dispatch to a JS-side handle on
the running edge instance (probably an emnapi-exposed callback or a virtual
loopback socket pump).  Wait for #14 unblock first.

---

## 2026-05-20 — napi/ submodule patches preserved (#19 done)

`git submodule update` would obliterate the local mods in `napi/`.  Fixed by
exporting the diff to `patches/napi/*.patch` and adding `scripts/setup-napi-patches.sh`.

Reset / re-init flow:

```
git submodule update --init napi
./scripts/setup-napi-patches.sh
```

To regenerate after further local edits:

```
cd napi && git diff HEAD -- . ':(exclude)Cargo.lock' \
  > ../patches/napi/0001-edgejs-local-mods.patch
cd napi && git diff HEAD -- Cargo.lock \
  > ../patches/napi/0002-cargo-lock.patch
```

Pinned upstream commit: `1bcbf131187cb165053c615f6171eb58512b8014`.  Patches
contain:

- `--trace-wasi` flag + `JsonlTraceLayer` (src/bin/napi_wasmer.rs + new src/cli/)
- Permissive `NapiVersion::is_compatible_with` (src/lib.rs)
- Namespace merge + structured_clone 3-arg adapter + compile_function CJS
  adapter (src/guest/napi.rs)
- ctx + Cargo.{toml,lock,standalone.toml} bookkeeping

Verified end-to-end: stashed local mods → `git apply --check` clean → script
re-applied successfully → tree matches pre-stash state.

---

## 2026-05-20 — #!~debt uv_cwd EIO: attempt #4 (pre-seed `__wasilibc_cwd`) — N/A, did not unblock

The brief proposed pre-seeding `__wasilibc_cwd` from the host before
`_start` to bypass a broken init path.  Investigation killed the
hypothesis: **this wasm has no `__wasilibc_cwd` symbol** (or any cwd
cache global) at all.  Disassembling the libc `getcwd` wrapper:

- `func[1809]` (libc getcwd) calls `func[294]`, which is just a 3-line
  passthrough to `wasix_32v1.getcwd`.  No internal cache, no static
  state read.  On non-NULL buf, no malloc-retry path either.
- `wasm-tools dump` + `strings` confirm the symbol `__wasilibc_cwd`
  does not appear anywhere in the wasm.  No `__init_cwd` export.
- The `name` custom section is stripped; we have DWARF sections but
  no `llvm-dwarfdump` installed to walk them quickly.

So there is no host-side bytes to write.  Approach abandoned.

What I learned from the disassembly walk that the prior attempts did
not have:

- **The exact failure site is func[6035] (`TryGetCurrentWorkingDirectoryString`)
  → block J at 0x11fb60.**  Sets `*err_out = -29` (UV_EIO) when, after
  `uv_cwd` returned 0 and the local `std::string` was `resize`d to the
  returned length, `std::string::empty()` reports true.  Then func[5988]
  reads that -29 and calls func[6036] which builds the napi error.
- **The 21 getcwd calls in the trace are 21 SEPARATE process.cwd()
  invocations**, not loop retries on ENOBUFS.  Each call has a different
  caller stack frame (different `bufSizePtr`).  uv_cwd's internal retry
  on ENOBUFS would re-use the same bufSizePtr; we see all-different ones.
- **The mem-snapshot for the LAST getcwd call (the one immediately
  followed by the EIO build) shows `arg0` unchanged after the call**
  (all zeros, no `0x2f`).  But an in-shim readback via three independent
  paths (`dv.getUint8`, `new Uint8Array(buffer)[i]`, `new DataView(buffer)
  .getUint8(i)`) all confirm the `0x2f` IS at `bufPtr` at the moment the
  shim returns.  So the byte IS there; the mem-snapshot's `after` view
  on `memory.buffer` is reading something different.  This is the same
  one-time anomaly noted in `mem-snapshot.ts` (see `#!~debt
  unverified one-time anomaly`) — except not actually one-time.  It
  reliably misses on calls whose `bufPtr` lands in pages allocated
  after `__heap_base` (= 22060144), which only got *written* via the
  shim, never via the wasm.  Hypothesis: Chrome 148 caches the
  ArrayBuffer wrapper returned by `memory.buffer` per Uint8Array
  construction, and SharedArrayBuffer accesses miss writes that
  happened on a different cached wrapper.  Not chased further.

- **The EIO synthesis path inside the wasm requires `std::string::empty()`
  to be TRUE on the local buf.**  The buf was just constructed with
  `(256, '\\0')` (so size=256), then resized to whatever `*size_ptr` is
  after uv_cwd (= strlen of buf, which is 1 for "/").  So size should
  be 1, not 0.  Either: (a) `*size_ptr` is being read as 0 by the resize
  path, or (b) resize(1) results in `empty() == true`, or (c) something
  trashes the string between resize and empty().
- I did not chase to a definitive answer for which of (a)/(b)/(c)
  applies.  Each would require either symbol-name recovery (we don't
  have one) or wasm instrumentation (`wasm-tools mutate`) — both bigger
  asks than the 60-min budget for this attempt.

### Unblock paths still NOT tried, in priority order

1. **`#!~unblock` Patch the wasm with `wasm-tools mutate` / hex-edit
   to short-circuit func[6035] block J** (the "size==0 → set EIO"
   gate at 0x11fb60-0x11fb7d).  We know the exact byte range.  Even
   just NOP-ing the `i32.store 2 0` of `-29` at 0x11fb75 would prevent
   the EIO synthesis (the result would then be whatever the next path
   sets).  This is a band-aid but cheap.
2. **`#!~unblock` Hijack `napi_create_error`** at the host to detect
   the "EIO/uv_cwd" pattern and replace it with no-op so the throw
   path becomes a no-op return.  Edge would then proceed with an
   empty cwd; downstream code probably falls back to "/" or "".
3. **`#!~unblock` Diagnose the mem-snapshot/readback discrepancy
   first.**  If the shim's writes really aren't visible to the wasm
   (despite being visible to the shim's own re-read), that's the
   root cause and the buffer/SAB grow handling needs fixing.  The
   discrepancy might be a Chrome bug; would need an isolated repro.

Did NOT change any code as part of this attempt (the byte-by-byte
DataView write was tested and reverted — it didn't help, but it
proved the in-shim readback always succeeds).

---

## 2026-05-20 — #!~debt uv_cwd EIO: 3 attempts exhausted, parked

After three more attempts past the previous narrowing, EIO still surfaces
from `wrappedCwd` at bootstrap.  Attempts:

1. **proc_id errno fix.** Trace showed `wasix_32v1.proc_id(0x150aa0c) -> errno=1`.
   The shim was returning 1 (the PID value) with no outPtr handling — wasm
   read 1 as `errno=EPERM`. Fixed in [wasi-shim.ts:proc_id](browser-target/src/wasi-shim.ts)
   to write pid via outPtr and return `SUCCESS`.  Real bug; did NOT unblock EIO.
2. **Source walk** (edge `TryGetCurrentWorkingDirectoryString` at
   `src/edge_process.cc:235`, libuv `uv_cwd` at `deps/uv/src/unix/core.c:753`).
   Confirms EIO synthesized when libc getcwd returns NULL or empty.  No new
   leverage from the C++ side.
3. **Zero-pad getcwd buffer** to `max_path_len` to match wasmer-wasix's
   `getcwd.rs:36-44` exactly (it writes a zero-padded `Vec<u8>` of size
   `max_path_len64`, not just the cwd bytes).  Our shim used to write only
   `cwd.length` bytes.  Did NOT unblock EIO.

What we know stays the same: the EIO is constructed *inside the wasm*, with
no host imports between the last bootstrap call and the throw.  This means
the failure is in libc-internal state (likely `__wasilibc_cwd` cache being
empty when `getcwd_legacy` reads it), set during a path we can't observe
without DWARF or wasm instrumentation.

Unblock paths we did NOT try (would be next session):

- `#!~unblock` Rebuild edgejs.wasm with a patched `TryGetCurrentWorkingDirectoryString`
  that doesn't synthesize EIO for empty cwd (or pre-seeds the cwd from an
  env var).  Requires wasixcc toolchain.
- `#!~unblock` Use `wasm-tools` to instrument `wasm-function[5988]` (the C++
  ProcessCwd binding) and observe the actual libc getcwd return.
- `#!~unblock` Try setting `WASI_FS_ROOT` or other wasix-libc env vars that
  short-circuit cwd resolution.

Parking with `#!~debt` markers in code and this NOTES entry.

**Update (attempt #4):** investigated `__wasilibc_cwd` host pre-seed
hypothesis from the brief.  Confirmed `__wasilibc_cwd` does not exist
in this wasm — libc getcwd is a passthrough to `wasix_32v1.getcwd`.
See the new entry above for the precise EIO synthesis site
(func[6035] block J at 0x11fb60) and the ranked unblock options.

---

## 2026-05-20 — uv_cwd narrowed further but still open

Using the upgraded harness:

- **Comparative diff caught two real bugs** — missing `.` preopen (fd 4) and
  third `/` preopen (fd 5).  Browser now matches native on preopens.
- **Memory snapshots confirm our `getcwd` write lands** — bytes at `bufPtr`
  show `0x2f` ('/') after our `mem.set`, exactly as expected.  False alarm on
  earlier "no write" observation (memory state was tracked correctly).
- **Errno-proxy shows zero `EIO` (29) returns** from any of our syscalls.
  Everything we return is `0`, `8 (BADF)`, `44 (NOENT)`, or `1` (pid).

But edge still throws `EIO: process.cwd failed`.  The trace shows a ~16ms
window between the last syscall (`proc_id` returning the pid) and `proc_exit2(1)`
where edge does pure C++/JS work — *no host imports*.  That means errno=29
is being set by libc *internally*, not via any syscall return we control.

Hypothesis (per wasix-libc source review):

- `__wasilibc_cwd` (the libc-internal cwd cache, type `char*`) might be
  ending up as `""` (empty string) somehow.  Then libc's getcwd_legacy
  would return a zero-length string.  uv_cwd reads strlen → 0.  Edge's
  `TryGetCurrentWorkingDirectoryString` then synthesizes UV_EIO when the
  resulting `cwd` string is empty (`src/edge_process.cc:250`).

- Or one of these wasix-libc functions sets `errno = EIO` directly without
  going through a syscall (grepped, found these):
    - `libc-bottom-half/sources/getentropy.c:8`     (if len > 256)
    - `libc-top-half/musl/src/misc/getentropy.c:13` (if len > 256)
    - `libc-top-half/musl/src/aio/lio_listio.c:30`
    - `libc-top-half/musl/src/passwd/nscd_query.c`
    - `libc-top-half/musl/src/passwd/getgrouplist.c`

- libuv's `uv__random_readpath` opens `/dev/urandom` and reads — but if our
  fd_read returns short, libuv might surface EIO.  We do have /dev/urandom
  wired (verified earlier).

Next attack vector: figure out the wasm function at `wasm-function[5988]`
which the EIO stack points to.  That's the actual source.  Without DWARF
for edge code we'd need byte-pattern matching against the wasm or
instrumented rebuild.

Pragmatically, the unblock is probably:
1. Rebuild edgejs.wasm with `validate_openssl_csprng = false` AND a one-line
   patch to `TryGetCurrentWorkingDirectoryString` removing the "empty cwd
   → UV_EIO" gate.  Requires wasixcc.
2. Or instrument the wasm with `wasm-tools` to hook `wasm-function[5988]`
   and report what it actually reads.

---

## 2026-05-20 — Harness upgrades shipped (comparative tracing + memory + errno + filter)

The harness now has four diagnostic capabilities it didn't before:

1. **Comparative tracing (native ↔ browser).**  `napi_wasmer --trace-wasi <path>`
   writes JSONL host-call records, schema-compatible with what the browser
   harness exports via the JSONL download.  `browser-target/scripts/diff-traces.mjs`
   walks both files and reports the first divergence (with context).
   This caught the missing `.` and `/` preopens within one diff run.

2. **Memory snapshots at call sites.**  Pass `?mem=symbol1,symbol2` in the
   page URL.  The wasi/wasix shim wraps those symbols to capture N bytes
   around each pointer argument both before and after the call, attached
   to the trace under `fields.mem`.  Off by default — zero overhead when
   the URL param isn't set.

3. **Errno-proxy tracking.**  Trace summary includes a "non-zero wasi/wasix
   returns" section listing every syscall return that would set libc's
   errno, in chronological order.  Confirms which value was last set
   before any failure.  True `__errno_location` access isn't possible —
   the wasm doesn't export that symbol.

4. **Filterable trace UI.**  The harness page has a filter input that
   live-hides any log line not matching the substring.  Makes the 12k-call
   trace dump actually browsable.

### How to use comparative tracing

```bash
# 1. Native trace
napi_wasmer edgejs.wasm \
  --builtin-js-dir /tmp/edgejs-unpacked/lib \
  --trace-wasi /tmp/native.jsonl \
  -- -e "console.log('x')"

# 2. Browser trace — open http://127.0.0.1:5180/, wait for run to finish,
#    click "download JSONL (diff vs native)".  Or via agent-browser:
agent-browser eval "(async()=>{const a=document.querySelector('a[download*=jsonl]');return (await fetch(a.href)).text();})()" \
  | jq -r . > /tmp/browser.jsonl

# 3. Diff
node browser-target/scripts/diff-traces.mjs /tmp/native.jsonl /tmp/browser.jsonl
```

### What it cost to find via this harness vs prior approach

The "`.` preopen missing on browser" finding would have taken hours of
guessing-and-rebuilding without the diff.  With the harness, it took one
run.  Same for the env-vars-empty matching — visible in the diff at
position #1.

---

## Tech debt catalog

Every entry here corresponds to a `#!~debt` comment in the code.  When you
fix one, remove the marker AND the catalog row.  Grep for `#!~debt` to find
every site at once.

### Auto-generated stub fallback (`src/imports-generated.ts` via `scripts/gen-stubs.mjs`)

The generator emits one entry per host import: uses an override if we
provide one, otherwise a namespace-default-return stub.  Coverage today
(produced from `imports-*.txt` and `src/wasi-shim.ts` / `src/napi-host/`):

| Namespace | Edge imports | Real impls | Default-return fallbacks |
|---|---|---|---|
| `wasi_snapshot_preview1` | 37 | ~15 | ~22 (return 52 ENOSYS) |
| `wasix_32v1` | 46 | ~10 | ~36 (return 52 ENOSYS) |
| `napi` (standard) | ~100 | ~100 (via emnapi) | 0 |
| `napi` (unofficial) | 80 | 13 | 67 (return 0 = napi_ok — *lies success*) |
| `env` | 7 | 7 (real stubs returning zeros) | 0 |
| `wasi.thread-spawn` | 1 | 0 | 1 (returns -1) |

The 67 unofficial_napi_* fallbacks are the biggest correctness risk:
returning `napi_ok` without doing anything causes the wasm to think the
operation succeeded when it didn't.  Trace will show no STUB because
they're "implemented via fallback," but they're functionally broken.

Task #12 was marked complete based on "no STUB in current trace" — that
was true but only because edge's boot path only exercises 13 of the 80.
A more complete run will surface the rest, one at a time.

### Browser host — napi extensions (`src/napi-host/unofficial.ts`)

- `unofficial_napi_set_enqueue_foreground_task_callback` — no-op.  Should
  wire to `queueMicrotask`/`postMessage` so async work and timers actually
  fire.  Anything depending on the event loop (timers, async I/O callbacks)
  is broken until done.
- `unofficial_napi_set_fatal_error_callbacks` — no-op.  Fatal errors
  surface only via JS throw, not via these callbacks.
- `unofficial_napi_set_prepare_stack_trace_callback` — no-op.  Browser's
  default stack format used instead of node's V8 customization.  Cosmetic
  until userland relies on V8 stack shape.
- `unofficial_napi_set_promise_hooks` — no-op.  `async_hooks` won't see
  init/before/after/resolve events.
- `unofficial_napi_get_error_source_positions` — no-op.  Stack frames lack
  precise column info.
- `unofficial_napi_get_proxy_details` — always reports "not a Proxy".
  Anything inspecting Proxy internals via napi gets wrong answer.
- `unofficial_napi_release_env` — no-op.  Created emnapi envs / scopes
  accumulate (don't actually release).  Fine for single shots; leaks for
  long sessions.
- `unofficial_napi_contextify_compile_function` — uses `new Function` as
  V8 `vm.compileFunction` approximation.  Drops `parsingContext`,
  `contextExtensions`, `cachedData`, `produceCachedData`.  Compile errors
  return status 1 instead of populating the napi pending-exception slot.

### Browser host — emnapi instance proxy (`src/napi-host/instance-proxy.ts`)

- `free` — no-op.  `unofficial_napi_guest_malloc` allocates from wasm
  heap with no paired guest_free, so every emnapi-side malloc leaks
  until the wasm itself dies.  Negligible during boot, unbounded for
  long-running sessions / large buffer churn.
- `napi_register_wasm_v1` proxy stub — returns 0 so emnapi's init
  flow completes.  edge isn't a napi-rs addon; this just satisfies
  emnapi's instance-check.  Not visibly broken but worth noting.

### Browser host — WASI shim (`src/wasi-shim.ts`)

- `poll_oneoff` — returns "0 events ready" immediately.  Blocks setTimeout
  from firing, breaks any FD-readiness wait.  Needs SAB+Atomics.wait or
  proper Worker scheduling for real impl.
- `fd_pipe` — allocates a pair of virtual fds but they aren't actually
  connected.  Writes are accepted-and-discarded; the read side never sees
  data.  Real pipe semantics need a shared ring buffer.
- `path_filestat_get` (fallback branch) — `fake-fs-fallback`: when the FS
  facade returns NOENT, the shim still reports success with a "trailing
  slash → dir / else file" heuristic.  Kept to avoid regressing libc
  cwd / fixture probes that worked before adapters existed.

### Browser host — FileSystem (`src/host/fs/adapters/bundled.ts`)

- `sync-xhr-network-blocking` — cold-cache reads block the wasm thread
  for the duration of a network RTT.  Fine for LAN dev (<1 ms); bad for
  prod / slow networks.  Real impl: prefetch via async before `_start`,
  OR move FS to a separate worker addressed via SAB+Atomics.wait.
- `no-write-support` — `open(write:true)` always returns ROFS.  Tests
  and userland needing `/tmp` scratch will fail.  Needs OPFS adapter
  (future chunk).
- `no-readdir` — returns NOTDIR.  Vite has no directory-listing
  endpoint; we'd need a server-side manifest.  Bootstrap doesn't
  readdir; `fs.readdirSync` from userland will fail.
- `naïve-stat-via-fetch` — stat uses HEAD; no mtime/ctime propagated.

### Worker (`src/worker.ts`)

- Hard `CALL_LIMIT` of 20,000 imports per run as a runaway-loop circuit
  breaker.  Crude — should be a watchdog timer or progress-based.

### Memory snapshot (`src/mem-snapshot.ts`)

- Unverified one-time anomaly: an earlier capture showed a `getcwd` write
  that didn't persist in the `after` snapshot.  Subsequent runs all show
  writes correctly.  Not reproducible at present.  If it returns, the
  marker is there — bisect from `mem.set` outwards.

### Diagnostics (`src/diagnostics/*`)

- `sab-view-aliasing.ts` — pure-JS isolated repro for the Hypothesis A
  scenario from attempt #5 of #14.  Tests whether Chrome aliases SAB
  views in a way that hides writes.  Verdict from 2026-05-20 run: NO,
  it doesn't.  Keep until #14 is closed and we're confident this won't
  resurface for a related bug.  Gated behind `?diag=sab-aliasing`.
- `byteLength-watcher.ts` — wraps host import namespaces to log every
  `memory.buffer.byteLength` change observed across the bootstrap.
  Used in attempt #5 of #14 to verify the wasm calls `memory.grow`
  during boot (it does; ~12 pages of growth).  Gated behind
  `?diag=bytelen`.  Keep alongside `sab-view-aliasing.ts`.

---

## Local submodule mods (not upstreamed)

The following files in the `napi/` submodule are modified locally.  A
`git submodule update --remote` or reset of `napi/` will lose all of these.
Re-apply order doesn't matter; each is independent.

### `napi/Cargo.toml` + `napi/Cargo.standalone.toml`

Added optional `tracing`, `tracing-subscriber` (env-filter feature), and
`serde_json` deps; pulled into the `cli` feature.  Required for the
`--trace-wasi` JSONL output.

### `napi/src/lib.rs:32-44` — `NapiVersion::is_compatible_with`

Made permissive: accepts `(V10, Unknown)` and `(Unknown, V10)` and
`(Unknown, Unknown)` (upstream only had `(V10, V10)` and `(Unknown, V10)`).
Required because the published `wasmer/edgejs` binary is built against a
newer napi protocol than `wasmerio/napi` main publishes.

### `napi/src/cli.rs` → `napi/src/cli/mod.rs`

Renamed file to enable submodule structure under `cli/`.  Same content,
just relocated.  `cli` is now a module directory.

### `napi/src/cli/trace_layer.rs` (new file)

JSONL trace layer for the comparative-tracing harness.  Captures every
`tracing` span matching `wasmer_wasix::syscalls::*` and writes one JSON
line per span close to a file.  Schema-compatible with the browser-side
trace dump.

### `napi/src/bin/napi_wasmer.rs`

Added `--trace-wasi <path>` flag that initializes a `tracing_subscriber`
with the JsonlTraceLayer.  Default-off — only active when the flag is
passed.

### `napi/src/guest/napi.rs` — four edits

1. **Namespace merge** (after `io.register_namespace(NAPI_MODULE_NAME, ...)`,
   before the extension namespace registration): clones each entry from
   `napi_extension_wasmer_namespace` into the `napi` module.  Required
   because newer prebuilt edgejs.wasm puts `unofficial_napi_*` under the
   `napi` import module rather than `napi_extension_wasmer_v0`.

2. **`guest_unofficial_napi_structured_clone_3arg`** (new function): a
   3-arg adapter for the older signature edge.wasm now expects, delegating
   to the existing 4-arg impl with `transfer_list = 0`.  The `napi`
   namespace registration for `unofficial_napi_structured_clone` is
   re-routed to this adapter; `_with_transfer` keeps the original.

3. **Three stub functions added**: `guest_stub_unofficial_napi_contextify_compile_function_for_cjs_loader`,
   `guest_stub_unofficial_napi_get_current_stack_trace`,
   `guest_stub_unofficial_napi_module_wrap_import_module_dynamically`.  The
   first one is a real adapter that builds the CJS params array and calls
   the regular `contextify_compile_function`; the other two are no-ops
   that return generic-failure status.

4. **`compile_function_for_cjs_loader` adapter** writes through the
   existing 12-arg `contextify_compile_function` with the 5 CJS wrapper
   param names (`exports`, `require`, `module`, `__filename`, `__dirname`).
   Returns the wrapper-object handle directly (don't re-wrap — the bridge
   already produces `{function, sourceURL, sourceMapURL, ...}`).

---

## Closed investigations / negative results

Things we tried that didn't pan out.  Logged so we don't re-walk these
paths.

- **Setting `PWD=/` in the wasi env** → no effect on uv_cwd EIO.
- **Setting `currentCwd = "/app"` instead of `/`** → no effect; reverted.
- **Looking for `RAND_seed` / `OSSL_*` / any entropy-seeding exports** to
  call from JS at boot → zero matches (all stripped from the wasm
  exports by the linker).  This is the reason we did the `/dev/urandom`
  virtual file route instead.
- **DWARF lookup for `EdgeValidateOpenSslCsprng` / other edge functions**
  via `llvm-dwarfdump --name=...` → DWARF is in the wasm but only covers
  compiler-rt, musl, and libc++ — *no* edge source debug info.
  Can't symbolicate stacks pointing to edge functions.
- **Stock `wasmer` CLI 7.1.0 + `--experimental-napi`** on the published
  `wasmer/edgejs` package → "Unsupported N-API import version: Unknown".
  Forced us to build `napi_wasmer` locally from the `napi/` submodule
  and apply the version-check patch.
- **`OPENSSL_CONF=/dev/null` / `RANDFILE=...` env vars** to influence
  OpenSSL init → no effect on the EIO path.
- **Searched `wasix-libc` for `errno = EIO` callers** → only five sites
  (two getentropy variants for len>256, aio_lio_listio, two passwd
  helpers).  None plausibly reached by uv_cwd.  Source of errno=29 is
  still unknown.
- **Tried `napi_wasmer` from origin/main of wasmerio/napi** → wasmer-types
  version conflict (7.2.0-alpha.2 vs 7.1.0).  Standalone build broken at
  HEAD.  Pinned at commit `1bcbf131` instead.

---

## 2026-05-20 — uv_cwd EIO confirmed NOT a write-visibility issue

Added a readback diagnostic in `wasix_32v1.getcwd` that reads memory
immediately after our `mem.set(enc, bufPtr)` write.  Confirmed the bytes
land where expected (`[getcwd] wrote "/" (1B) at addr ..., maxLen was ...`).

So the wasm CAN see our cwd write — yet edge's `TryGetCurrentWorkingDirectoryString`
still ends up reporting `UV_EIO` (errno -29, the WASI `__WASI_ERRNO_IO`
value).  Possible roots, in order of likelihood:

1. A *different* libc getcwd variant is being used than `libc-bottom-half/sources/getcwd.c`
   — there's also `libc-top-half/musl/src/unistd/getcwd.c` with `__wasilibc_unmodified_upstream`
   guards.  Linker might pick differently than we expect.
2. `errno` was set to 29 by some earlier syscall (one of the many
   path_open2 ENOENT probes?) and lingers; libc's getcwd may surface it
   even though OUR wasi_getcwd returned success.
3. Edge wraps `uv_cwd` in a chain that does extra validation we haven't seen.

Best next diagnostic: build `napi_wasmer` with extra logging around
`__wasi_getcwd` invocations and diff against browser.  Won't trace
through libc internals from outside.

---

## 2026-05-20 — All STUB host imports retired

After implementing 11 unofficial_napi_* functions (env lifecycle, V8 flags,
private symbols, contextify compile_function, foreground task callback,
fatal error callbacks, prepare stack trace callback, promise hooks, error
source positions, proxy details) **the trace shows zero `[STUB]` calls**.
Every host import is now either:

- An emnapi-provided standard `napi_*` implementation (~100 functions)
- A hand-rolled unofficial_napi_* in `browser-target/src/napi-host/unofficial.ts`
- A WASI/WASIX implementation in `browser-target/src/wasi-shim.ts`
- An intentional `return 0` no-op for callbacks we don't dispatch

Every napi or wasi NOSYS return is now an actual gap, not a forgotten stub.
This is the right baseline state for the next phase of work.

---

## 2026-05-20 — Primordials have no runtime toggle in edge.js

`internal/per_context/primordials` is executed unconditionally during
bootstrap at `src/edge_runtime.cc:2757`. No CLI flag, no env var, no
`RuntimeInitOptions` field controls it.

For WebContainer-style browser performance the cost is non-trivial. The
natural shape would be:

- Add `RuntimeInitOptions::execute_primordials = true` (parallel to
  `validate_openssl_csprng`).
- Wire `EDGE_SKIP_PRIMORDIALS=1` env var via `EdgeIsTruthyEnvVar`.
- Gate the `execute_bootstrapper("internal/per_context/primordials", ...)`
  call on that flag.
- ~5-line patch in `edge_cli.cc` + `edge_runtime.cc`.

Not blocked on this for the current path — primordials *do* run successfully
in our browser harness via the emnapi-backed
`unofficial_napi_contextify_compile_function`. Logging the question for
when we revisit perf.

---

## 2026-05-20 — CSPRNG validation has no runtime toggle either

`EdgeValidateOpenSslCsprng` (`src/edge_runtime.cc:3584`) calls `std::abort()`
unconditionally if `ncrypto::CSPRNG(nullptr, 0)` returns false.
`RuntimeInitOptions::validate_openssl_csprng` defaults to `true` and is never
set to `false` anywhere in the codebase.

Worked around in the browser by mounting a virtual `/dev/urandom` backed by
`crypto.getRandomValues` — mirrors what wasmer-wasix does natively per
`virtual-fs-0.701.0/src/builder.rs:97`. OpenSSL opens the file and reads
entropy through the standard WASI `fd_read` path; CSPRNG passes naturally.

Open question: should `validate_openssl_csprng = false` be the default for
WASIX target builds? Hosts that don't provide a virtual `/dev/urandom`
(which is many) hit this trip wire silently with `std::abort()`.

---

## 2026-05-20 — uv_cwd EIO under our browser shim only

After full Node bootstrap, `process.cwd()` throws
`EIO: process.cwd failed with error i/o error, uv_cwd`. Native
`napi_wasmer` passes the same checkpoint cleanly.

The fault is in edge's `TryGetCurrentWorkingDirectoryString` synthesizing
`UV_EIO` when `uv_cwd` returns success but the cwd buffer is empty
(`src/edge_process.cc:250`). Our `wasix_32v1.getcwd` is implemented
correctly: returns "/" + length 1.

Suspects (not yet investigated):

- A different wasi-libc internal path that doesn't go through our
  `wasix_32v1.getcwd` at this specific call site.
- An interaction with `__wasilibc_cwd_is_synced` / `__wasilibc_cwd`
  state where libc returns the global string instead of asking the host.
- Some other syscall in the chain returning success-with-empty.

Best diagnostic: run the same `console.log` script under native
`napi_wasmer` with WASI tracing on, diff the syscall sequence against the
browser trace — they should diverge at one specific call.

---

## 2026-05-20 — Crypto + TextDecoder reject SharedArrayBuffer views

In the browser, `crypto.getRandomValues` and `TextDecoder.decode` both
throw when given views backed by `SharedArrayBuffer`. Edge requires shared
memory (wasm-threads), so all WASM linear memory is SAB-backed.

Workaround in our shim: copy bytes into a fresh `Uint8Array` first, then do
the operation, then copy back to the shared buffer. See
`browser-target/src/wasi-shim.ts` `urandomFd()` and `random_get()`, and
`browser-target/src/napi-host/unofficial.ts` for the same pattern in
`unofficial_napi_create_private_symbol`.

Worth knowing: any future API that touches guest memory directly will hit
the same restriction.

---

## 2026-05-20 — `unofficial_napi_guest_malloc` is the host-allocator escape hatch

The edge wasm exports `unofficial_napi_guest_malloc(size: u32) → u32` so
the host can allocate guest-side memory for ArrayBuffer / TypedArray
bridging. No paired `unofficial_napi_guest_free` — allocations leak by
design until guest GC.

We wired this into our `napi-host/instance-proxy.ts` as emnapi's `malloc`.
Without this, emnapi's typed-array marshalling path crashes.

Already flagged in `wasix/WASIX_TODO.md` ("Revisit the explicit
`ubi_guest_malloc` export"). Long-term wants a cleaner guest allocator
contract, but the current escape hatch is doing real work for us today.

---

## 2026-05-20 — Edge mutates `globalThis` mid-run

Edge's bootstrap installs all the Node globals (`process`, `Buffer`,
`globalThis.primordials`, etc.) by writing onto `globalThis`. That includes
shadowing some host-provided properties.

In our worker we found `globalThis.performance` getting clobbered partway
through bootstrap, causing later `performance.now()` to throw "Cannot read
properties of undefined". Fix: capture native APIs at module load (before
the wasm runs) into local consts. See `browser-target/src/worker.ts:16` and
`browser-target/src/trace.ts:18`.

Generalize this: anywhere our host code uses a globalThis-accessible API
*across* a wasm call, cache the binding upfront.

---

## 2026-05-20 — Hardcoded developer paths in published wasm

The published `wasmer/edgejs` wasm has hardcoded paths from the build
machine baked into the binary, e.g.:

- `/home/amin/projects/work/edgejs/node/deps/undici/src/package.json`
- `/home/amin/projects/work/edgejs/test/fixtures/tz-version.txt`
- `/home/amin/projects/work/edgejs/node/config.gypi`

Edge probes these as fallbacks at startup; they all `ENOENT` cleanly and
bootstrap proceeds. Not blocking, cosmetic. When we own the build pipeline
we should pass a generic prefix (`/edgejs/...`) or strip the absolute
prefix at build time.

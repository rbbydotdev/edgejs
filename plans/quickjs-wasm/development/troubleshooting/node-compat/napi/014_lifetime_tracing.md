# Known Issue: QuickJS N-API lifetime tracing

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Value/ref wrapper allocation has been replaced with scope-owned slot vectors; external backing hints still need separate follow-up. |
| **Severity** | Medium | Growth can destabilize long-running Edge QuickJS servers, but this note tracks diagnostics rather than a confirmed blocker. |

## Current State

The QuickJS N-API backend has small internal owners for values, refs, scopes,
callback state, externals, functions, deferred promises, and environment
subsystems. EdgeJS runtime code under `src/` creates many long-lived refs for
binding singletons, wrapper objects, stream and filesystem requests, async
hooks, timers, and process state. Many paths delete refs explicitly, but others
rely on object finalizers or environment teardown.

There is currently no unified counter for live QuickJS N-API wrapper objects, so
request-over-request growth is hard to separate from expected churn.

## Action Plan

1. Map allocation and free paths for `napi_value__`, `napi_ref__`,
   `napi_env__`, handle scopes, escapable handle scopes, callback info,
   externals, functions, deferred promises, and cleanup hooks.
2. Inspect representative EdgeJS `src/` bindings for explicit
   `napi_delete_reference(...)`, `napi_wrap(...)` finalizers, and handle-scope
   discipline.
3. Add a reusable internal lifetime tracker under `napi/quickjs/src/internal`
   that is silent unless `EDGE_TRACE_NAPI_LIFETIME=1` is set.
4. Record create/destroy counters and live counts for the focused wrapper
   classes, with optional dump points at environment teardown and manual
   breakpoints.
5. Rebuild the native QuickJS CLI if feasible and run a short smoke test that
   exercises a server entry while tracing lifetime churn.

## Initial Investigation Notes

- `plans/quickjs-wasm/development/001_merge_analysis.md` already identified
  the key QuickJS N-API runtime types and the preference for internal RAII-style
  ownership over broad public structs.
- `004_environment.md` records the known teardown caveat around
  `JS_FreeRuntime(...)`. A concurrent worktree edit has re-enabled
  `JS_FreeRuntime(...)` in `napi/quickjs/src/unofficial_napi.cc`; lifetime
  tracing must observe that state rather than reverting it.
- The first instrumentation pass should remain diagnostic-only and avoid
  changing normal runtime semantics.

## Instrumentation Added

Added `napi_lifetime_tracker__` under `napi/quickjs/src/internal`. The whole
tracker is compile-time gated behind `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`,
which defaults to `OFF`. When compiled in, it records created, destroyed, live,
and peak counts for:

- `napi_env__`
- `napi_scope__`
- `napi_handle_scope__`
- `napi_escapable_handle_scope__`
- `napi_value__`
- `napi_ref__`
- `napi_callback_info__`
- `napi_external_backing_store_hint__`
- `napi_deferred__`
- `napi_env_cleanup_hook__`

Enable the tracker at configure time, then enable event logging at runtime with:

```sh
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge server.js
```

When the compile-time flag is off, `napi_lifetime_tracker.cc` is not compiled
into `napi_quickjs`, tracker headers are not included by the owner classes, and
the `record_create(...)` / `record_destroy(...)` call sites are excluded by the
preprocessor.

The tracker dumps live counts at `napi_env__` teardown. When compiled in, it also
exposes:

```c
napi_quickjs_lifetime_dump("lldb checkpoint")
```

so LLDB can request a snapshot while the process is paused.

Set `EDGE_TRACE_NAPI_LIFETIME_DUMP_EVERY=<N>` to print periodic summary dumps
every N creations of a given type.

## Lifetime Map

- `napi_env__` is allocated in
  `unofficial_napi_create_env_from_context(...)` and destroyed through
  `DestroyEnvInstance(...)` / `ReleaseEnvScope(...)`.
- `napi_env__` creates a root `napi_scope__`; current code nulls
  `root_scope_` during env teardown without destroying it.
- Most public N-API value-producing calls wrap `JSValue`s into
  `env->current_scope()->wrap_value(...)`, which allocates `napi_value__`.
- Explicit handle scopes are allocated by `napi_open_handle_scope(...)` /
  `napi_open_escapable_handle_scope(...)` and destroyed only by the matching
  close APIs.
- `napi_ref__` is allocated by `napi_create_reference(...)` and freed by
  `napi_delete_reference(...)`; weak refs are also tracked on `napi_env__`.
- `napi_external_backing_store_hint__` backs externals, wraps, finalizers, and
  external array buffers; it is destroyed by QuickJS class or array-buffer
  finalizers, or by `napi_remove_wrap(...)`.
- `napi_callback_info__` is stack-allocated in the QuickJS C-function
  trampoline for each N-API callback.

## EdgeJS Embedder Findings

`src/` does not currently call `napi_open_handle_scope(...)` or
`napi_close_handle_scope(...)`. Runtime bindings mostly rely on explicit
`napi_delete_reference(...)`, object finalizers from `napi_wrap(...)`, and
environment-slot destructors.

Representative paths that do close refs explicitly:

- binding singleton state such as task queue, timers, stream symbols, tcp/pipe
  constructor refs, and process binding refs deletes old refs before replacing
  them or in state destructors;
- stream write/shutdown/connect request wrappers keep request and buffer refs
  until completion/finalizer cleanup;
- filesystem deferred completions destroy created refs on failure and later
  completion cleanup.

The missing embedder handle-scope discipline means temporary values created
during callbacks appear to accumulate in the QuickJS root scope unless the
backend explicitly deletes them.

## Verification

Built the native CLI:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Result: succeeded. The build emitted existing dependency deprecation warnings
from OpenSSL/c-ares paths.

Trace smoke:

```sh
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge -e "console.log('life smoke')" \
  > /private/tmp/edge-lifetime-eval.log 2>&1
```

Result: succeeded and produced lifetime events. Teardown summary showed:

```text
napi_value__ live=10088 peak=10088 created=10280 destroyed=192
napi_ref__ live=3 peak=147 created=148 destroyed=145
napi_callback_info__ live=0 peak=2 created=192 destroyed=192
napi_external_backing_store_hint__ live=2982 peak=2982 created=2982 destroyed=0
```

The existing root `server.js` and `tests/js/webserver.js` failed inside the
default sandbox with `listen EPERM`. Rerunning the loopback server with approval
allowed:

```sh
PORT=3311 EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge tests/js/webserver.js \
  > /private/tmp/edge-lifetime-webserver.log 2>&1
curl -sS http://127.0.0.1:3311/
curl -sS http://127.0.0.1:3311/again
```

Both requests returned `hello`. Around listen, `napi_value__` live count was
about `11755`; after two requests it had reached `12367`, while
`napi_callback_info__` repeatedly returned to zero.

## Current Leak Suspects

1. Root-scope retention: `napi_env__::~napi_env__` does not destroy
   `root_scope_`, and `src/` does not open per-callback handle scopes, so
   temporary `napi_value__` wrappers are retained for the life of the env.
2. External hint finalization: `napi_external_backing_store_hint__` live count
   stayed high through short eval/server runs. This may be expected until
   QuickJS GC/finalizers run, but it should be checked with explicit
   `JS_RunGC(...)` and root-scope cleanup experiments.
3. Request churn: two HTTP requests increased live `napi_value__` counts by
   hundreds. The next step is to dump between requests under LLDB and correlate
   the growth with specific callbacks or property/value creation paths.

## Vector-Backed Handle Plan

The next implementation step is to remove per-wrapper allocation for
`napi_value__` and `napi_ref__`.

Planned shape:

1. Add an internal `napi_allocator__` that owns opaque handle encoding,
   decoding, slot construction, and slot release for values and refs.
2. Store actual `napi_value__` entries in `napi_scope__::values_` and actual
   `napi_ref__` entries in `napi_scope__::refs_`; expose `napi_value` and
   `napi_ref` as encoded slot indexes rather than addresses of heap-allocated
   wrapper objects.
3. Reuse freed vector entries by keeping free indexes in each scope instead of
   deleting wrapper allocations.
4. Keep value handles local to the current scope, with parent-scope lookup for
   outer handles used from nested scopes.
5. Keep refs persistent by allocating ref slots from the env root scope, because
   EdgeJS stores refs across callbacks and async completions.
6. Destroy the root scope during `napi_env__` teardown so root-owned refs and
   values release their duplicated `JSValue`s.
7. Preserve `EDGE_TRACE_NAPI_LIFETIME=1` counters while changing the allocation
   backend so before/after server traces remain comparable.

## Vector-Backed Handle Implementation

Implemented `napi_allocator__<T>` for `napi_value__` and `napi_ref__` slots.
The public handles are encoded slot indexes, not addresses of heap-allocated
wrappers. Slot index zero is encoded as pointer value one so `nullptr` remains
the invalid handle.

`napi_scope__` now owns:

```c++
napi_allocator__<napi_value__> values_;
napi_allocator__<napi_ref__> refs_;
```

`napi_value__` and `napi_ref__` are reusable move-only slot payloads with
`initialize(...)`, `release()`, and `is_active()` methods. Released slots are
put on the allocator free-list for reuse instead of deleting wrapper memory.

Value handles are allocated from `env->current_scope()`. Ref handles are
allocated from `env->root_scope()` because EdgeJS stores refs across callbacks,
async completions, finalizers, and binding singleton state. Accessors now route
through:

```c++
napi_quickjs_value_inner(env, value)
napi_quickjs_value_slot(env, value)
napi_quickjs_ref_slot(env, ref)
```

so encoded handles are resolved before reading the slot payload.

`napi_env__::~napi_env__` now destroys the root scope. This releases all
root-owned value/ref slots and runs their QuickJS value frees before env
teardown completes.

## 2026-05-11 Periodic Allocator Stats

Action plan:

1. Preserve the existing `EDGE_TRACE_NAPI_LIFETIME` event/dump behavior when the
   tracker is compiled in.
2. Add compile-time-off-by-default flags for the tracker and periodic slot stats
   so normal builds keep the tracker source, includes, and call sites compiled
   out.
3. Track value/ref allocator slot deltas at allocation, release, prefix reserve,
   and scope close time instead of scanning all scopes globally.
4. Print at most once every two seconds from allocator activity using a
   monotonic clock check, with no background thread.
5. Rebuild the native QuickJS Edge target both with the default flag-off build
   and with the flag enabled long enough to verify output.

## 2026-05-11 Server Stats Growth Investigation

Action plan:

1. Treat the current vector-backed allocator, teardown fixes, and periodic
   stats feature as the baseline; inspect their accounting before changing
   behavior.
2. Confirm whether `build-edge-quickjs-cli` was configured with
   `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON`; reconfigure only if needed
   for reproduction and record the change.
3. Reproduce `napi-lifetime-stats` growth with `./build-edge-quickjs-cli/edge
   server.js` or a minimal local HTTP server, driving a small request batch with
   `ab` or a simple local client.
4. Use LLDB breakpoints on value wrapping, scope open/close, callback
   trampolines, and ref create/delete to identify whether per-request values
   are allocated into the root scope, a temporary handle scope, or persistent
   ref storage.
5. Separate true retention from allocator bookkeeping: check whether
   `slots_total` growth is expected capacity/freelist growth while `active`
   reflects still-open scopes or root-scope values.
6. If the evidence shows N-API callback entry is missing a temporary handle
   scope, implement the narrowest RAII/internal scope around the QuickJS
   callback trampoline and rerun targeted handle-scope/function/reference tests.

Implementation:

- Added CMake option `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`, default `OFF`.
  This controls compilation of `napi_lifetime_tracker.cc`, guarded includes of
  `internal/napi_lifetime_tracker.h`, and all calls to
  `napi_lifetime_tracker__`. Owner files use the lightweight
  `NAPI_QUICKJS_LIFETIME_RECORD(...)` / `NAPI_QUICKJS_LIFETIME_DUMP(...)`
  macros from `internal/napi_lifetime_macros.h`, so the call sites stay compact
  and compile to no-ops when the tracker flag is off.
- Added CMake option
  `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS`, default `OFF`. Enabling it also
  enables `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER`, because periodic stats are
  implemented inside the tracker.
- When enabled, `napi_allocator__<napi_value__>` and
  `napi_allocator__<napi_ref__>` report total slot and active slot deltas to
  `napi_lifetime_tracker__`.
- The tracker emits a single-line summary to stderr no more than once every two
  seconds when allocator activity crosses the interval and
  `EDGE_TRACE_NAPI_LIFETIME_STATS=1` or `EDGE_TRACE_NAPI_LIFETIME=1` is set:

```text
[napi-lifetime-stats] napi_value slots_total=10676 active=10676 napi_ref slots_total=176 active=176
```

Enable for a CMake build directory with:

```sh
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
```

Run with `EDGE_TRACE_NAPI_LIFETIME_STATS=1` for stats-only output, or the
existing `EDGE_TRACE_NAPI_LIFETIME=1` for full lifetime event tracing plus
stats. Set the CMake option back to `OFF` and rebuild to return to the default
silent build.

Slot-count caveat: `slots_total` is the aggregate size of the backing vectors
for currently live allocators. For nested handle scopes, value allocators reserve
inactive prefix slots so encoded handles from parent scopes can remain
resolvable by falling back to the parent. Those reserved prefix entries are
included in `napi_value slots_total` but not in `active`.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs-only
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON
cmake --build build-edge-quickjs-cli --target edge -j4
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/edge -e "let n=0; const id=setInterval(()=>{ console.log('tick', ++n); if (n === 4) clearInterval(id); }, 700);"
cmake -S . -B build-edge-quickjs-cli -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=OFF -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=OFF
cmake --build build-edge-quickjs-cli --target edge -j4
```

Results:

- Default flag-off rebuild passed.
- `make test-napi-quickjs-only` passed, 45/45.
- Flag-on rebuild passed and printed the example
  `[napi-lifetime-stats] ...` line above after the interval script crossed two
  seconds.
- The CLI interval and eval smokes still abort after printing user output with
  QuickJS debug assertion
  `Assertion failed: (list_empty(&rt->gc_obj_list))` in `JS_FreeRuntime(...)`.
  That assertion was reproduced with the flag off as well, so it is recorded as
  current teardown state rather than caused by the periodic stats flag.

## Verification After Vector-Backed Handles

Rebuilt native Edge QuickJS:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
```

Result: passed.

Ran eval smoke:

```sh
./build-edge-quickjs-cli/edge -e "const http=require('http'); console.log('ok', typeof http.createServer)"
```

Result:

```text
ok function
```

Ran lifetime teardown smoke:

```sh
EDGE_TRACE_NAPI_LIFETIME=1 ./build-edge-quickjs-cli/edge -e "console.log('allocator smoke')"
```

Result: passed. The final teardown summary now reports:

```text
napi_value__ live=0 peak=10621 created=10829 destroyed=10829
napi_ref__ live=0 peak=171 created=172 destroyed=172
napi_callback_info__ live=0 peak=3 created=208 destroyed=208
napi_external_backing_store_hint__ live=2916 peak=3202 created=3202 destroyed=286
```

Ran the QuickJS N-API suite:

```sh
make test-napi-quickjs-only
```

Result: 45/45 tests passed.

## 2026-05-11 Root `test_6` Debug Check

Sadhbh reported that `make test-native-quickjs` from `napi/` passed, while a
clean root rebuild with `make test-napi-quickjs` failed
`napi_quickjs_test_6.Test6.PortedCoreFlow`.

Current action plan:

1. Reproduce from the root build directory, not the standalone `napi/` build.
2. Run `napi_quickjs_test_6` directly, through CTest, and under LLDB.
3. Check both Release and Debug root build shapes, because the root `Makefile`
   defaults to Release unless `CMAKE_BUILD_TYPE=Debug` is supplied.
4. If the failure reproduces, inspect the post-test teardown path and callback
   scope/result ownership before changing code.

Findings:

- The current root-built `napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow`
  passes directly.
- `ctest --test-dir build-edge-quickjs-cli/napi-quickjs/tests -R
  napi_quickjs_test_6 --output-on-failure -V` passes the discovered
  `Test6.PortedCoreFlow` case.
- A clean root Release run via `make test-napi-quickjs` passes 45/45 tests.
- A forced root Debug rebuild via `CMAKE_BUILD_TYPE=Debug make
  build-napi-quickjs`, followed by `CMAKE_BUILD_TYPE=Debug make
  test-napi-quickjs-only`, also passes 45/45 tests.
- LLDB initially stopped a stale Release binary in `malloc` while GoogleTest was
  printing the test result, but after the Debug rebuild LLDB ran the same
  `Test6.PortedCoreFlow` filter to process exit status 0. No stable
  `test_6` failure is currently reproducible.

Interpretation:

The `test_6` symptom appears to have been stale-build or configuration-state
dependent rather than a remaining object-wrap semantic failure in the current
source. The callback trampoline now opens a child handle scope, duplicates the
callback result into a QuickJS return value before closing that scope, and
deletes the local `napi_value` handle from the current scope. That is the
important ownership boundary for object-wrap constructor and method callbacks.

Follow-up implementation:

- Tightened `napi_scope__::delete_value(...)` so deleting a callback return
  handle only releases a value owned by that exact scope. Lookup still walks
  parents, but deletion should not; otherwise a callback that returns a
  parent-scope handle could accidentally invalidate the outer handle while the
  trampoline is only trying to drop its local return handle.
- Added `test_function` coverage where a callback returns a module-init
  parent-scope value twice. The second return verifies the trampoline did not
  destroy the outer handle during the first callback return cleanup.
- Fixed reentrant slot release during teardown: `napi_ref__::release()` and
  `napi_value__::release()` now mark the slot inactive before calling
  `JS_FreeValue(...)`. This matters for object-wrap refs because freeing the
  strong JS value can synchronously run the wrapped object's finalizer, and that
  finalizer may call `napi_delete_reference(...)` on the same ref.
- Moved instance-data finalization out of `prepare_teardown()` for owned env
  release. `test_6` object finalizers call `napi_get_instance_data(...)`, and
  QuickJS can run those finalizers during `JS_FreeContext(...)` and the final
  `JS_FreeRuntime(...)` GC; the instance data must remain alive until after
  runtime finalizers have run.

## 2026-05-11 Reentrancy Audit

Action plan before code changes:

1. Scan QuickJS N-API paths that call user callbacks or QuickJS operations that
   can synchronously run finalizers: `JS_FreeValue(...)`, `JS_RunGC(...)`,
   `JS_FreeContext(...)`, `JS_FreeRuntime(...)`,
   `JS_DetachArrayBuffer(...)`, N-API finalizers, and env cleanup hooks.
2. Look for state that is cleared only after one of those calls, because a
   finalizer can re-enter N-API on the same thread before the outer operation
   finishes.
3. Fix only high-confidence cases with direct user callback/finalizer exposure.
4. Add focused regression coverage where the current N-API suite can observe
   the issue without depending on timing or multiple threads.

Initial findings:

- `napi_env__::prepare_teardown()` runs cleanup hooks while iterating the
  `env_cleanup_hooks_` vector. A cleanup hook can call
  `napi_remove_env_cleanup_hook(...)`, which can erase and destroy the current
  or a later entry while teardown still owns an iterator/entry pointer.
- `napi_env__::set_instance_data(...)` and `finalize_instance_data()` invoke the
  old instance-data finalizer while the old data/finalizer fields are still set.
  If that finalizer re-enters instance-data APIs, it can observe stale data or
  trigger duplicate finalization.
- `napi_ref__::rem_ref()` transitions a strong ref to weak by calling
  `JS_FreeValue(...)`. That can synchronously run a finalizer that deletes the
  same ref, so the outer unref path must not read or mutate the slot after the
  free call.

Implementation:

- Env cleanup teardown now pops a hook entry out of the vector before running
  the user hook. Reentrant removal of that same hook no longer finds it, and
  removal of a later hook cannot invalidate the teardown iterator.
- Instance-data replacement/finalization now snapshots and clears the old fields
  before invoking the user finalizer.
- `napi_ref__::rem_ref()` now snapshots the env/value/ref-count state and
  returns the local count after `JS_FreeValue(...)`, avoiding post-finalizer slot
  access.
- Added `test_instance_data` coverage where one cleanup hook removes another
  cleanup hook during env teardown. The removed hook aborts if it runs.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target \
  napi_quickjs_test_41_instance_data \
  napi_quickjs_test_6 \
  napi_quickjs_test_16_reference \
  napi_quickjs_test_37_reference_double_free -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_41_instance_data --gtest_filter=Test41InstanceData.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow --gtest_also_run_disabled_tests
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference --gtest_filter=Test16Reference.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free --gtest_filter=Test37ReferenceDoubleFree.PortedCoreFlow
make test-napi-quickjs-only
```

Results:

- The focused build passed.
- All four focused test binaries passed.
- `make test-napi-quickjs-only` passed 45/45.

## 2026-05-11 String And Symbol Value Dump Plan

Action plan before code changes:

1. Keep the existing slot and tag counters as aggregate diagnostics.
2. Add a separate compile-time flag for the heavier value-content dump, default
   off.
3. Use a separate 10-second content-dump cadence and the runtime
   `EDGE_TRACE_NAPI_LIFETIME_STATS=1` gate, while aggregate stats stay on their
   two-second cadence.
4. Capture only active `JS_TAG_STRING`, `JS_TAG_STRING_ROPE`, and
   `JS_TAG_SYMBOL` values from `napi_value__` and `napi_ref__`.
5. Split output by scope index and by owner kind, then collapse duplicates into
   `count=N value="..."` lines so repeated per-request values are visible.
6. Convert strings with `JS_ToCStringLen(...)`; convert symbols with
   `JS_ValueToAtom(...)` and `JS_AtomToCStringLen(...)`, because direct string
   conversion throws for symbols.
7. Escape control bytes and cap stored display text to keep periodic output
   usable.
8. Rebuild the existing `build-edge-quickjs-cli` cache with the new diagnostic
   flag on, and leave that cache in the diagnostic configuration.

Implementation notes:

- Added `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP`, default off.
- The new flag enables tag stats if needed; tag stats already enable periodic
  stats, and periodic stats enable the lifetime tracker.
- Active string/symbol values are counted in the lifetime tracker by
  `(scope_index, napi_value/napi_ref, tag, escaped value)`.
- Output lines use:

```text
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="Host"
[napi-lifetime-values] scope=0 napi_value tag=symbol count=1002 value="handle_onclose"
```

Verification:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
for i in {1..20}; do ab -n 50 -c 10 http://127.0.0.1:8080/ >/dev/null; sleep 1; done
```

The build succeeded. During the local server run the 10-second dumps showed
string/symbol content counts increasing with request churn:

```text
[napi-lifetime-stats] napi_value slots_total=67788 active=67788 napi_ref slots_total=2214 active=2206 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=545 string=3628 object=45003 int=4522 bool=1502 null=513 undefined=10557 float64=1519
[napi-lifetime-values] scope=0 napi_value tag=symbol count=502 value="handle_onclose"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="/"

[napi-lifetime-stats] napi_value slots_total=134840 active=134840 napi_ref slots_total=4214 active=4206 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=1045 string=7128 object=89529 int=9032 bool=3002 null=1023 undefined=21055 float64=3027
[napi-lifetime-values] scope=0 napi_value tag=symbol count=1002 value="handle_onclose"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="Host"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="127.0.0.1:8080"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="User-Agent"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="ApacheBench/2.3"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="Accept"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="*/*"
[napi-lifetime-values] scope=0 napi_value tag=string count=1000 value="/"
```

The cache was intentionally left with the diagnostic flags on.

## 2026-05-11 Tracker-Owned Value Extraction Correction

Action plan before code changes:

1. Remove string/symbol extraction helpers from `napi_value__` and `napi_ref__`.
2. Remove direct tag/string diagnostic macros from value/ref call sites.
3. Keep call-site instrumentation to lifetime record macros only:
   `NAPI_QUICKJS_LIFETIME_RECORD(create|destroy|update, ..., this, env_)`.
4. Add typed overloads on `napi_lifetime_tracker__` for `napi_value__` and
   `napi_ref__`, so C++ overload resolution routes value/ref slots through the
   diagnostic-aware tracker path.
5. Let the tracker read the slot's env, scope index, and `JSValue`, extract tag
   and string/symbol content internally, and maintain active per-slot snapshots
   so ref value changes can decrement the old value and increment the new value.
6. Restore periodic aggregate stats to the intended 2-second cadence.
7. Keep string/symbol value dumps on a separate 10-second cadence.
8. Rebuild the existing diagnostic cache and rerun a short local server/request
   sample.

Implementation notes:

- Removed create/destroy/update lifetime recording for value/ref slots. Because
  `napi_value__` and `napi_ref__` entries are owned by `napi_allocator__`
  vectors inside `napi_scope__`, the env scan is the source of truth.
- Removed the global active-value snapshot registry, per-scope tag/string
  counters, mutexes, atomics, and slot-delta accounting from
  `napi_lifetime_tracker.cc`.
- Added read-only allocator/scope/env iteration helpers so the tracker scans
  `napi_env__ -> scopes_ -> values_/refs_` whenever it dumps.
- The only periodic trigger is `NAPI_QUICKJS_LIFETIME_MAYBE_DUMP(env)` at
  scope/env ownership boundaries such as `wrap_value(...)`, `delete_value(...)`,
  `wrap_ref(...)`, `delete_ref(...)`, `close()`, and env scope
  create/destroy.
- Aggregate slot stats and tag breakdowns are computed fresh from active scopes
  at most every two seconds. String content lines are computed fresh from active
  slots at most every ten seconds.
- Symbol names/atoms are intentionally not materialized in the value-content
  dump; symbols remain visible only as tag counts.
- The build cache was intentionally left in diagnostic mode with
  `NAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON`,
  `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON`, and
  `NAPI_QUICKJS_ENABLE_LIFETIME_STRING_SYMBOL_DUMP=ON`.

## 2026-05-11 Native Callback Handle-Scope Investigation

Action plan before code changes:

1. Preserve the current vector-backed allocator, root-scope teardown, periodic
   stats, and string/value dump diagnostics as the baseline.
2. Confirm which callback direction is already scoped. In the current worktree,
   `napi_function__::trampoline` opens a temporary handle scope before invoking
   the underlying `napi_callback`, so JS-to-native callbacks are already
   covered.
3. Reproduce or sample the request path around `napi_scope__::wrap_value`,
   `napi_create_string_utf8`, `napi_get_named_property`,
   `napi_get_reference_value`, and HTTP/TCP native event callbacks.
4. Determine whether the repeated header/path strings are created before
   `napi_call_function(...)`. If so, a scope opened inside `napi_call_function`
   is too late to own those argument handles.
5. Identify the native-to-JS event boundary that should own temporary argument
   handles: TCP connection, stream read, HTTP parser callbacks, timers, and
   other `EdgeMakeCallback` / `EdgeAsyncWrapMakeCallback` entry paths.
6. Prefer one shared callback-scope guard at the Edge callback-dispatch layer if
   it can cover argument construction safely. If that is not possible, document
   the app/runtime-specific event guards required before changing broad N-API
   call semantics.
7. Treat return values separately from temporary arguments. Any result that must
   survive past the callback boundary must be consumed before the scope closes
   or explicitly escaped/duplicated into the parent scope.
8. Classify `napi_ref` growth separately. Persistent references live in the env
   root scope and should be deleted by their owners or finalizers; they are not
   automatically freed by local handle-scope closure.

Initial findings:

- The current `napi_function__::trampoline` already creates
  `quickjs_callback_handle_scope__` before invoking the native `napi_callback`.
  It also duplicates a non-null callback return value into a raw QuickJS result
  and deletes the temporary local handle before returning to QuickJS.
- `src/edge_http_parser.cc` creates the repeated request strings before
  entering JS: `BuildHeadersArray(...)` creates header field/value strings such
  as `Host`, `127.0.0.1:8080`, `User-Agent`, `ApacheBench/2.3`, `Accept`, and
  `*/*`; `ParserOnHeadersComplete(...)` creates the URL string such as `/`.
- Those strings are then passed as arguments to `EdgeMakeCallback(...)` /
  `EdgeMakeCallbackWithFlags(...)` or, in propagate-exception mode,
  `napi_call_function(...)`. Because the values are already wrapped by then, an
  automatic scope opened only inside `napi_call_function(...)` would not own
  them.
- The intended lifetime model for those request strings is a native callback
  local scope that opens before the parser/TCP/timer/stream event constructs
  N-API arguments and closes after the JS callback path has returned and any
  required task-queue checkpoint has run. Closing that scope should release the
  local `napi_value` handles for the header/path strings; JavaScript objects
  that stored the actual strings keep their own QuickJS references independently
  of the N-API wrapper handles.

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
for i in {1..12}; do ab -n 50 -c 10 http://127.0.0.1:8080/ >/dev/null; sleep 1; done
```

Result: build passed. The server run showed two-second scanner-derived
stats/tag output and a separate ten-second string-only value dump.
Representative lines:

```text
[napi-lifetime-stats] napi_value slots_total=67661 active=67661 napi_ref slots_total=2207 active=2199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=544 string=3628 object=44905 int=4512 bool=1502 null=513 undefined=10535 float64=1522
[napi-lifetime-tags] scope=0 napi_ref symbol=5 object=2191 undefined=3

[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="/"
[napi-lifetime-values] scope=0 napi_value singular_string_count=80
[napi-lifetime-values] scope=0 napi_ref singular_string_count=0
```

The direct helper names, old direct diagnostic macros, global snapshot state,
and mutex/atomic includes are absent from the tracker:

```sh
rg -n "NAPI_QUICKJS_LIFETIME_RECORD|record_create|record_destroy|record_update|record_allocator_slot_delta|NAPI_QUICKJS_LIFETIME_SLOT_DELTA|std::mutex|#include <mutex>|std::atomic|#include <atomic>|active_value_snapshots|tag_stats_by_scope|string_symbol_values_by_scope" napi/quickjs/src/internal/napi_lifetime_tracker.cc napi/quickjs/src/internal/napi_lifetime_tracker.h napi/quickjs/src/internal/napi_lifetime_macros.h
```

## 2026-05-11 Handle Representation And Trampoline RAII Update

Action plan before code changes:

1. Remove the temporary internal `napi_handle_scope__` and
   `napi_escapable_handle_scope__` wrapper classes.
2. Stop using the private `napi_scope_handle__ = void *` alias.
3. Use the public opaque N-API handle types,
   `napi_handle_scope` and `napi_escapable_handle_scope`, as encoded
   index-plus-one handles into `napi_env__::scopes_`.
4. Keep `napi_scope__` as the single internal scope payload; all QuickJS N-API
   scopes can support escaping.
5. Expose `napi_scope__ *scope_from_handle(napi_handle_scope scope) const` as
   the internal decode point instead of exposing current/root raw
   `napi_scope__ *` values.
6. Make `quickjs_callback_handle_scope__` in `napi_function.cc` the RAII owner
   for JS-to-native callback execution: create a child scope in the
   constructor, make it current, restore the parent in the destructor, and
   destroy the child scope.

Implementation notes:

- Deleted `napi_handle_scope.h/.cc` and `napi_escapable_handle_scope.h/.cc`
  from `napi/quickjs/src/internal` and removed those source files from
  `napi/quickjs/CMakeLists.txt`.
- `napi_env__` now returns `napi_handle_scope` from `root_scope()`,
  `current_scope()`, and `create_scope(...)`; scope payload access goes through
  `scope_from_handle(...)`.
- `napi_open_handle_scope(...)`, `napi_close_handle_scope(...)`,
  `napi_open_escapable_handle_scope(...)`, `napi_close_escapable_handle_scope(...)`,
  and `napi_escape_handle(...)` now operate on encoded scope handles. Escapable
  handles are represented by casting the same encoded `napi_handle_scope`
  value; the internal `napi_scope__` tracks whether it has already escaped.
- `quickjs_callback_handle_scope__` no longer depends on the deleted wrapper
  class. It creates a child scope from the current parent scope and closes it
  with `env_->destroy_scope(scope_)` on unwind.

LLDB evidence:

```text
breakpoint set --name 'napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*)'
run --gtest_filter=Test3.Ported
bt
```

showed JS calling a native N-API function through the QuickJS C function data
path:

```text
frame #0: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*)
frame #1: js_call_c_function_data
frame #2: JS_CallInternal
frame #8: napi_run_script
frame #12: Test3_Ported_Test::TestBody()
```

Ignoring the env-constructor root-scope allocation and breaking on scope create:

```text
breakpoint set --name 'napi_env__::create_scope(napi_handle_scope__*)'
breakpoint modify 1 --ignore-count 1
run --gtest_filter=Test3.Ported
bt
```

showed the callback frame opening inside the trampoline:

```text
frame #0: napi_env__::create_scope(napi_handle_scope__*)
frame #1: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*) + 140
frame #2: js_call_c_function_data
```

Breaking on scope destroy showed the matching close on the trampoline unwind
path:

```text
frame #0: napi_env__::destroy_scope(napi_handle_scope__*)
frame #1: napi_function__::trampoline(JSContext*, JSValue, int, JSValue*, int, JSValue*) + 768
frame #2: js_call_c_function_data
```

Verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
make build-napi-quickjs
make test-napi-quickjs-only
```

Results:

- Edge CLI build passed.
- Test-enabled N-API QuickJS build passed.
- `make test-napi-quickjs-only` passed, 45/45.

Request-load validation:

```sh
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
watch -n 1 ab -n 50 -c 10 http://127.0.0.1:8080/
```

The sandboxed listen failed with `EPERM`; rerunning the server and `watch` load
with localhost/network approval succeeded. After several `ab -n 50 -c 10`
batches, root-scope request strings still grew:

```text
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Host"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="127.0.0.1:8080"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="User-Agent"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="ApacheBench/2.3"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="Accept"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="*/*"
[napi-lifetime-values] scope=0 napi_value tag=string count=500 value="/"
```

Conclusion: the trampoline RAII frame is now implemented and verified for
JS-to-native N-API function calls, but it is not the lifetime boundary that owns
HTTP request header/path argument handles. Those strings are created in native
HTTP parser/server code before `napi_call_function(...)` enters JavaScript, so
they need a native event callback/request scope opened before argument
construction and closed after callback dispatch. `napi_ref` growth remains
separate; these root refs are persistent handles and must be classified by
owner/finalizer or explicit `napi_delete_reference(...)`, not by local
handle-scope closure.

## 2026-05-11 String And Symbol Value Dump Plan

Action plan:

1. Keep the periodic slot and tag counters separate from content dumping.
2. Add a new compile-time flag for string/symbol value content dumps so the
   potentially noisy string capture code is compiled out by default.
3. Reuse active value/ref slot lifecycle hooks, and only record content for
   `JS_TAG_STRING`, `JS_TAG_STRING_ROPE`, and `JS_TAG_SYMBOL`.
4. Split dump output by scope index and owner kind (`napi_value` versus
   `napi_ref`) so root-scope retention remains easy to identify.
5. Use QuickJS C-string conversion only while the underlying `JSValue` is known
   to be alive; store a bounded escaped copy in the tracker.
6. Print the captured string/symbol values on a separate 10-second cadence;
   aggregate stats remain on the two-second cadence.
7. Rebuild with the stats, tag-stats, and content-dump flags enabled and leave
   the build cache in that diagnostic state.

## 2026-05-11 QuickJS Tag Breakdown Plan

Action plan:

1. Keep the existing periodic slot stats gated behind
   `NAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS`.
2. Add a separate compile-time flag for QuickJS value/ref tag breakdowns so the
   additional counters are compiled out unless explicitly requested.
3. Count active `napi_value__` slots and active `napi_ref__` slots by
   `JS_VALUE_GET_TAG(...)`, using the QuickJS tag names from `quickjs.h`.
4. Update counts when a value/ref slot initializes, releases, or changes the
   retained `JSValue` to `JS_UNDEFINED` during weak/empty ref cleanup.
5. Print the tag breakdown alongside periodic stats. The current corrected
   implementation uses the two-second aggregate stats cadence.
6. Rebuild with stats and tag stats enabled, run a small smoke command, and run
   focused value/reference/handle-scope tests.

Implementation notes:

- Added `NAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS`, default `OFF`. Enabling it
  adds per-active-slot `JS_VALUE_GET_NORM_TAG(...)` accounting for
  `napi_value__` and `napi_ref__`.
- This first implementation printed periodic stats every 10 seconds; the later
  tracker-owned extraction correction restored aggregate stats and tag
  breakdowns to the intended two-second cadence.
- Tag stats are split by allocator-backed `napi_scope__` index, so output can
  distinguish root-scope retention from child-scope retention:

```text
[napi-lifetime-tags] scope=0 napi_value symbol=794 string=5378 object=67179 int=6781 bool=2252 null=771 undefined=15785 float64=2269
[napi-lifetime-tags] scope=0 napi_ref symbol=5 object=3191 undefined=3
```

Sample run:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DEDGE_NAPI_PROVIDER=quickjs \
  -DEDGE_BUILD_NAPI_TESTS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TAG_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 50 -c 10 http://127.0.0.1:8080/
```

Observed after driving repeated small `ab` batches for about 30 seconds:

```text
[napi-lifetime-stats] napi_value slots_total=34136 active=34136 napi_ref slots_total=1207 active=1199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=294 string=1878 object=22643 int=2269 bool=752 null=259 undefined=5285 float64=757
[napi-lifetime-tags] scope=0 napi_ref symbol=5 object=1191 undefined=3

[napi-lifetime-stats] napi_value slots_total=67678 active=67678 napi_ref slots_total=2207 active=2199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=544 string=3628 object=44914 int=4526 bool=1502 null=516 undefined=10535 float64=1514
[napi-lifetime-tags] scope=0 napi_ref symbol=5 object=2191 undefined=3

[napi-lifetime-stats] napi_value slots_total=101208 active=101208 napi_ref slots_total=3207 active=3199 napi_scope slots_total=3 active=1
[napi-lifetime-tags] scope=0 napi_value symbol=794 string=5378 object=67179 int=6781 bool=2252 null=771 undefined=15785 float64=2269
[napi-lifetime-tags] scope=0 napi_ref symbol=5 object=3191 undefined=3
```

Conclusion from this sample: retained values/refs are all in `scope=0`, the
root scope. The dominant retained value tag is `object`, followed by
`undefined`, `int`, `string`, and `float64`; refs are almost entirely `object`.

Ran loopback webserver smoke with elevated localhost bind permission:

```sh
PORT=3313 ./build-edge-quickjs-cli/edge tests/js/webserver.js
curl -sS http://127.0.0.1:3313/
curl -sS http://127.0.0.1:3313/again
```

Result: server printed `webserver listening on port 3313`; both requests
returned `hello`.

Remaining leak suspect after this change: `napi_external_backing_store_hint__`
still has live objects at teardown. That is no longer explained by
`napi_value__` or `napi_ref__` wrapper retention and should be investigated as a
separate QuickJS finalizer/external backing-store lifetime issue.

## 2026-05-11 Standalone N-API Segfault Regression Plan

User reported that running `make test-napi-quickjs` from
`/Users/sadhbh/src/dev/edgejs/napi` now produces 32 segfault failures, while the
root QuickJS CLI build/test path previously passed. This investigation should
work with the current vector-backed `napi_value__` / `napi_ref__` allocator
state and avoid reverting concurrent edits.

Action plan:

1. Reproduce from the `napi` subdirectory, then reduce to the first crashing
   binary/test: `napi_quickjs_test_2 --gtest_filter=Test2.Ported`.
2. Use LLDB on that exact test to prove where an encoded `napi_value` or
   `napi_ref` handle is still being treated as a direct pointer, or whether the
   allocator slot lookup collides across scopes/build harnesses.
3. Patch only the focused QuickJS N-API implementation path that bypasses the
   allocator decode layer, preserving scope-owned value slots, root-scope ref
   slots, free-list reuse, and root-scope teardown.
4. Verify the targeted test first, then run the `napi` subdirectory
   `make test-napi-quickjs`; run the root `make test-napi-quickjs-only` if
   time allows.

Findings and fix:

- The standalone 32-crash pattern was not an encoded handle collision. LLDB on
  `napi_quickjs_test_2 --gtest_filter=Test2.Ported` stopped in QuickJS runtime
  teardown: `JS_FreeRuntime(...)` finalized GC objects after `DestroyEnvInstance`
  had deleted `napi_env__`. External/wrap finalizers still carried `napi_env`
  pointers, so the env must stay alive until after `JS_FreeRuntime(...)`.
- After rebuilding the root harness with `CMAKE_BUILD_TYPE=Debug`, the remaining
  root crashes reduced to Test6 and Test33. Test6 stopped in
  `napi_delete_reference(...) -> napi_scope__::delete_ref(...)` from
  `MyObject::~MyObject`, called by a QuickJS finalizer after `root_scope_` had
  already been destroyed. The root scope now closes allocator slots first, runs a
  GC pass while the root-scope owner still exists, then frees the scope storage;
  a late `napi_delete_reference(...)` after root teardown is treated as an
  idempotent cleanup.
- Test33 stopped in `js_free_rt(rt=0x12004, ptr=hint)` from
  `napi_external_backing_store_hint__::destroy(...)`. The bad runtime pointer
  was stale hint memory: QuickJS calls an ArrayBuffer free callback on
  `JS_DetachArrayBuffer(...)`, then can call it again when the detached
  ArrayBuffer object finalizes. External ArrayBuffer hints now keep their hint
  object alive across detach, invoke the user finalizer only once, and destroy
  the hint on the final object free path using the `JSRuntime*` passed by
  QuickJS.
- Escapable handle ownership was reviewed while checking the allocator model:
  `escape_value(...)` wraps the inner `JSValue` into the parent scope with
  `owned=false`, and `napi_value__::initialize(..., owned=false)` performs the
  `JS_DupValue(...)`. The child scope later releases its own allocator slot, so
  the escaped parent slot does not borrow freed storage. A future allocator
  `move_to(...)` helper could reduce the temporary duplicate, but the current
  duplicate-and-release behavior is logically safe.

Verification:

```text
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 --gtest_filter=Test6.PortedCoreFlow
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_33_typedarray --gtest_filter=Test33TypedArray.PortedCoreFlow
CMAKE_BUILD_TYPE=Debug make test-napi-quickjs
(cd /Users/sadhbh/src/dev/edgejs/napi && CMAKE_BUILD_TYPE=Debug make test-napi-quickjs)
```

Both full suites reported 45/45 passing.

## LLDB Breakpoints And Calls

Useful breakpoints:

```text
breakpoint set -n napi_quickjs_lifetime_dump
breakpoint set -n napi_scope__::wrap_value
breakpoint set -n napi_value__::create
breakpoint set -n napi_ref__::create
breakpoint set -n napi_external_backing_store_hint__::create
breakpoint set -n napi_env__::~napi_env__
```

Useful LLDB expression while stopped:

```text
expr napi_quickjs_lifetime_dump("after request")
```

## Node/V8 Lifetime Comparison

Node's V8 backend does not allocate a C++ `napi_value__` wrapper per returned
value. `node/src/js_native_api_v8.h` asserts that `v8::Local<v8::Value>` and
`napi_value` are one pointer wide, then converts with
`reinterpret_cast<napi_value>(*local)`. Rehydration copies that pointer back into
a stack `v8::Local<v8::Value>`.

For older/indirect V8 locals, that pointer is the local handle slot. In that
mode, `v8::LocalBase<T>::New(...)` calls `v8::HandleScope::CreateHandle(...)`;
the internal implementation takes `isolate->handle_scope_data()->next`, extends
the handle block if `next == limit`, advances `next`, writes the tagged value
into the slot, and returns the slot address. Closing a V8 handle scope restores
the previous `next`/`limit`, so all local slots created inside that scope become
invalid as a group.

Modern V8 also has a direct-handle path. Many API implementations in
`node/deps/v8/src/api/api.cc` allocate JS heap objects through the factory as
`DirectHandle`s, for example `v8::Object::New(...)`, `v8::Array::New(...)`,
`v8::Number::New(...)`, and `String::NewFrom*`. They then return public
`Local<T>` values through `Utils::ToLocal(...)` /
`Utils::Convert(...)`. With `V8_ENABLE_DIRECT_HANDLE`, `Utils::Convert(...)`
returns `Local<T>::FromAddress(obj.address())`, so no local handle slot is
allocated for that conversion. Without direct handles, the same conversion uses
`Local<T>::FromSlot(indirect_handle(obj).location())`, which routes through the
handle-scope slot machinery above. Node's bundled V8 defaults direct handles to
the conservative-stack-scanning setting; `node/common.gypi` sets
`v8_enable_conservative_stack_scanning` to `0` by default, so exact behavior is
build-configuration dependent.

Node-owned allocations are therefore concentrated in the surrounding lifetime
objects:

- `napi_handle_scope` and `napi_escapable_handle_scope` are `new`-allocated
  wrappers around stack-like V8 handle scopes, then deleted on close.
- `napi_ref` is a real `Reference` object that owns a V8 persistent handle and
  links into the env reference lists; `napi_get_reference_value(...)` creates a
  fresh local handle slot from that persistent.
- Function callback arguments, `this`, `new.target`, return values from V8
  factory/property/call APIs, and escaped handles are all surfaced as borrowed
  local handle slots rather than per-value heap wrappers.

This is the main design gap for QuickJS tracing: `napi_value__` creation in the
QuickJS backend is closer to allocating per-value handles. If those handles live
in the env root scope, the backend behaves more like an always-open V8 handle
scope whose cursor never rewinds.

## QuickJS Scope Model

The QuickJS backend has a scope stack, but it is implemented differently from
V8's local handle blocks. `napi_env__` creates one `root_scope_` during env
construction and initializes `current_scope_` to that root. Opening a handle
scope allocates a `napi_handle_scope__` with `parent = current_scope_`, then
makes it current. Closing requires that the supplied scope is exactly the
current scope, restores `current_scope_` to `scope->parent()`, and destroys the
scope.

Each scope owns vector-backed slot allocators:

```c++
napi_allocator__<napi_value__> values_;
napi_allocator__<napi_ref__> refs_;
```

Public `napi_value` and `napi_ref` handles are encoded slot indexes rather than
direct wrapper addresses. `napi_scope__::wrap_value(...)` initializes an active
value slot in the current scope; `napi_scope__::wrap_ref(...)` initializes an
active ref slot, with persistent refs allocated from the root scope. Releasing a
handle marks the slot inactive and places its index on the allocator free list.
Closing a scope releases active slots in reverse order, clears the vectors, and
clears the free lists.

Escapable scopes duplicate the underlying QuickJS value into the parent scope:
`escape_value(...)` calls `parent_->wrap_value(value->get_inner(), false)`.
That creates a separate parent-scope `napi_value__` with its own
`JS_DupValue(...)`; closing the child then frees the child wrapper without
invalidating the escaped parent wrapper.

Callback invocation currently does not open an automatic temporary N-API handle
scope. `napi_function__::trampoline(...)` stack-allocates `napi_callback_info__`
and invokes the native callback directly. Calls such as `napi_get_cb_info(...)`
wrap callback arguments and `this` into `env->current_scope()`. If user/native
code has not opened a handle scope, those wrappers land in `root_scope_`.

The root scope is destroyed during environment teardown in the current
vector-backed implementation. That releases root-owned value/ref slots before
the env teardown completes; remaining teardown failures should be treated as
QuickJS GC/finalizer or external backing-store lifetime issues, not as the old
root-scope wrapper retention bug.

## 2026-05-11 Server Stats Growth Findings

Reproduced the reported shape with the native QuickJS CLI and the local
`server.js`:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
PORT=3312 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 5000 -c 10 http://127.0.0.1:3312/
```

Before adding any callback scope experiment, periodic stats climbed during
request traffic from roughly:

```text
napi_value slots_total=11733 active=11733 napi_ref slots_total=196 active=196
napi_value slots_total=487814 active=487814 napi_ref slots_total=8211 active=8203
napi_value slots_total=1677931 active=1677931 napi_ref slots_total=28211 active=28203
```

The primary value growth is temporary N-API handle creation in native event
entry paths while `env->current_scope()` is still the env root scope. LLDB stack
samples from a single request showed:

```text
OnConnection
  EdgeStreamBaseGetWrapper
  napi_get_reference_value
  napi_scope__::wrap_value

OnConnection
  napi_get_named_property(..., "onconnection")
  napi_scope__::wrap_value

OnConnection
  EdgeStreamBaseMakeInt32
  napi_create_int32
  napi_scope__::wrap_value
```

At the `wrap_value(...)` breakpoint in these stacks:

```text
this == env->root_scope()
this->parent() == nullptr
env->current_scope() == env->root_scope()
```

This means the large `napi_value active == slots_total` growth is not mainly
QuickJS heap values leaking from JavaScript function calls. It is QuickJS N-API
handle wrappers for normal native operations such as reference lookup, property
access, and small integer/value creation being allocated into the always-open
root scope.

An internal temporary scope around `napi_function__::trampoline(...)` does open
and close around JS-to-native callback bodies. LLDB confirmed the scope is
created and destroyed for the `TcpCtor` callback during `napi_new_instance(...)`.
However, that does not cover the earlier native libuv entry work in
`OnConnection(...)`, so it is insufficient as a complete server-growth fix.

Ref growth is a separate but related signal. LLDB samples showed persistent refs
created for per-connection wrappers and active-resource tracking:

```text
napi_wrap
  TcpCtor
  napi_create_reference

Environment::RegisterActiveHandle("TCPSocketWrap")
  EdgeStreamBaseSetWrapperRef
  napi_create_reference
```

Deletes were also observed on request cleanup paths:

```text
FreeWriteReq
  EdgeUnregisterActiveRequestToken
  Environment::UnregisterActiveRequest
  napi_delete_reference
```

So some `napi_ref` churn is expected live socket/request ownership, but the
value-slot growth is root-scope temporary handle retention.

The vector-backed allocator's reserved-prefix scheme was also checked while
experimenting with automatic callback scopes. Materializing parent prefixes in
child scopes makes each callback scope expensive once the root has many slots.
The safer shape is a logical base index for child scopes, so child handles do
not collide with parent handles without allocating or scanning inactive prefix
entries.

Current conclusion: the right fix is to open short-lived handle scopes around
native event-entry / libuv callback processing that calls N-API before entering
JS, or to add an equivalent backend-owned entry scope for those EdgeJS runtime
boundaries. A trampoline-only scope is useful but does not address
`OnConnection(...)` and similar native paths.

Verification after the investigation:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free
env -u CPPFLAGS -u LDFLAGS \
  ./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_6 \
  --gtest_filter=Test6.PortedCoreFlow
```

All of the direct targeted tests passed. `make test-napi-quickjs-only` was run
twice and reported 44/45 passing both times, with
`napi_quickjs_test_6.Test6.PortedCoreFlow` marked failed by CTest
(`SEGFAULT` once, `SIGTRAP` once) even though the test's own output showed
`PASSED` and direct reruns of that test passed. Treat that as a separate
intermittent CTest/process-exit issue unless it reproduces under direct LLDB.

## 2026-05-11 Scope Handle Allocator Plan

Action plan:

1. Keep the existing vector-backed value/ref allocator behavior intact.
2. Add an internal opaque `napi_scope_handle__` for env-owned scope identity,
   backed by `napi_allocator__<napi_scope__>` rather than raw scope pointers.
3. Store `root_scope_` and `current_scope_` in `napi_env__` as scope handles,
   and resolve them through env helpers when N-API code needs the underlying
   scope object.
4. Preserve public `napi_handle_scope` and `napi_escapable_handle_scope`
   semantics; these may continue to be the concrete public handles returned to
   callers while env bookkeeping uses the allocator-backed internal handle.
5. Extend periodic stats so scopes report total created and active live counts
   alongside value/ref slot totals.
6. Rebuild and rerun focused handle-scope/function/reference tests, plus the
   already-built QuickJS N-API suite if practical.

Implementation notes:

- `napi_scope_handle__` is now an internal opaque handle type.
- `napi_env__::root_scope()` and `napi_env__::current_scope()` return
  `napi_scope_handle__`; code that needs the underlying scope slot resolves it
  through `root_scope_value()`, `current_scope_value()`, or
  `scope_from_handle(...)`.
- `napi_env__` owns a `napi_allocator__<napi_scope__>` for all base scope slots.
  The root scope and current scope are allocator handles, not raw
  `napi_scope__ *` fields.
- Public `napi_handle_scope__` and `napi_escapable_handle_scope__` remain stable
  public handle objects, but each owns an internal allocator-backed scope handle.
- `napi_allocator__::close()` now resets its logical base index so reused scope
  slots do not inherit stale child-scope prefix offsets.
- Periodic stats now print scope slot totals alongside value/ref slot totals:

```text
[napi-lifetime-stats] napi_value slots_total=595 active=595 napi_ref slots_total=196 active=196 napi_scope slots_total=3 active=1
```

Server smoke with allocator-backed scopes:

```sh
PORT=3314 EDGE_TRACE_NAPI_LIFETIME_STATS=1 ./build-edge-quickjs-cli/edge server.js
ab -n 5000 -c 10 http://127.0.0.1:3314/
```

Observed scope slots stayed bounded during the run:

```text
napi_scope slots_total=3 active=1
napi_scope slots_total=3 active=1
napi_scope slots_total=3 active=1
```

Verification:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=ON \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=ON
cmake --build build-edge-quickjs-cli --target edge -j4
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_36_handle_scope
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_15_function
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_16_reference
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_37_reference_double_free
make test-napi-quickjs-only
```

Focused tests passed, and the full already-built QuickJS N-API suite reported
45/45 passing.

The build cache was then restored to the default lifetime flags:

```sh
cmake -S . -B build-edge-quickjs-cli \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_TRACKER=OFF \
  -DNAPI_QUICKJS_ENABLE_LIFETIME_PERIODIC_STATS=OFF
cmake --build build-edge-quickjs-cli --target edge -j4
```

The default-off build succeeded. The focused handle-scope, function, reference,
and reference double-free tests also passed against that build. A subsequent
default-off full rerun passed as well:

```sh
make test-napi-quickjs-only
```

Result: 45/45 tests passed.

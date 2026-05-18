# Next App: `entryCSSFiles` work store async context

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by preserving QuickJS async-function continuation frames through `await`. |
| **Severity** | High | Dynamic Next routes failed with a 500 unless request-scoped work store survived promise/microtask boundaries. |

## Symptom

Running the private Next.js app with the native QuickJS-backed Edge CLI reaches
`next start`, but request rendering repeatedly fails:

```text
Error [InvariantError]: Invariant: Cannot access "entryCSSFiles" without a work store.
    at new b (.next/server/chunks/ssr/7211d_next_dist_d6caa501._.js:3:2526)
    at get (.next/server/chunks/ssr/src_ImperfectProtocol_private-poker_223478e5._.js:3:14063)
    at apply (null)
    at runMicrotasks (null)
```

Reproduction:

```sh
cd /Users/sadhbh/src/ImperfectProtocol/private-poker
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge npm run start
```

The earlier SWC Buffer issue is separate and remains fixed. This failure points
at Next's request `AsyncLocalStorage` work store being unavailable during a
promise/microtask continuation.

## Initial Finding

The expected fix belongs in QuickJS promise and async-context propagation, not
in app code or Next-specific shims. Existing promise-hook work moved hook,
rejection, microtask, and continuation-preserved embedder data behavior into
`napi_promises__`, but this app is a stronger integration test than the current
native suite.

Likely risk areas:

- promise hooks are attached to the env but not applied exactly when Next's
  async hooks setup expects them;
- continuation-preserved embedder data is captured on the wrong promise identity
  or released too early for chained reactions;
- QuickJS job draining enters the callback through `runMicrotasks` without the
  request frame restored;
- Node's JavaScript `AsyncLocalStorage` implementation may rely on a V8-shaped
  promise hook detail not covered by the current N-API promise tests.

## Root Cause

`next start` exposes the loss through
`workAsyncStorage.getStore()` returning `undefined` while Next accesses the
proxied `entryCSSFiles` manifest. A focused reproduction showed that the work
store survived `Promise.resolve().then(...)`, `setImmediate(...)`, and
`process.nextTick(...)`, but was lost after `await`:

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge --async-context-frame -e "require('next/dist/server/node-environment'); const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external'); async function f(){ await 0; console.log('await', workAsyncStorage.getStore()?.route); } workAsyncStorage.run({route:'/x'}, () => f());"
```

The vendored QuickJS promise hook support already had
`js_promise_function_promise(...)` and `js_promise_reaction_promise(...)` to
recover the promise identity associated with resolving functions and async
function resume objects. The remaining gap was in `promise_reaction_job(...)`:
async/await can place the `JS_CLASS_ASYNC_FUNCTION_RESOLVE` continuation in the
reaction `handler`, while both resolving function slots are intentionally
`undefined` because QuickJS avoids creating the thrownaway capability.

The fix teaches `promise_reaction_job(...)` to also inspect `handler` with
`js_promise_reaction_promise(...)` before emitting `JS_PROMISE_HOOK_BEFORE`.
The N-API promise subsystem now keeps captured continuation frames until the
promise resolves, releasing rejected-promise frames from the rejection tracker.

## Implemented Fix

- Kept runtime promise hook wiring inside `napi_promises__`.
- Added a QuickJS `promise_reaction_job(...)` fallback from resolving funcs to
  the async-function `handler`.
- Deferred continuation-frame cleanup from `AFTER` to settle/rejection paths so
  multi-`await` async functions keep their request frame across each resume.
- Added native regressions for ordinary promise reactions and two consecutive
  `await` resumptions preserving `continuation_preserved_embedder_data`.

## Verification

```sh
ctest --test-dir /Users/sadhbh/src/dev/edgejs/build-napi-quickjs --output-on-failure -R 'napi_quickjs\.napi_quickjs_test_35_promise'
```

Result: 5/5 passing.

```sh
cd /Users/sadhbh/src/dev/edgejs/napi
make test-native-quickjs
```

Result: 67/67 passing.

```sh
cd /Users/sadhbh/src/ImperfectProtocol/private-poker
PORT=3113 /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge npm run start
curl -i http://127.0.0.1:3113/lobby/1
```

Result: `HTTP/1.1 200 OK`; the previous `entryCSSFiles` work-store invariant no
longer appears. The server still logs unrelated remote fetch failures ending in
`ReferenceError: WebAssembly is not defined`, but those do not cause this route
to return 500.

## Debug Teardown Follow-Up

After the promise fix, a Debug `edge -e "console.log('hi')"` run still tripped
QuickJS `JS_FreeRuntime(...)` teardown. Enabling the QuickJS object leak dump
showed one remaining object:

```text
Object { importModuleDynamically: [AsyncFunction ...], callbackReferrer: [NapiExternal ...] }
```

LLDB showed this came from the JS ESM `moduleRegistries` WeakMap entry created
for `ContextifyScript` dynamic import callbacks. The fix stays native-side:

- `napi_module_wrap__` now unregisters temporary script dynamic-import referrer
  symbols after `napi_contextify__::run_script(...)` finishes.
- Edge's `ContextifyScript` wrapper now stores the host-defined option symbol in
  a native record, restores it onto the JS wrapper only while a script is
  running, then clears the JS properties after the run. This breaks the
  `registry -> callbackReferrer -> host_defined_option_symbol -> registry`
  retention cycle before env teardown without changing `edgejs/lib`.
- Env cleanup detaches tracked `ContextifyScript` native records and drops their
  `napi_ref`s before the QuickJS runtime is freed.

Verification:

```sh
cmake --build /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug --target edge -j4
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge -e "console.log('hi')"
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge -e "import('node:fs').then(m => console.log(typeof m.readFile))"
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli-debug/edge --experimental-vm-modules -e "const vm=require('vm'); const s=new vm.Script('import(\"node:fs\").then(m=>globalThis.n=(globalThis.n||0)+(typeof m.readFile===\"function\"))', { importModuleDynamically: (x)=>import(x) }); s.runInThisContext(); s.runInThisContext(); setImmediate(()=>console.log(globalThis.n));"
```

Results: the Debug teardown assertion no longer reproduces; the dynamic import
smokes print `function` and `2`.

```sh
cd /Users/sadhbh/src/dev/edgejs/napi
make test-native-quickjs
```

Result: 67/67 passing.

Release route verification after the native-only leak fix:

```sh
cd /Users/sadhbh/src/ImperfectProtocol/private-poker
PORT=3020 HOSTNAME=127.0.0.1 /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge npm run start
node -e "fetch('http://127.0.0.1:3020/lobby/1').then(async r=>{const t=await r.text(); console.log(r.status, r.headers.get('content-type')); console.log(t.slice(0,200));})"
```

Result: `200 text/html; charset=utf-8`.

## Original Action Plan

1. Add or strengthen a local regression that uses `AsyncLocalStorage` across an
   ordinary promise reaction and verifies the store is visible inside the
   reaction after the outer store changes.
2. Compare current `napi_promises__` behavior with `unofficial_napi.ref.cc`,
   keeping the refactored ownership model but importing any missing promise
   context behavior.
3. Rebuild the native QuickJS Edge CLI and rerun the focused
   `AsyncLocalStorage` smoke:

   ```sh
   ./build-edge-quickjs-cli/edge --async-context-frame -e "const { AsyncLocalStorage } = require('async_hooks'); const als = new AsyncLocalStorage(); als.run(123, () => Promise.resolve().then(() => console.log('als', als.getStore())));"
   ```

4. Rerun the private Next app startup/request smoke:

   ```sh
   cd /Users/sadhbh/src/ImperfectProtocol/private-poker
   PORT=3100 /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge npm run start
   ```

5. Update this issue with the exact route(s), status codes, and any remaining
   caveats after verification.

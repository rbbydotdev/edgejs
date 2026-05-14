# Next config SWC options Buffer rejected by N-API

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by deriving QuickJS N-API Buffer detection from the JS Buffer prototype. |
| **Severity** | High | Blocks `next start` before the app can finish loading `next.config.ts`. |

## Symptom

Running the private Next.js app with the native QuickJS-backed Edge CLI now gets
past `require("inspector")`, but fails while loading `next.config.ts`:

```text
⨯ Failed to load next.config.ts, see more info here https://nextjs.org/docs/messages/next-config-error
Error: Failed to get Buffer pointer and length
    at transform (null) {
  code: 'InvalidArg'
}
Unhandled Rejection: undefined
```

Reproduction:

```sh
cd /Users/syrusakbary/Development/private-poker
PORT=3100 /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge npm run start
```

A narrower reproduction is:

```sh
cd /Users/syrusakbary/Development/private-poker
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge -e '
(async () => {
  const { loadBindings } = require("./node_modules/next/dist/build/swc");
  const bindings = await loadBindings();
  const opts = {
    jsc: { parser: { syntax: "typescript" }, paths: { "@/*": ["./*"] }, baseUrl: process.cwd() },
    module: { type: "commonjs" },
    isModule: "unknown",
    env: { targets: { node: process.versions.node || "20.19.0" } }
  };
  await bindings.transform(require("fs").readFileSync("next.config.ts", "utf8"), opts);
})();
'
```

This fails with the same `InvalidArg` / `Failed to get Buffer pointer and length`
message. The same wrapped call succeeds under Node.

## Current Finding

The failing call is not in the app's config logic. It is in Next's SWC wrapper:

```js
// node_modules/next/dist/build/swc/index.js
function toBuffer(t) {
  return Buffer.from(JSON.stringify(t));
}

return bindings.transform(isModule ? JSON.stringify(src) : src, isModule, toBuffer(options));
```

The error string exists in
`node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node`, so the native
addon is calling `napi_get_buffer_info()` on the third argument, which is the JS
`Buffer.from(JSON.stringify(options))`.

QuickJS originally had two Buffer identities:

- JavaScript sees `Buffer.from(...)` as a Buffer.
- The QuickJS N-API layer only accepted native-created values recorded by the
  N-API backend.

That leaves JS-created Buffers, including Next's `toBuffer(options)`, looking
valid to JS but invalid to `napi_get_buffer_info()`.

## Fix

Implemented QuickJS Buffer identity inside the N-API backend without a
Buffer-specific unofficial API:

- QuickJS lazily reads the canonical `globalThis.Buffer.prototype` once it is
  available during normal bootstrap and caches that prototype in the env.
- `napi_is_buffer()` reports a value as a Buffer only when it is a typed-array
  view whose prototype chain reaches the cached Buffer prototype, or when it is
  a native-created pre-bootstrap buffer still tracked by the env.
- N-API-created QuickJS buffers adopt the cached Buffer prototype once it is
  available; buffers created before bootstrap continue to work through the env
  tracking path until their prototype can be updated.
- `internalBinding("buffer").setBufferPrototype(Buffer.prototype)` remains only
  an Edge bootstrap/lifetime helper and no longer drives QuickJS N-API Buffer
  identity.

The fix intentionally does not make every `Uint8Array` a Buffer.

Owner files:

- `napi/quickjs/CMakeLists.txt`
- `napi/quickjs/src/internal/napi_buffer.h`
- `napi/quickjs/src/internal/napi_buffer.cc`
- `napi/quickjs/src/internal/napi_external.h`
- `napi/quickjs/src/internal/napi_external.cc`
- `napi/quickjs/src/internal/napi_env.h`
- `napi/quickjs/src/internal/napi_env.cc`
- `napi/quickjs/src/js_native_api_quickjs.cc`
- `napi/tests/runners/test_21_general.cc`
- `src/edge_buffer.cc`

## Plan

1. Keep the env-owned Buffer prototype identity in QuickJS instead of restoring
   marker properties on JS objects or adding a Buffer-specific unofficial API.
2. Cache the first real `globalThis.Buffer.prototype` seen after bootstrap and
   keep that identity stable even if user code later replaces `globalThis.Buffer`.
3. Keep `napi_get_buffer_info()` backed by QuickJS typed-array APIs, with
   `napi_invalid_arg` preserved for plain objects, plain `ArrayBuffer`, and
   plain `Uint8Array`.
4. Keep regression coverage for JS-created `FastBuffer` values, sliced buffers,
   zero-length buffers, plain typed-array negatives, global `Buffer`
   replacement, and native-created buffers before and after the global Buffer
   prototype is available.

## Risks

- Treating all typed arrays as Buffers would be too broad and could break addons that rely
  on Node's `Buffer` versus `Uint8Array` distinction.
- Observing the Buffer prototype too late would leave native-created buffers
  without Buffer methods. The QuickJS env therefore tracks pre-bootstrap native
  buffers and updates their prototype when the global Buffer prototype is first
  seen.
- The later code 139 observed after one server run may be a separate unhandled
  rejection or teardown issue. It should be rechecked after the Buffer
  compatibility fix, but should not be folded into this change unless it still
  reproduces.

## Verification

Passed:

```sh
cmake --build build-edge-quickjs-cli-napi --target napi_quickjs_test_21_general -j4
ctest --test-dir build-edge-quickjs-cli-napi --output-on-failure -R 'napi_quickjs_test_21_general'
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs
```

`make test-napi-quickjs` result: 52/52 QuickJS N-API tests passed.

Passed focused SWC config transform reproduction:

```sh
cd /Users/syrusakbary/Development/private-poker
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge -e '/* loadBindings().transform(next.config.ts, options) */'
```

Result:

```text
swc-transform-ok
```

Passed Next startup/root-route smoke with the rebuilt CLI:

```sh
cd /Users/syrusakbary/Development/private-poker
PORT=3100 /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge npm run start
curl -s -o /dev/null -w '/ %{http_code}\n' http://127.0.0.1:3100/
```

Result:

```text
/ 200
```

Known separate failure still observed on a dynamic route:

```text
/tables/abc 500
Invariant: Cannot access "entryCSSFiles" without a work store.
```

Passed `next.config.ts` transpile path:

```sh
cd /Users/syrusakbary/Development/private-poker
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge -e '/* transpileConfig(...) */'
```

Passed full `next start` smoke; the server reached Ready:

```sh
cd /Users/syrusakbary/Development/private-poker
PORT=3100 /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge npm run start
```

Passed focused and full QuickJS N-API suites from a test-configured build:

```sh
cmake -S . -B build-edge-quickjs-cli-napi -DCMAKE_BUILD_TYPE=Debug -DEDGE_NAPI_PROVIDER=quickjs -DEDGE_BUILD_NAPI_TESTS=ON
cmake --build build-edge-quickjs-cli-napi --target napi_quickjs_test_21_general -j4
ctest --test-dir build-edge-quickjs-cli-napi --output-on-failure -R 'napi_quickjs\.napi_quickjs_test_21_general'
cmake --build build-edge-quickjs-cli-napi -j4
ctest --test-dir build-edge-quickjs-cli-napi --output-on-failure -R '^napi_quickjs\.'
```

Result: `49/49` QuickJS N-API tests passed.

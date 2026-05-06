# Next App Standalone: `require("v8")` / Serdes Findings

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | QuickJS serdes constructors implemented and verified. |
| **Severity** | High | The Next standalone server cannot start until the v8 serdes surface is handled. |

## Context

The `next-app` project was switched to the standard Next.js standalone output:

- `next.config.ts` uses `output: "standalone"`.
- The standalone build emits `.next/standalone/server.js`.
- Node can run the standalone server directly.
- The old custom server/router scripts are no longer part of the intended path.

The failing Edge QuickJS repro copied the standalone output into a test folder:

```sh
cp -rf ./.next/standalone ./.testing/app/
cd ./.testing
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge ./app/server.js
```

The failure looked like:

```text
undefined[Error: Failed to execute builtin 'internal/main/run_main_module':
    at normalizeRequirableId (<input>:302:35)
    at <anonymous> (<input>:1367:43)
    ...
]

Node.js v24.13.2
```

## Reduction

The standalone server failure reduces to loading Next's normal startup module:

```js
require("next/dist/server/lib/start-server")
```

Tracing module resolution showed the failing dependency was the public builtin:

```js
require("v8")
```

The smaller reproducer is:

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge /private/tmp/edge-repro-v8.js
```

with `/private/tmp/edge-repro-v8.js` containing:

```js
require("v8");
```

## LLDB Findings

Breaking at `TakePendingExceptionInfo` only showed Edge's final wrapped top-level exception:

```text
Error: Failed to execute builtin 'internal/main/run_main_module'
```

Breaking earlier in `DescribeAndClearPendingException(...)`, before the native main-builtin wrapper rewrites the error, revealed the original exception:

```text
TypeError: cannot read property 'prototype' of undefined
```

The source location corresponds to `lib/v8.js`:

```js
Serializer.prototype._getDataCloneError = Error;
```

So `require("v8")` is not failing because the `v8` builtin is missing. It is failing because:

- `lib/v8.js` loads `internalBinding("serdes")`.
- It destructures `{ Serializer, Deserializer }` from that binding.
- On QuickJS, `Serializer` is currently `undefined`.
- The first access to `Serializer.prototype` throws.

## Code Evidence

The V8 backend creates real serializer/deserializer constructors in:

```text
napi/v8/src/unofficial_napi.cc
```

around `unofficial_napi_create_serdes_binding(...)`, where it exports:

- `Serializer`
- `Deserializer`

The QuickJS backend currently returns an empty object:

```text
napi/quickjs/src/unofficial_napi.cc
```

```cpp
napi_status NAPI_CDECL unofficial_napi_create_serdes_binding(napi_env env,
                                                             napi_value *result_out)
{
    if (!CheckEnv(env) || result_out == nullptr)
        return napi_invalid_arg;
    return WrapOwned(env, JS_NewObject(Ctx(env)), result_out);
}
```

That empty binding explains the exact LLDB exception.

## Impact On Standalone Next

Next's standalone server imports `v8` from:

```text
.next/standalone/node_modules/next/dist/server/lib/start-server.js
```

The observed usage is heap telemetry:

```js
v8.getHeapStatistics()
```

So the app-level standalone build is valid and works under Node. The blocker is
Edge QuickJS compatibility with Node's `v8` builtin, specifically the incomplete
QuickJS `serdes` internal binding.

## Likely Runtime Fix

Implement a minimal QuickJS-backed `internalBinding("serdes")` that exports
stable `Serializer` and `Deserializer` constructors.

For the immediate Next standalone path, it may be enough that `require("v8")`
loads cleanly and `getHeapStatistics()` continues to work. Full
`v8.serialize()` / `v8.deserialize()` behavior can be added using the existing
QuickJS structured clone helpers based on `JS_WriteObject` /
`JS_ReadObject`.

Candidate implementation area:

```text
napi/quickjs/src/unofficial_napi.cc
```

Relevant existing helpers:

- `unofficial_napi_serialize_value(...)`
- `unofficial_napi_deserialize_value(...)`
- `JS_WriteObject(...)`
- `JS_ReadObject(...)`

## Current Conclusion

The `next-app` standalone setup itself is correct. The failure under Edge
QuickJS is caused by `require("v8")` loading `lib/v8.js`, which assumes
`internalBinding("serdes").Serializer` exists. QuickJS currently returns an
empty serdes binding, so the builtin throws before Next's standalone server can
start.

## Resolution

`napi/quickjs/src/unofficial_napi.cc` now exports QuickJS-backed `Serializer`
and `Deserializer` constructors from `internalBinding("serdes")`. Native and
WASIX smoke tests verified that `require("v8")` loads and that
`v8.serialize()` / `v8.deserialize()` can round-trip a plain object.

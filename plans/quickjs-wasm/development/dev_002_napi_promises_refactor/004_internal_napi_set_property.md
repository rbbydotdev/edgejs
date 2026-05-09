# Internal N-API Set Property Refactor

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Property setting logic lives in `napi_set_property`; native QuickJS tests pass. |
| **Severity** | Medium | Property assignment differences can surface as observable N-API behavior. |

## Scope

Property setting logic lives in:

```text
napi/quickjs/src/internal/napi_set_property.h
napi/quickjs/src/internal/napi_set_property.cc
```

`js_native_api_quickjs.cc` delegates to this focused internal helper.

## Verification

Run from `/Users/sadhbh/src/dev/edgejs/napi`:

```sh
make test-native-quickjs
```

## Current State

Updated `napi/quickjs/src/js_native_api_quickjs.cc` to include the new internal
header and updated `napi/quickjs/CMakeLists.txt` to compile
`src/internal/napi_set_property.cc`.

A source search under `napi/quickjs/src` and `napi/quickjs/CMakeLists.txt` only
finds the new internal helper path and the `napi_set_property` public entry
point.

Updated the fallback mechanism to avoid matching QuickJS exception text. After
`JS_SetProperty` fails, `set_property_with_node_compat` now uses QuickJS
descriptor APIs to inspect the target and its prototype chain:

- if the receiver already has the property, keep the original QuickJS failure;
- if a prototype accessor has a setter, keep the original QuickJS failure;
- if the inherited descriptor has no setter or is readonly, define a Node-like
  own property on the receiver with `JS_DefinePropertyValue(..., JS_PROP_C_W_E)`.

Verification attempted:

```sh
cd /Users/sadhbh/src/dev/edgejs/napi
make test-native-quickjs
```

A later full QuickJS N-API run passed after the concurrent contextify and
exception/source-map test changes settled.

Additional local check:

```sh
git -C napi diff --check -- quickjs/src/internal/napi_set_property.h quickjs/src/internal/napi_set_property.cc quickjs/src/js_native_api_quickjs.cc quickjs/CMakeLists.txt
```

This completed without whitespace errors.

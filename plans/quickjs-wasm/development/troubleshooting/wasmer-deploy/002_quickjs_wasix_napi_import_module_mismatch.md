# Wasmer Deploy: QuickJS WASIX N-API Import Module Mismatch

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by applying the embedded QuickJS N-API declaration mode to `edge_environment_core`; `quickjs-wasm/build.sh` now completes and the final no-N-API-imports check passes. |
| **Severity** | High | Blocks the QuickJS WASIX artifact from linking, so no deployable `edgejs.wasm` can be produced. |

## Issue

`~/src/dev/edgejs/quickjs-wasm/build.sh` reached the final WASM
link and failed with `wasm-ld` import module mismatches for several `napi_*`
symbols:

```text
wasm-ld: error: import module mismatch for symbol: napi_get_reference_value
>>> defined as env in libedge_runtime.a(edge_runtime.cc.obj)
>>> defined as napi in libedge_environment_core.a(edge_environment.cc.obj)
```

The same pattern appeared for `napi_delete_reference`,
`napi_create_reference`, `napi_is_exception_pending`, `napi_get_global`,
`napi_get_named_property`, `napi_create_string_utf8`, `napi_call_function`,
`napi_strict_equals`, `napi_create_array`, `napi_set_element`, and
`napi_add_env_cleanup_hook`.

## Diagnosis

The QuickJS WASIX build uses `EDGE_NAPI_PROVIDER=quickjs`, so the final wasm
should link against the embedded QuickJS N-API implementation and should not
import `napi_*`, `node_api_*`, or `unofficial_napi_*` symbols. The
`napi_quickjs` target exposes `NAPI_EXTERN=` to prevent the common N-API header
from annotating declarations as WASM imports.

`edge_runtime` already linked `napi_quickjs`, but `edge_environment_core`
includes N-API headers and only linked `uv_a`. Under `__wasm__`, the default
`NAPI_EXTERN` macro annotates declarations with `__import_module__("napi")`.
That made `edge_environment_core` object files disagree with other QuickJS Edge
objects that referenced the same unresolved N-API calls through the default
`env` import module. `wasm-ld` rejects the same symbol being imported from two
different modules.

## Fix

For `EDGE_NAPI_PROVIDER=quickjs`, `edge_environment_core` now compiles with:

```text
EDGE_EMBEDDED_NAPI_PROVIDER=1
NAPI_EXTERN=
```

This keeps N-API declarations consistent with the embedded QuickJS provider
without changing the shared common N-API headers.

## Verification

The fixed build was verified with:

```sh
cd ~/src/dev/edgejs/quickjs-wasm
./build.sh
```

Result:

```text
Built QuickJS WASIX targets at ~/src/dev/edgejs/build-quickjs-wasix/edge.wasm and ~/src/dev/edgejs/build-quickjs-wasix/edgejs.wasm
```

The script also completed its final no-N-API-imports check.

## Follow-Up Rule

When adding new Edge static libraries or object targets that include N-API
headers and participate in embedded QuickJS WASIX linking, make sure the target
inherits or explicitly defines `NAPI_EXTERN=` for the QuickJS provider.

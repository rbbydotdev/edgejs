# `quickjs::detail::napi_contextify__`

Status: Current as of 2026-05-15.

`napi_contextify__` implements the QuickJS-backed subset of Node/V8 contextify
and script-compilation helpers.

It lives in `napi/quickjs/src/internal/napi_contextify.h` and `.cc` under the
`quickjs::detail` namespace. `napi_env__` owns one instance for the lifetime of
the env.

The class handles source-map toggles, source-map error-source callbacks,
preserved error formatting, context creation/disposal, script execution,
function compilation, cached-data helpers, and module-syntax checks. Where
QuickJS cannot expose a V8-equivalent detail, methods return stable fallback
values rather than pretending to provide exact V8 internals.

Compilation paths annotate QuickJS exceptions with internal properties that
carry resource name, offsets, builtin ID, and mapped line information. Trace
output is controlled by QuickJS contextify/builtin trace flags and can add a
compact compile summary to stderr and to the error stack.

`teardown()` frees stored callback state. Most helpers accept public
`napi_value` handles, unwrap them to `JSValueConst`, perform QuickJS work, and
return results through normal env scope wrapping.

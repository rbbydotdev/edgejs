# E23 — Real Path A discovery

Goal: answer four open questions before committing to the "real Path A"
(uv_async_t-backed MessagePort) implementation.  Findings go in
`FINDINGS.md`.

The wasm already exports `uv_async_init`, `uv_async_send`, `uv_ref`,
`uv_unref`, `uv_close`, `napi_create_threadsafe_function`, and
`napi_call_threadsafe_function`.  These are Node's own implementations
compiled into the wasm by edge.js's build.  Currently emnapi shadows
the napi ones with broken-on-wasi-libc impls; the uv exports are
unused from host JS.

## Questions

1. **Loop identity**: is `_start`'s `uv_run` driving `uv_default_loop()`,
   and can host JS get a pointer to it (e.g. via `uv_default_loop`
   export)?

2. **JSPI re-entry safety**: can host JS call wasm's `uv_async_init` /
   `uv_async_send` while `_start` is suspended (JSPI)?  The wasm's
   `uv_async_send` is documented thread-safe in libuv; confirm it
   doesn't trip our promising-depth guard.

3. **`uv_async_t` size**: what's `uv_handle_size(UV_ASYNC)` in the
   compiled wasm — needed for `guestMalloc` sizing.

4. **Callback funcref**: install a host-defined funcref into
   `__indirect_function_table` and have it invoked when
   `uv_async_send` fires.  Verify the funcref dispatcher we already
   use for `OP_INVOKE_WASM_CALLBACK` is reusable here.

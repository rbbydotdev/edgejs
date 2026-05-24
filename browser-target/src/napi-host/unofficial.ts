// Implementations of the ~80 `unofficial_napi_*` functions that edgejs.wasm
// imports.  These are NOT part of standard N-API; they're edge.js's V8
// embedding hooks for things Node uses internally — module wrapping, script
// compilation, structured clone, heap inspection, etc.
//
// Each starts as a logging stub returning a sensible status (mostly napi_ok).
// As the probe runs and we see which ones edge actually invokes during boot,
// we fill them in one at a time.  The Rust file in napi/src/guest/napi.rs is
// the reference spec for behavior; the napi/src/napi_bridge_init.cc shows
// what V8 ops they map to — both useful when porting a given function.
//
// AUDIT NOTE 2026-05-20: the Rust guest functions take `FunctionEnvMut<NapiEnv>`
// as their first param — that's a wasmer host construct, NOT a wasm-visible
// argument.  Wasm callers pass exactly ONE env handle.  Earlier impls in this
// file declared a phantom `_napiEnv` second parameter, which shifted every
// subsequent out-pointer arg by one slot.  Every impl in this file has been
// verified against `napi/src/guest/napi.rs:fn guest_unofficial_napi_*` arity.
// See NOTES.md 2026-05-20 "phantom-arg audit" entry.

import type { Context, Env } from "./emnapi";
import type { ModuleOverride } from "../policies";

// Capture native text-codec instances at module load.  Edge mutates
// globalThis.TextEncoder/Decoder mid-boot with a polyfill that goes
// through V8 string ops we don't host — same root cause as #14.
// See NOTES.md 2026-05-20 "uv_cwd EIO: attempt #6".
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface UnofficialHostContext {
  context: Context;
  memory: WebAssembly.Memory;
  /** The Env we created during `unofficial_napi_create_env`; lookup table by env handle. */
  envs: Map<number, Env>;
  /** The NapiModule from createNapiModule.  V2 init creates an env
   *  during `napiModule.init({instance})` and stashes it on
   *  `napiModule.envObject`; `unofficial_napi_create_env` reuses it
   *  rather than calling `context.createEnv` (whose signature changed
   *  v1→v2: positional makeDynCall args → bridge object).  When v1 is
   *  the runtime, `envObject` is unset and we fall back to v1 createEnv. */
  napiModule?: { envObject?: Env };
  /**
   * Module-source overrides — see ModuleOverride type in policies/index.ts.
   * Keyed by edge's builtin filename format
   * (`node:crypto`, `node:inspector`) OR bare specifier (`crypto`).  When
   * edge's `BuiltinsCompileFunctionCallback` calls our
   * `unofficial_napi_contextify_compile_function` with one of these
   * filenames, we substitute the override source for edge's bundled
   * version from its C++ builtin catalog.
   *
   * Values: see `ModuleOverride` in policies/index.ts — string (replace),
   * null (empty stub), `{ post: string }` (keep body, append patch).
   * Empty map / undefined = no overrides; fall through to edge's source.
   */
  builtinOverrides?: Map<string, ModuleOverride>;
  /** Optional log sink — used for debug breadcrumbs that can't go through
   * console.* (edge mutates console internals during bootstrap). */
  postLog?: (line: string, level: "out" | "warn" | "err" | "debug") => void;
  /** E9: Called when wasm-side `unofficial_napi_terminate_execution`
   *  fires (i.e. JS-side `process.exit()` ran).  Wakes a parked
   *  `poll_oneoff` (in `wasi-shim.ts`) so it can abort with
   *  ExitSignal instead of letting a surviving setTimeout fire after
   *  exit was already requested.  See experiments/e9-process-exit-in-fr/
   *  FINDINGS.md. */
  requestExit?: (code: number) => void;
}

function dv(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

export function createUnofficialNapi(ctx: UnofficialHostContext): Record<string, Function> {
  const { context, memory, envs, napiModule } = ctx;

  // Tracks "scope handle ID" → "env ID" so we can release scopes by their
  // own handle, which is what wasm passes back.
  const scopeToEnv = new Map<number, number>();

  // Build the impls object first so methods can reference each other via
  // `impls.X` (closure) rather than `this.X` — wasm calls reach us through
  // `imports-generated.ts:wrapImpl` which invokes `fn(...args)` with no
  // `this` binding, so `(this as Record<string, Function>).X` is undefined.
  // See NOTES.md 2026-05-20 "uv_cwd EIO: FIXED" for the broader pattern.
  const impls: Record<string, Function> = {
    // --- Env lifecycle ---

    // (module_api_version, env_out_ptr, scope_out_ptr) -> napi_status
    unofficial_napi_create_env(_apiVersion: number, envOutPtr: number, scopeOutPtr: number): number {
      // V2 cutover: if emnapi's standard init flow already created an
      // env (it does — `napiModule.init({instance})` allocates a struct
      // via our `emnapi_create_env` stub, calls `emnapiCtx.createEnv(...)`,
      // and stashes the result on `napiModule.envObject` + the module-
      // level `emnapiEnv` reference that v2's napi functions read), reuse
      // it.  Calling `context.createEnv` again with v1 positional args
      // would fail because v2's signature wants a `bridge` object as the
      // 3rd arg, not a `makeDynCall_vppp` function.
      //
      // V1 fallback: `napiModule.envObject` is undefined; we create the
      // env ourselves using v1's positional signature.
      let env: Env;
      const existingEnv = napiModule?.envObject;
      if (existingEnv) {
        env = existingEnv;
      } else {
        // V1 path — positional createEnv signature.
        // #!~debt dyncall-before-table-ready: dispatchers are silent no-ops
        // — they accept the dispatch call and do nothing.  Finalizers fire
        // during emnapi's `RefTracker.finalizeAll` on process exit, after
        // user work is done; skipping them is harmless (the OS reclaims).
        env = (context as unknown as {
          createEnv: (
            filename: string,
            version: number,
            makeDynCall_vppp: unknown,
            makeDynCall_vp: unknown,
            abort: (msg?: string) => void,
            nodeBinding: unknown,
          ) => Env;
        }).createEnv(
          "edgejs",
          8,
          (() => () => undefined),
          (() => () => undefined),
          (msg?: string) => { throw new Error(`napi abort: ${msg ?? "(no message)"}`); },
          undefined,
        );
      }
      envs.set(Number(env.id), env);

      const scope = context.openScope(env);
      scopeToEnv.set(Number(scope.id), Number(env.id));

      const view = dv(memory);
      if (envOutPtr > 0) view.setUint32(envOutPtr, Number(env.id), true);
      if (scopeOutPtr > 0) view.setUint32(scopeOutPtr, Number(scope.id), true);
      return 0; // napi_ok
    },

    // (api_version, options_ptr, env_out_ptr, scope_out_ptr) -> status
    unofficial_napi_create_env_with_options(
      _apiVersion: number,
      _optionsPtr: number,
      envOutPtr: number,
      scopeOutPtr: number,
    ): number {
      return impls.unofficial_napi_create_env(0, envOutPtr, scopeOutPtr);
    },

    // #!~debt no-op: doesn't actually release the emnapi env/scope we
    // created in unofficial_napi_create_env.  Envs accumulate across runs.
    // Fine for single-shot scripts; leaks for long-lived sessions.
    unofficial_napi_release_env(_scopePtr: number): number {
      return 0;
    },
    unofficial_napi_release_env_with_loop(_scopePtr: number, _loopPtr: number): number {
      return 0;
    },

    // --- V8 flags (no-op; we don't have V8 here, browser engine is what it is) ---

    unofficial_napi_set_flags_from_string(_strPtr: number, _strLen: number): number {
      return 0;
    },

    // --- V8-specific extensions backed by browser-engine equivalents ---

    // V8's "private symbol" is a Symbol that isn't visible via reflection.
    // Browsers don't expose that knob; a regular Symbol() is close enough for
    // edge's bootstrap (private-property hiding doesn't matter when nothing
    // else can observe it anyway).  Returns the new handle in result_ptr.
    unofficial_napi_create_private_symbol(
      envHandle: number,
      descPtr: number,
      descLen: number,
      resultPtr: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      let description: string | undefined;
      if (descPtr > 0) {
        const mem = new Uint8Array(memory.buffer);
        let end: number;
        if (descLen === -1 || descLen === 0xFFFFFFFF) {
          end = descPtr;
          while (mem[end] !== 0 && end < mem.length) end++;
        } else {
          end = descPtr + descLen;
        }
        // TextDecoder refuses shared buffers; copy first.
        const copy = new Uint8Array(end - descPtr);
        copy.set(mem.subarray(descPtr, end));
        description = decoder.decode(copy);
      }
      const sym = description ? Symbol(description) : Symbol();
      const handle = context.napiValueFromJsValue(sym);
      dv(memory).setUint32(resultPtr, Number(handle), true);
      return 0;
    },

    // V8's vm.compileFunction equivalent.  Used by Node to compile internal
    // bootstrap scripts and user CJS modules.  We build a JS Function with
    // the given parameter names (so CJS wrappers get `exports`, `require`,
    // etc. as injected args).  Returns an object wrapping the function +
    // sourceMap metadata — matches the shape edge expects (see
    // napi/v8/src/unofficial_napi_contextify.cc:1876 in the native ref).
    // Wasm sig (12 args, napi/src/guest/napi.rs:1440):
    // (napi_env, code, filename, line_offset, column_offset, cached_data,
    //  produce_cached_data, parsing_context, context_extensions, params,
    //  host_defined_option_id, result_ptr)
    unofficial_napi_contextify_compile_function(
      _envHandle: number,
      codeHandle: number,
      filenameHandle: number,
      _lineOffset: number,
      _columnOffset: number,
      _cachedData: number,
      _produceCachedData: number,
      _parsingContext: number,
      _contextExtensions: number,
      paramsHandle: number,
      _hostDefinedOptionId: number,
      resultPtr: number,
    ): number {
      let code = context.jsValueFromNapiValue(codeHandle) as string | undefined;
      const filename = context.jsValueFromNapiValue(filenameHandle) as string | undefined;
      if (typeof code !== "string") return 1;

      // Module-source override hook (1 of 2).  Edge's
      // `BuiltinsCompileFunctionCallback` (src/edge_module_loader.cc:964)
      // reads built-in source from a C++ catalog baked into the wasm,
      // then calls THIS function with `filename = "node:<id>"`.  Intercept
      // here to substitute the source with a user-provided override before
      // compilation.  Empty stubs (null) → `module.exports = {}`.
      //
      // This path catches the ~11 modules compiled at bootstrap
      // (per_context/*, bootstrap/*, main/eval_string, [eval]-wrapper).
      // Lazy-required builtins (`inspector`, `url`, `crypto`, ...) go
      // through edge's `EvaluateJsModule` → `napi_run_script` path
      // instead — that hook lives in `napi-host/index.ts` and uses the
      // same `builtinOverrides` map.
      if (ctx.builtinOverrides && typeof filename === "string") {
        const bare = filename.startsWith("node:") ? filename.slice(5) : filename;
        let override: ModuleOverride | undefined;
        if (ctx.builtinOverrides.has(filename)) override = ctx.builtinOverrides.get(filename);
        else if (ctx.builtinOverrides.has(bare)) override = ctx.builtinOverrides.get(bare);
        if (override !== undefined) {
          ctx.postLog?.(`[override] matched ${filename}`, "debug");
          if (override === null) {
            code = "module.exports = {};";
          } else if (typeof override === "string") {
            code = override;
          } else {
            // { pre?, post? } — splice patches around edge's bundled body.
            // The new Function constructor below wraps the whole thing in a
            // single function body, so both patches see the same locals +
            // wrapper args (`internalBinding`, `primordials`, `module`, ...).
            const pre = override.pre ? override.pre + "\n" : "";
            const post = override.post ? "\n" + override.post : "";
            if (pre || post) code = pre + code + post;
          }
        }
      }

      // params: optional array of strings (the wrapper-function arg names).
      let paramNames: string[] = [];
      if (paramsHandle > 0) {
        const arr = context.jsValueFromNapiValue(paramsHandle);
        if (Array.isArray(arr)) paramNames = arr.map(String);
      }

      let compiled: Function;
      try {
        // #!~debt approximation: `new Function` ≠ vm.compileFunction.  Differences:
        //   - new Function runs in the GLOBAL scope of this worker; vm runs in
        //     the script's parsingContext (we pass 0/undefined so this happens
        //     to match for boot, but it diverges if edge passes a real context).
        //   - new Function can't accept `parsingContext`, `contextExtensions`,
        //     `cachedData`, or `produceCachedData` — we silently drop all four.
        //   - Syntax errors surface as JS exceptions here, not napi statuses;
        //     we return generic-failure (status 1) without populating the
        //     pending exception on the napi env.
        compiled = new Function(...paramNames, `//# sourceURL=${filename ?? "[edgejs]"}\n${code}`);
      } catch (e) {
        // #!~debt error reporting: should surface as a napi exception
        // (napi_throw_error or similar) so edge sees it via napi_is_exception_pending.
        // Currently the compile-fail just returns status 1 — edge then sees a
        // bogus "compile succeeded but result is undefined" downstream.
        console.warn("compile_function failed:", e);
        return 1;
      }

      // Wrap in the result-object shape edge's wrapSafe expects.
      const wrapper = {
        function: compiled,
        sourceURL: filename,
        sourceMapURL: undefined,
        cachedDataRejected: false,
      };
      const handle = context.napiValueFromJsValue(wrapper);
      dv(memory).setUint32(resultPtr, Number(handle), true);
      return 0;
    },

    // --- Callback-registration extensions ---
    // Edge registers various lifecycle / introspection callbacks via these.
    // We record-but-never-invoke for now (browser has no equivalent runtime
    // hook to wire them into).  Returning napi_ok lets edge proceed.

    // Foreground task queue callback — edge.js uses this to drain microtasks
    // and async work onto the V8 event loop.  We record-but-never-invoke.
    // #!~debt no-op: should wire to queueMicrotask/postMessage so async work
    // and timers actually fire.  Browser-only event loop is the right binding.
    unofficial_napi_set_enqueue_foreground_task_callback(
      _envHandle: number,
      _callback: number,
      _target: number,
    ): number {
      return 0;
    },

    // #!~debt no-op: callbacks are accepted but never invoked.  Fatal errors
    // currently surface only via JS throw paths, not these callbacks.
    unofficial_napi_set_fatal_error_callbacks(
      _envHandle: number,
      _fatalErrorCb: number,
      _oomErrorCb: number,
    ): number {
      return 0;
    },

    // #!~debt no-op: Error.prepareStackTrace customization is unhooked.  When
    // edge throws an Error, we get the browser's default stack format rather
    // than node's.  Cosmetic until userland depends on the v8 formatting.
    unofficial_napi_set_prepare_stack_trace_callback(_envHandle: number, _callback: number): number {
      return 0;
    },

    // #!~debt no-op: promise hooks (init/before/after/resolve) are dropped.
    // Node uses these for async_hooks tracing.  Anything depending on
    // async_hooks won't see lifecycle events until this is wired.
    unofficial_napi_set_promise_hooks(
      _envHandle: number,
      _initCb: number,
      _beforeCb: number,
      _afterCb: number,
      _resolveCb: number,
    ): number {
      return 0;
    },

    // --- Introspection: report no positions / no proxy ---

    // Wasm sig (3 args, napi/src/guest/napi.rs:873):
    // (napi_env, error, positions_ptr).  positions_ptr is ONE pointer to a
    // 20-byte struct of { source_line_id:u32, script_resource_name_id:u32,
    // line_number:i32, start_column:i32, end_column:i32 }.
    // #!~debt no-op: returns success and zero-fills the struct so caller
    // sees "no position info" cleanly.  Stack frames lack precise column info.
    unofficial_napi_get_error_source_positions(
      _envHandle: number,
      _error: number,
      positionsPtr: number,
    ): number {
      if (positionsPtr > 0) {
        new Uint8Array(memory.buffer, positionsPtr, 20).fill(0);
      }
      return 0;
    },

    // Wasm sig (4 args, napi/src/guest/napi.rs:401):
    // (napi_env, proxy, target_ptr, handler_ptr).  There is NO is_proxy_out
    // field; the C++ caller infers "is proxy" from successful population of
    // target/handler.  We zero both and return ok — caller sees a degenerate
    // "proxy with no target/handler" which it'll treat as not-a-proxy.
    // #!~debt incomplete: real impl would detect Proxy via internal slot
    // inspection (not directly exposed in browser JS).
    unofficial_napi_get_proxy_details(
      _envHandle: number,
      _proxy: number,
      targetPtr: number,
      handlerPtr: number,
    ): number {
      const d = dv(memory);
      if (targetPtr > 0) d.setUint32(targetPtr, 0, true);
      if (handlerPtr > 0) d.setUint32(handlerPtr, 0, true);
      return 0;
    },

    // --- Below: #!~debt stubs that fill the remaining unofficial_napi_*
    //     surface so wasm calls don't fall through to the generic logging
    //     fallback.  Each writes sensible defaults to its out-params and
    //     returns napi_ok (0).  Promote individual entries to real impls as
    //     workloads light them up.  See napi/src/guest/napi.rs for behaviors.

    // Heap/process stats — all return zeros, which is honest for "no V8 here".
    // Edge inspects these for process.memoryUsage() and v8.getHeapStatistics().
    // Returning zero counts is wrong but non-fatal — caller sees an idle heap.
    // Wasm sig (2 args): (napi_env, stats_ptr).  Struct is 14 size_t (u32) fields = 56 bytes.
    unofficial_napi_get_heap_statistics(_envHandle: number, statsPtr: number): number {
      if (statsPtr > 0) new Uint8Array(memory.buffer, statsPtr, 14 * 4).fill(0);
      return 0;
    },
    unofficial_napi_get_heap_space_count(_envHandle: number, countOut: number): number {
      if (countOut > 0) dv(memory).setUint32(countOut, 0, true);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, space_index, stats_ptr).
    // Struct is SnapiUnofficialHeapSpaceStatistics: 64-byte name + 4 u32 fields = 80 bytes.
    unofficial_napi_get_heap_space_statistics(_envHandle: number, _index: number, statsPtr: number): number {
      if (statsPtr > 0) new Uint8Array(memory.buffer, statsPtr, 64 + 4 * 4).fill(0);
      return 0;
    },
    // Wasm sig (2 args): (napi_env, stats_ptr).  Struct = 4 u32 fields.
    unofficial_napi_get_heap_code_statistics(_envHandle: number, statsPtr: number): number {
      if (statsPtr > 0) new Uint8Array(memory.buffer, statsPtr, 4 * 4).fill(0);
      return 0;
    },
    // Wasm sig (5 args, napi/src/guest/napi.rs:819):
    // (napi_env, heap_total_out, heap_used_out, external_out, array_buffers_out).
    // Each out-ptr is an f64 (write_guest_f64), not u64.  No `rss` field.
    unofficial_napi_get_process_memory_info(
      _envHandle: number,
      heapTotalOut: number, heapUsedOut: number, externalOut: number, arrayBuffersOut: number,
    ): number {
      const d = dv(memory);
      for (const p of [heapTotalOut, heapUsedOut, externalOut, arrayBuffersOut]) {
        if (p > 0) { d.setFloat64(p, 0, true); }
      }
      return 0;
    },
    unofficial_napi_get_hash_seed(_envHandle: number, hashSeedOut: number): number {
      if (hashSeedOut > 0) dv(memory).setBigUint64(hashSeedOut, 0n, true);
      return 0;
    },

    // Profiling / GC controls — no real V8 to drive, so accept and discard.
    unofficial_napi_low_memory_notification(_envHandle: number): number { return 0; },
    unofficial_napi_request_gc_for_testing(_envHandle: number): number { return 0; },
    unofficial_napi_process_microtasks(_envHandle: number): number {
      // queueMicrotask drains naturally in the worker; nothing to do here.
      return 0;
    },
    unofficial_napi_terminate_execution(_envHandle: number): number {
      // E9: signal "exit requested" to the wasi-shim so a parked poll_oneoff
      // (waiting on a setTimeout) can abort early instead of letting the
      // timer fire after process.exit() was already called.
      //
      // Without this, JS-side process.exit() throws ExitSignal at the
      // wasm-import boundary, but `EdgeHandlePendingExceptionNow` sees
      // `IsEnvironmentExitRequested=true` and discards it.  The wasm
      // returns from the napi call and continues into libuv, which dispatches
      // the surviving setTimeout — overwriting the exit code.
      let code = 0;
      try {
        const procObj = (globalThis as { process?: { exitCode?: number } }).process;
        if (procObj && typeof procObj.exitCode === "number") code = procObj.exitCode >>> 0;
      } catch { /* */ }
      ctx.requestExit?.(code);
      return 0;
    },
    unofficial_napi_cancel_terminate_execution(_envHandle: number): number { return 0; },
    unofficial_napi_request_interrupt(_envHandle: number, _callback: number, _data: number): number { return 0; },
    unofficial_napi_set_stack_limit(_envHandle: number, _limit: number): number { return 0; },
    unofficial_napi_set_near_heap_limit_callback(_envHandle: number, _cb: number, _data: number): number { return 0; },
    unofficial_napi_remove_near_heap_limit_callback(_envHandle: number, _heapLimit: number): number { return 0; },
    unofficial_napi_notify_datetime_configuration_change(_envHandle: number): number { return 0; },

    // Continuation-preserved embedder data — used by AsyncContext.  Per-env
    // storage; we just round-trip a single slot per env.
    // Wasm sig (2 args): (napi_env, result_ptr).
    unofficial_napi_get_continuation_preserved_embedder_data(
      envHandle: number, resultPtr: number,
    ): number {
      const e = envs.get(envHandle);
      const slot = (e as unknown as { _contData?: number })?._contData ?? 0;
      if (resultPtr > 0) dv(memory).setUint32(resultPtr, slot, true);
      return 0;
    },
    unofficial_napi_set_continuation_preserved_embedder_data(
      envHandle: number, valueHandle: number,
    ): number {
      const e = envs.get(envHandle);
      if (e) (e as unknown as { _contData?: number })._contData = valueHandle;
      return 0;
    },

    // CPU/heap profiling — never start, never stop, no data emitted.
    // Wasm sig (3 args): (napi_env, result_ptr, profile_id_ptr).
    unofficial_napi_start_cpu_profile(_envHandle: number, resultPtr: number, profileIdPtr: number): number {
      const d = dv(memory);
      if (resultPtr > 0) d.setInt32(resultPtr, 0, true);
      if (profileIdPtr > 0) d.setUint32(profileIdPtr, 0, true);
      return 0;
    },
    // Wasm sig (5 args): (napi_env, profile_id, found_ptr, json_ptr, json_len_ptr).
    // found_ptr is a u8 (bool), json_ptr and json_len_ptr are u32.
    unofficial_napi_stop_cpu_profile(
      _envHandle: number, _profileId: number, foundPtr: number, jsonPtr: number, jsonLenPtr: number,
    ): number {
      const d = dv(memory);
      if (foundPtr > 0) d.setUint8(foundPtr, 0);
      if (jsonPtr > 0) d.setUint32(jsonPtr, 0, true);
      if (jsonLenPtr > 0) d.setUint32(jsonLenPtr, 0, true);
      return 0;
    },
    // Wasm sig (2 args): (napi_env, started_ptr).  started_ptr is u8.
    unofficial_napi_start_heap_profile(_envHandle: number, startedPtr: number): number {
      if (startedPtr > 0) dv(memory).setUint8(startedPtr, 0);
      return 0;
    },
    // Wasm sig (4 args): (napi_env, found_ptr, json_ptr, json_len_ptr).
    unofficial_napi_stop_heap_profile(
      _envHandle: number, foundPtr: number, jsonPtr: number, jsonLenPtr: number,
    ): number {
      const d = dv(memory);
      if (foundPtr > 0) d.setUint8(foundPtr, 0);
      if (jsonPtr > 0) d.setUint32(jsonPtr, 0, true);
      if (jsonLenPtr > 0) d.setUint32(jsonLenPtr, 0, true);
      return 0;
    },
    // Wasm sig (4 args): (napi_env, options_ptr, json_ptr, json_len_ptr).
    unofficial_napi_take_heap_snapshot(
      _envHandle: number, _optionsPtr: number, jsonPtr: number, jsonLenPtr: number,
    ): number {
      const d = dv(memory);
      if (jsonPtr > 0) d.setUint32(jsonPtr, 0, true);
      if (jsonLenPtr > 0) d.setUint32(jsonLenPtr, 0, true);
      return 0;
    },

    // Promise introspection.  Wasm sig (5 args, see napi/src/guest/napi.rs:364):
    // (napi_env, promise, state_ptr, result_ptr, has_result_ptr).  Earlier
    // impl declared a phantom _napiEnv parameter, so stateOut wrote to the
    // wrong address — the real state_ptr (arg 2) stayed uninitialized.
    // Edge's IsPromisePending then read its own stack-default of 0 (pending),
    // which downstream cascaded into the unsettled-TLA gate (exit 13).
    // state_ptr is i32, result_ptr is u32, has_result_ptr is u8.
    // Honest stub: say "fulfilled with no result" so the C++ caller doesn't
    // wait for resolution.
    unofficial_napi_get_promise_details(
      _envHandle: number, _promiseHandle: number,
      stateOut: number, resultOut: number, hasResultOut: number,
    ): number {
      const d = dv(memory);
      if (stateOut > 0) d.setInt32(stateOut, 1, true);    // 1 = fulfilled
      if (resultOut > 0) d.setUint32(resultOut, 0, true);
      if (hasResultOut > 0) d.setUint8(hasResultOut, 0);  // 1-byte bool
      return 0;
    },
    unofficial_napi_mark_promise_as_handled(_envHandle: number, _promise: number): number { return 0; },

    // Stack inspection — return empty arrays / null locations.
    // Wasm sig (3 args): (napi_env, frames, callsites_ptr).
    unofficial_napi_get_call_sites(
      envHandle: number, _frames: number, callsitesOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && callsitesOut > 0) {
        const arr = context.napiValueFromJsValue([]);
        dv(memory).setUint32(callsitesOut, Number(arr), true);
      }
      return 0;
    },
    // Wasm sig (2 args): (napi_env, location_ptr).
    unofficial_napi_get_caller_location(_envHandle: number, locationOut: number): number {
      if (locationOut > 0) dv(memory).setUint32(locationOut, 0, true);
      return 0;
    },
    // Stub function in Rust (napi.rs:5242) takes 3 raw i32 args (a, b, c) and
    // returns 1.  We mirror: return 1 = napi_invalid_arg.
    unofficial_napi_get_current_stack_trace(
      _a: number, _b: number, _c: number,
    ): number {
      return 1;
    },
    // Wasm sig (2 args): (napi_env, error).
    unofficial_napi_preserve_error_source_message(_envHandle: number, _error: number): number { return 0; },

    // ArrayBuffer / Buffer helpers.
    // Wasm sig (3 args): (napi_env, value, result_ptr).  result_ptr is u8.
    unofficial_napi_arraybuffer_view_has_buffer(
      envHandle: number, valueHandle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      const value = env ? context.jsValueFromNapiValue(valueHandle) : undefined;
      const has = ArrayBuffer.isView(value) && (value as ArrayBufferView).buffer != null;
      if (resultOut > 0) dv(memory).setUint8(resultOut, has ? 1 : 0);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, value, name_ptr).
    unofficial_napi_get_constructor_name(
      envHandle: number, valueHandle: number, nameOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      const name = v == null ? "" : (v as object)?.constructor?.name ?? "";
      if (nameOut > 0) {
        const h = context.napiValueFromJsValue(name);
        dv(memory).setUint32(nameOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args): (napi_env, value, filter, result_out_ptr).
    unofficial_napi_get_own_non_index_properties(
      envHandle: number, valueHandle: number, _filter: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      const keys = (v && typeof v === "object")
        ? Object.getOwnPropertyNames(v).filter((k) => !/^[0-9]+$/.test(k))
        : [];
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(keys);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args, napi.rs:432): (napi_env, value, entries_ptr, is_key_value_ptr).
    // entries_ptr is u32, is_key_value_ptr is u8.
    unofficial_napi_preview_entries(
      envHandle: number, valueHandle: number, entriesOut: number, isKeyValueOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      let entries: unknown[] = [];
      let isKeyValue = false;
      if (v instanceof Map) { entries = Array.from(v.entries()).flat(); isKeyValue = true; }
      else if (v instanceof Set) { entries = Array.from(v); isKeyValue = false; }
      if (entriesOut > 0) {
        const h = context.napiValueFromJsValue(entries);
        dv(memory).setUint32(entriesOut, Number(h), true);
      }
      if (isKeyValueOut > 0) dv(memory).setUint8(isKeyValueOut, isKeyValue ? 1 : 0);
      return 0;
    },
    // V8 buffer-data free; we let the JS GC manage memory, no-op.
    // Wasm sig (1 arg): (data) → void.
    unofficial_napi_free_buffer(_data: number): void { /* no-op */ },

    // Structured-clone family.  IMPORTANT: per napi.rs:5080-5081, the symbol
    // `unofficial_napi_structured_clone` is wired to the 3-arg adapter, and
    // `unofficial_napi_structured_clone_with_transfer` is the full 4-arg flavor.
    //
    // Wasm sig for `structured_clone` (3 args, napi.rs:671):
    // (napi_env, value, result_ptr) — no transfer list.
    unofficial_napi_structured_clone(
      envHandle: number, valueHandle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      let cloned: unknown;
      try { cloned = (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone?.(v) ?? v; }
      catch { cloned = v; }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(cloned);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args, napi.rs:689):
    // (napi_env, value, transfer_list, result_ptr).
    unofficial_napi_structured_clone_with_transfer(
      envHandle: number, valueHandle: number, _transferList: number, resultOut: number,
    ): number {
      // #!~debt drops transfer list; same impl as 3-arg structured_clone.
      return impls.unofficial_napi_structured_clone(envHandle, valueHandle, resultOut);
    },
    // v8 serializer/deserializer — wrap in a JSON-compat shim.  Real impl
    // would expose v8.serialize/v8.deserialize semantics (preserves
    // structured-clone-able shapes); JSON loses functions, undefined, etc.
    // Wasm sig (2 args): (napi_env, result_ptr).
    unofficial_napi_create_serdes_binding(_envHandle: number, resultOut: number): number {
      if (resultOut > 0) {
        const stub = context.napiValueFromJsValue({ serialize: (v: unknown) => JSON.stringify(v), deserialize: (s: string) => JSON.parse(s) });
        dv(memory).setUint32(resultOut, Number(stub), true);
      }
      return 0;
    },
    // Wasm sig (3 args, napi.rs:713): (napi_env, value, payload_out_ptr).
    unofficial_napi_serialize_value(
      envHandle: number, valueHandle: number, payloadOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      const bytes = encoder.encode(JSON.stringify(v ?? null));
      if (payloadOut > 0) {
        const ab = new ArrayBuffer(bytes.length);
        new Uint8Array(ab).set(bytes);
        const h = context.napiValueFromJsValue(ab);
        dv(memory).setUint32(payloadOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args, napi.rs:725): (napi_env, payload, result_out_ptr).
    unofficial_napi_deserialize_value(
      envHandle: number, payloadHandle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const buf = context.jsValueFromNapiValue(payloadHandle) as ArrayBuffer | undefined;
      let value: unknown = null;
      if (buf) {
        try { value = JSON.parse(decoder.decode(new Uint8Array(buf))); } catch { /* leave null */ }
      }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(value);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (1 arg, napi.rs:737): (payload) → void.
    unofficial_napi_release_serialized_value(_payload: number): void { /* no-op */ },

    // Contextify (vm.*) — minimal pass-through.  Run-script is the most
    // load-bearing: edge uses it for sourceText eval.  We use Function() so
    // it runs in the worker's global scope, no real context isolation.
    // Wasm sig (9 args, napi.rs:1336):
    // (napi_env, sandbox_or_symbol, name, origin_or_undefined, allow_code_gen_strings,
    //  allow_code_gen_wasm, own_microtask_queue, host_defined_option_id, result_ptr).
    unofficial_napi_contextify_make_context(
      envHandle: number, _sandboxOrSymbol: number, _name: number, _originOrUndefined: number,
      _allowCodeGenStrings: number, _allowCodeGenWasm: number, _ownMicrotaskQueue: number,
      _hostDefinedOptionId: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        // #!~debt context object is just an empty marker; real vm.Context
        // has its own globalThis, intrinsics, etc.  Boot tolerates this
        // because edge mostly uses the default context anyway.
        const h = context.napiValueFromJsValue({ __edge_context__: true });
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (2 args, napi.rs:1425): (napi_env, sandbox_or_context_global).
    unofficial_napi_contextify_dispose_context(_envHandle: number, _sandboxOrContextGlobal: number): number {
      return 0;
    },
    // Wasm sig (12 args, napi.rs:1378):
    // (napi_env, sandbox_or_null, source, filename, line_offset, column_offset,
    //  timeout: i64, display_errors, break_on_sigint, break_on_first_line,
    //  host_defined_option_id, result_ptr).  Earlier impl had a phantom
    // `_ctx` placeholder and shifted everything by one — sourceHandle was
    // actually reading the filename string "[eval]", so `new Function`
    // evaluated "return ([eval]);" (a JS array literal) instead of the user
    // code.  console.log was never called.
    unofficial_napi_contextify_run_script(
      envHandle: number, _sandboxOrNull: number, sourceHandle: number, _filenameHandle: number,
      _lineOffset: number, _columnOffset: number, _timeout: bigint,
      _displayErrors: number, _breakOnSigint: number, _breakOnFirstLine: number,
      _hostDefinedOptionId: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const source = context.jsValueFromNapiValue(sourceHandle) as string | undefined;
      if (typeof source !== "string") return 1;
      let value: unknown;
      try {
        // #!~debt eval-via-Function: real vm.Script supports break-on-sigint,
        // timeout, displayErrors.  We drop all.  Syntax errors throw to JS.
        // Wrap in an IIFE so statements (not just expressions) work; if the
        // user passed `console.log(…)` we still want it to execute even
        // though it has no return value.
        value = new Function(`${source}`)();
      } catch (e) {
        // #!~debt should surface as napi exception; currently just status 1.
        console.warn("contextify_run_script failed:", e);
        return 1;
      }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(value);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (6 args, napi.rs:5182):
    // (napi_env, code, filename, is_sea_main, should_detect_module, result_ptr).
    // Node's CJS loader expects an object with at least a `function` field; the
    // function itself must be CJS-wrapped, i.e. take (exports, require, module,
    // __filename, __dirname) as parameters.  We synthesize the params array,
    // hand the work to `unofficial_napi_contextify_compile_function`, and write
    // the resulting wrapper handle into the caller's result slot.
    unofficial_napi_contextify_compile_function_for_cjs_loader(
      envHandle: number,
      codeHandle: number,
      filenameHandle: number,
      _isSeaMain: number,
      _shouldDetectModule: number,
      resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const paramsArray = ["exports", "require", "module", "__filename", "__dirname"];
      const paramsHandle = context.napiValueFromJsValue(paramsArray);
      return impls.unofficial_napi_contextify_compile_function(
        envHandle, codeHandle, filenameHandle, 0, 0, 0, 0, 0, 0, paramsHandle, 0, resultOut,
      );
    },
    // Wasm sig (6 args, napi.rs:1301):
    // (napi_env, code, filename, resource_name_or_undefined, cjs_var_in_scope, result_ptr).
    // result_ptr is u8 (bool).
    unofficial_napi_contextify_contains_module_syntax(
      envHandle: number, codeHandle: number, _filename: number,
      _resourceNameOrUndefined: number, _cjsVarInScope: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const code = context.jsValueFromNapiValue(codeHandle) as string | undefined;
      // #!~debt naïve regex check — misses dynamic import, commented imports,
      // template-literal exports.  Real impl parses with acorn.  Good enough
      // for the "is this ESM or CJS?" boot heuristic.
      const has = typeof code === "string" && /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/|\s)*(?:import|export)\s/m.test(code);
      if (resultOut > 0) dv(memory).setUint8(resultOut, has ? 1 : 0);
      return 0;
    },
    // Wasm sig (7 args, napi.rs:1500):
    // (napi_env, code, filename, line_offset, column_offset, host_defined_option_id, result_ptr).
    unofficial_napi_contextify_create_cached_data(
      _envHandle: number, _code: number, _filename: number,
      _lineOffset: number, _columnOffset: number, _hostDefinedOptionId: number, resultOut: number,
    ): number {
      // No V8 cache — return an empty ArrayBuffer.
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(new ArrayBuffer(0));
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },

    // ESM module wrap — the 18-function surface that backs SourceTextModule
    // and SyntheticModule.  Implementing these properly means a real
    // module-graph linker; we stub with handles that round-trip but don't
    // execute.  Edge boots fine on CJS; ESM workloads fail at link/evaluate.
    // #!~debt module_wrap_* whole family: every call here is a no-op or
    // returns a handle that points at a marker object.  Promote piece by
    // piece when ESM workloads need to work.

    // Wasm sig (9 args, napi.rs:1534):
    // (napi_env, wrapper, url, context_or_undefined, source, line_offset,
    //  column_offset, cached_data_or_id, handle_ptr).
    unofficial_napi_module_wrap_create_source_text(
      envHandle: number, wrapper: number, url: number, _contextOrUndefined: number,
      source: number, _lineOffset: number, _columnOffset: number,
      _cachedDataOrId: number, handlePtr: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const mod = { kind: "source-text", wrapper, url, source, status: 0, namespace: {} };
      if (handlePtr > 0) {
        const h = context.napiValueFromJsValue(mod);
        dv(memory).setUint32(handlePtr, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (7 args, napi.rs:1576):
    // (napi_env, wrapper, url, context_or_undefined, export_names, synthetic_eval_steps, handle_ptr).
    unofficial_napi_module_wrap_create_synthetic(
      envHandle: number, wrapper: number, url: number, _contextOrUndefined: number,
      exportNames: number, _syntheticEvalSteps: number, handlePtr: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const mod = { kind: "synthetic", wrapper, url, exportNames, status: 0, namespace: {} };
      if (handlePtr > 0) {
        const h = context.napiValueFromJsValue(mod);
        dv(memory).setUint32(handlePtr, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_create_required_module_facade(
      envHandle: number, _handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue({ kind: "required-facade", exports: {} });
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_create_cached_data(
      _envHandle: number, _handle: number, resultOut: number,
    ): number {
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(new ArrayBuffer(0));
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (2 args): (napi_env, handle).
    unofficial_napi_module_wrap_destroy(_envHandle: number, _handle: number): number { return 0; },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_module_requests(
      envHandle: number, _handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue([]);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1639):
    // (napi_env, handle, count, linked_handles_ptr).
    unofficial_napi_module_wrap_link(
      _envHandle: number, _handle: number, _count: number, _linkedHandlesPtr: number,
    ): number { return 0; },
    // Wasm sig (2 args, napi.rs:1666): (napi_env, handle).
    unofficial_napi_module_wrap_instantiate(_envHandle: number, _handle: number): number { return 0; },
    // Wasm sig (5 args, napi.rs:1675):
    // (napi_env, handle, timeout: i64, break_on_sigint, result_ptr).
    unofficial_napi_module_wrap_evaluate(
      envHandle: number, _handle: number, _timeout: bigint, _breakOnSigint: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue(Promise.resolve(undefined));
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (5 args, napi.rs:1700):
    // (napi_env, handle, filename, parent_filename, result_ptr).
    unofficial_napi_module_wrap_evaluate_sync(
      envHandle: number, _handle: number, _filename: number, _parentFilename: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue(undefined);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_namespace(
      envHandle: number, handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const mod = context.jsValueFromNapiValue(handle) as { namespace?: object } | undefined;
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(mod?.namespace ?? {});
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, status_ptr).  status_ptr is i32.
    unofficial_napi_module_wrap_get_status(
      _envHandle: number, _handle: number, statusOut: number,
    ): number {
      if (statusOut > 0) dv(memory).setInt32(statusOut, 4, true); // 4 = Evaluated
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_error(
      envHandle: number, _handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue(undefined);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_module_source_object(
      envHandle: number, _handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        const h = context.napiValueFromJsValue(undefined);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, source_object).
    unofficial_napi_module_wrap_set_module_source_object(
      _envHandle: number, _handle: number, _sourceObject: number,
    ): number { return 0; },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).  result_ptr is u8.
    unofficial_napi_module_wrap_has_top_level_await(
      _envHandle: number, _handle: number, resultOut: number,
    ): number {
      if (resultOut > 0) dv(memory).setUint8(resultOut, 0);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).  result_ptr is u8.
    unofficial_napi_module_wrap_has_async_graph(
      _envHandle: number, _handle: number, resultOut: number,
    ): number {
      if (resultOut > 0) dv(memory).setUint8(resultOut, 0);
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1818):
    // (napi_env, module_wrap, warnings, settled_ptr).  settled_ptr is u8.
    // Wasm reads `*settled_ptr` as "settled? 1 : 0".  Default to settled (1)
    // since our module_wrap_* impls don't host top-level await semantics —
    // returning 0 (unsettled) triggers edge's kUnsettledTopLevelAwait exit
    // path (code 13) at the end of every run.  See NOTES.md 2026-05-20.
    unofficial_napi_module_wrap_check_unsettled_top_level_await(
      _envHandle: number, _moduleWrap: number, _warnings: number, settledOut: number,
    ): number {
      if (settledOut > 0) dv(memory).setUint8(settledOut, 1);
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1846):
    // (napi_env, handle, export_name, export_value).
    unofficial_napi_module_wrap_set_export(
      _envHandle: number, _handle: number, _exportName: number, _exportValue: number,
    ): number { return 0; },
    // Stub in Rust (napi.rs:5249) takes 4 raw i32 args (a, b, c, d) and
    // returns 1.  We mirror: return 1 = napi_invalid_arg.
    unofficial_napi_module_wrap_import_module_dynamically(
      _a: number, _b: number, _c: number, _d: number,
    ): number {
      return 1;
    },
    // Wasm sig (2 args): (napi_env, callback).
    unofficial_napi_module_wrap_set_import_module_dynamically_callback(
      _envHandle: number, _callback: number,
    ): number { return 0; },
    // Wasm sig (2 args): (napi_env, callback).
    unofficial_napi_module_wrap_set_initialize_import_meta_object_callback(
      _envHandle: number, _callback: number,
    ): number { return 0; },

    // --- end of #!~debt batch ---
    // Anything not listed here falls through to the generic per-namespace
    // stub from imports-generated.ts (returns 0 for the `napi` namespace).
  };
  return impls;
}

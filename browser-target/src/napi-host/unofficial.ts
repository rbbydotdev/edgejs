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
import {
  collectSwUrls,
  detectTopLevelAwait,
  extractModuleRequests,
  releaseBlobUrls,
  synthesizeUrl,
  type ModuleRecord,
} from "./esm-registry";

// Capture native text-codec instances at module load.  Edge mutates
// globalThis.TextEncoder/Decoder mid-boot with a polyfill that goes
// through V8 string ops we don't host — same root cause as #14.
// See NOTES.md 2026-05-20 "uv_cwd EIO: attempt #6".
const decoder = new TextDecoder();

// Host-owned payload store for unofficial_napi_{serialize,deserialize,release}_value.
// Stores cloned JS values (via browser-native structuredClone) keyed by an
// opaque ID.  See implementation comments above unofficial_napi_serialize_value
// for why this exists (napi handle scopes don't survive across callbacks;
// MessagePort queue payloads need cross-callback lifetime — e31 finding).
// Values are kept as cloned JS objects (not bytes) because browsers don't
// expose a "serialize structuredClone to bytes" API; storing the cloned
// object directly is both simpler and lossless across structured-cloneable
// types — e32.
const serializedPayloadStore = new Map<number, unknown>();
let nextSerializedPayloadId = 1;

export interface UnofficialHostContext {
  context: Context;
  memory: WebAssembly.Memory;
  /** The Env we created during `unofficial_napi_create_env`; lookup table by env handle. */
  envs: Map<number, Env>;
  /** Holder for the env that v2's init flow created.  V2's
   *  `napiModule.init({instance})` allocates a struct via our
   *  `emnapi_create_env` stub (instance-proxy.ts), writes the resulting
   *  env's id at struct+24, then deletes `napiModule.envObject`
   *  (emnapi-core.js:407).  The Env survives via the module-level
   *  `emnapiEnv` reference and the Context's envStore.
   *
   *  After napiModule.init, bindInstance reads the env id from memory
   *  and stashes the Env here.  `unofficial_napi_create_env` reuses it
   *  rather than calling `context.createEnv` (whose v1 positional
   *  signature is different from v2's `(filename, version, bridge,
   *  nodeBinding?)`).  On v1, this holder stays null and the v1
   *  fallback path creates an env itself. */
  v2InitEnvHolder?: { value: Env | null };
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

// Deep cycle-preserving clone — used by the napi serialize fallback
// when V8's native structuredClone throws (this V8 build throws on
// cyclic objects despite the HTML structured-clone spec supporting
// cycles).  Produces an INDEPENDENT tree with cycle identity preserved
// — receiver gets a copy, not a reference.  Covers the type set
// structured-clone supports: ArrayBuffer (sliced), TypedArrays,
// DataView, Map, Set, Date, RegExp, Error, Array, plain object.
// Other types fall through unchanged (matches structuredClone
// "DataCloneError" surface — but our caller already silently fell
// back to passing the source through, so we preserve that liveness).
function deepCycleClone(
  value: unknown,
  seen: Map<object, unknown> = new Map(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    // TypedArray or DataView: new view over a copied AB.
    const tv = value as ArrayBufferView;
    const Ctor = tv.constructor as new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView;
    const srcAb = tv.buffer.slice(tv.byteOffset, tv.byteOffset + tv.byteLength);
    let copy: ArrayBufferView;
    if (tv instanceof DataView) {
      copy = new DataView(srcAb, 0, tv.byteLength);
    } else {
      const elementSize = (tv as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
      copy = new Ctor(srcAb, 0, tv.byteLength / elementSize);
    }
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof RegExp) {
    const copy = new RegExp(value.source, value.flags);
    copy.lastIndex = value.lastIndex;
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Error) {
    const ECtor = (value.constructor as ErrorConstructor) || Error;
    const copy = new ECtor((value as Error).message);
    if ((value as Error).name) (copy as Error).name = (value as Error).name;
    if ((value as Error).stack) (copy as Error).stack = (value as Error).stack;
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);  // insert BEFORE recursing for cycles
    for (const [k, v] of value) {
      copy.set(deepCycleClone(k, seen), deepCycleClone(v, seen));
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(deepCycleClone(item, seen));
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = new Array(value.length);
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      copy[i] = deepCycleClone(value[i], seen);
    }
    return copy;
  }
  // Plain object (or close enough — structured-clone collapses non-plain
  // class instances to plain objects with own enumerable properties).
  const copy: Record<string | symbol, unknown> = {};
  seen.set(value, copy);
  for (const k of Object.keys(value)) {
    copy[k] = deepCycleClone((value as Record<string, unknown>)[k], seen);
  }
  return copy;
}

// Swap ArrayBuffer references in a structured-clone-produced tree with
// the pre-computed copies in `abCopies`.  Used by the with-transfer
// impl to work around this V8's structuredClone returning the same AB
// reference instead of a copy.
//
// No depth bound: the visited WeakSet handles cycles (each container
// is walked at most once), so unbounded recursion is safe.  Covers
// every container the HTML structured-clone spec preserves:
//   - Array, plain object (incl null-prototype)
//   - Map, Set
//   - TypedArrays + DataView (rebound to copied ABs in-place)
// Other host objects (Date, RegExp, Error, Blob, ...) don't carry AB
// references so they're returned untouched.
function swapArrayBufferRefs(
  value: unknown,
  abCopies: Map<ArrayBuffer, ArrayBuffer>,
  visited: WeakSet<object> = new WeakSet(),
): unknown {
  if (value instanceof ArrayBuffer) {
    return abCopies.get(value) ?? value;
  }
  if (value === null || typeof value !== "object") return value;
  if (visited.has(value)) return value;
  visited.add(value);

  // TypedArrays + DataView: if their underlying AB was transferred,
  // rebind the view onto the copy.  Returns a new view (TypedArray
  // .buffer is read-only).
  if (ArrayBuffer.isView(value)) {
    const tv = value as ArrayBufferView;
    const replacement = abCopies.get(tv.buffer as ArrayBuffer);
    if (!replacement) return value;
    const Ctor = tv.constructor as new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => ArrayBufferView;
    if (tv instanceof DataView) {
      return new DataView(replacement, tv.byteOffset, tv.byteLength);
    }
    const elementSize = (tv as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    return new Ctor(replacement, tv.byteOffset, tv.byteLength / elementSize);
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = swapArrayBufferRefs(value[i], abCopies, visited);
    }
    return value;
  }
  if (value instanceof Map) {
    // Build a fresh Map so swapped entries replace originals cleanly
    // (mutating a Map mid-iteration is brittle across runtimes).
    const out = new Map<unknown, unknown>();
    for (const [k, val] of value) {
      out.set(
        swapArrayBufferRefs(k, abCopies, visited),
        swapArrayBufferRefs(val, abCopies, visited),
      );
    }
    return out;
  }
  if (value instanceof Set) {
    const out = new Set<unknown>();
    for (const item of value) out.add(swapArrayBufferRefs(item, abCopies, visited));
    return out;
  }
  // Plain object (or null-prototype).  structuredClone collapses
  // other class instances to plain objects so the cloned tree never
  // contains class-instance containers with hidden state.
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const k of Object.keys(value)) {
      (value as Record<string, unknown>)[k] = swapArrayBufferRefs(
        (value as Record<string, unknown>)[k], abCopies, visited,
      );
    }
  }
  return value;
}

function dv(memory: WebAssembly.Memory): DataView {
  return new DataView(memory.buffer);
}

export function createUnofficialNapi(ctx: UnofficialHostContext): Record<string, Function> {
  const { context, memory, envs, v2InitEnvHolder } = ctx;

  // Tracks "scope handle ID" → "env ID" so we can release scopes by their
  // own handle, which is what wasm passes back.
  const scopeToEnv = new Map<number, number>();

  // ESM host state — callbacks registered by lib's loader bootstrap
  // (set_import_module_dynamically_callback, set_initialize_import_meta_object_callback).
  // Stored here so the blob-trampoline can call them during dynamic
  // import resolution (Phase 3) and import.meta initialization (Phase 4).
  const esmHostState: {
    dynamicImportCallback: ((...a: unknown[]) => unknown) | null;
    initializeImportMetaCallback: ((...a: unknown[]) => unknown) | null;
  } = { dynamicImportCallback: null, initializeImportMetaCallback: null };

  // Per-record store for ESM modules.  napi handles don't survive past
  // the scope of the originating call (emnapi releases them), but our
  // records need to outlive create→link→instantiate→evaluate→destroy.
  // We allocate a stable u32 ID and write that as the wasm-visible
  // handle; C++ stores it as `void*` (uint32 in wasm32) and round-
  // trips it via every subsequent call.  Lookups by ID are O(1).
  const esmRecords = new Map<number, ModuleRecord>();
  let esmNextRecordId = 1;
  function registerEsmRecord(record: ModuleRecord): number {
    const id = esmNextRecordId++;
    esmRecords.set(id, record);
    return id;
  }
  function getEsmRecord(handleOrId: number): ModuleRecord | undefined {
    return esmRecords.get(handleOrId);
  }
  function dropEsmRecord(handleOrId: number): void {
    esmRecords.delete(handleOrId);
  }

  // Install the browser-side hooks the blob preamble calls into.
  // `__edgeDynImportImpl(specifier, parentUrl)` routes to lib's stored
  // dynamic-import callback (Phase 3).  `__edgeImportMetaFactory(url)`
  // builds an import.meta whose properties any registered
  // `initializeImportMetaCallback` (Phase 4) populates.  Both globals
  // are namespaced under `__edge*` so they don't conflict with user
  // code or other deployments.
  (() => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g.__edgeDynImportImpl) {
      g.__edgeDynImportImpl = (specifier: string, parentUrl: string): Promise<unknown> => {
        const cb = esmHostState.dynamicImportCallback;
        if (typeof cb === "function") {
          try {
            // Lib's `importModuleDynamicallyCallback` signature is
            // (referrerSymbol, specifier, phase, attributes, referrerName).
            // The `esm-via-blob-import` policy installs a wrapper at
            // that name that prefers a per-URL registry (looked up by
            // referrerName) over the symbol-based dispatch.  We don't
            // know the referrerSymbol from the browser-V8 side; pass
            // null and rely on referrerName=parentUrl to route to the
            // per-module vm.SourceTextModule.importModuleDynamically.
            // Phase 2 = kEvaluationPhase (matches binding_module_wrap.cc).
            const result = (cb as (
              s: unknown, spec: string, phase: number, attrs: object, name: string,
            ) => unknown)(null, specifier, 2, {}, parentUrl);
            return Promise.resolve(result).then((mod) => {
              // Lib's callback returns either a vm.Module (its
              // namespace getter resolves the actual Module Namespace
              // Object) or a raw Module Namespace Object directly.
              // The per-module wrapper (importModuleDynamicallyWrap in
              // vm/module.js:522-544) returns m.namespace directly,
              // so the top branch covers both cases.
              if (mod && typeof mod === "object" && "namespace" in (mod as object)) {
                return (mod as { namespace: unknown }).namespace;
              }
              return mod;
            });
          } catch (e) {
            return Promise.reject(e);
          }
        }
        // No callback registered — fall through to native browser
        // import (works for absolute URLs like blob: / data: / https:).
        return import(/* @vite-ignore */ specifier);
      };
    }
    if (!g.__edgeImportMetaFactory) {
      g.__edgeImportMetaFactory = (
        url: string,
        resolveMap?: Record<string, string>,
      ): Record<string, unknown> => {
        // `resolveMap` is baked per-module by `synthesizePreamble` from
        // the record's static-import dep URLs.  `import.meta.resolve`
        // returns the bound URL for known specifiers and falls back to
        // `new URL(specifier, base).href` for absolute / scheme-prefixed
        // specifiers, matching Node's default resolver behavior for the
        // synchronous form.  Throws on unresolvable bare specifiers
        // (matches Node's ERR_MODULE_NOT_FOUND).
        const map = resolveMap ?? {};
        const NativeURL = (globalThis as { __edgeNativeURL?: typeof URL }).__edgeNativeURL ?? URL;
        const meta: Record<string, unknown> = {
          url,
          resolve(specifier: string): string {
            // 1. Statically-known specifier from the importing module's
            //    `link()` deps — return its bound URL.
            if (Object.prototype.hasOwnProperty.call(map, specifier)) return map[specifier]!;
            // 2. Already-absolute specifier (https://, file://, data:, blob:, etc.)
            //    — `new URL(spec)` parses without a base.
            try { return new NativeURL(specifier).href; } catch { /* fall through */ }
            // 3. Base URL is itself absolute — Node default resolver
            //    behavior: `new URL(spec, base).href`.  Identifiers like
            //    "parent.mjs" without a scheme don't qualify; skip.
            try {
              const base = new NativeURL(url);
              void base;
              return new NativeURL(specifier, url).href;
            } catch { /* fall through */ }
            // 4. No resolution possible — throw a Node-ish error.
            const err = new Error(
              "edge.js: import.meta.resolve(" + JSON.stringify(specifier) +
              ") — not a static import of this module, not absolute, " +
              "and no absolute base URL (base=" + url + ")",
            );
            (err as { code?: string }).code = "ERR_MODULE_NOT_FOUND";
            throw err;
          },
        };
        const cb = esmHostState.initializeImportMetaCallback;
        if (typeof cb === "function") {
          // Lib's callback receives (meta, wrap) and populates meta
          // in-place.  Runs after we've installed `resolve` so lib can
          // override it with the official loader-resolver if it wants.
          try { cb(meta, undefined); } catch { /* keep whatever was set */ }
        }
        return meta;
      };
    }
  })();

  /** Drive the browser's real ESM machinery for `record`.  Mints
   *  blob URLs for the whole linked subgraph, calls `import(rootUrl)`,
   *  captures the namespace.  Caches the eval Promise so concurrent
   *  evaluate calls for the same record share one browser import. */
  function evaluateRecord(record: ModuleRecord): Promise<unknown> {
    if (record.status === 4) return Promise.resolve(record.namespace);
    if (record.status === 5 && record.error !== undefined) return Promise.reject(record.error);
    // Re-use an in-flight eval promise if one is already running.
    const inflight = (record as ModuleRecord & { _evalPromise?: Promise<unknown> })._evalPromise;
    if (inflight) return inflight;
    record.status = 3; // kEvaluating
    const p = (async () => {
      try {
        // synthesizeUrl picks the right path (blob: for cycle-free
        // graphs, /_edge_esm/<id> via the SW for cyclic ones).  Both
        // produce URLs the browser's `import()` can resolve.
        const url = await synthesizeUrl(record);
        const ns = await import(/* @vite-ignore */ url);
        // Live-binding semantics: keep the real Module Namespace
        // Object as the record's namespace.  V8 exposes each export
        // as a live getter that reads the underlying binding cell on
        // every access — patterns like `import * as ns from './a';
        // setTimeout(() => console.log(ns.x))` see the current value
        // when the timeout fires, not the value at import time.
        //
        // Earlier the namespace was snapshotted via `Object.keys` +
        // own-prop copy at evaluate completion, which broke modules
        // that mutate their exports after evaluation (e.g.
        // `export let counter = 0; export function tick(){counter++;}`
        // — importers calling tick() would see counter stay at 0
        // because the snapshot froze it).  Module Namespace Objects
        // are not Proxy-typed but behave like one for property access
        // and Object.keys/Reflect.ownKeys; lib's namespace consumers
        // (the kWrap.getNamespace() path) hand it back unmodified.
        //
        // For synthetic modules that already populated
        // record.namespace via runSyntheticEvalSteps, we still want
        // to expose the browser's namespace because some consumers
        // walk Module Namespace Object slots directly.  The shape
        // matches what we put in (JSON-stringified then re-parsed),
        // so external behavior is unchanged.
        record.namespace = ns as Record<string, unknown>;
        record.status = 4; // kEvaluated
        return ns;
      } catch (e) {
        record.error = e;
        record.status = 5; // kErrored
        throw e;
      }
    })();
    (record as ModuleRecord & { _evalPromise?: Promise<unknown> })._evalPromise = p;
    return p;
  }

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
      // and stashes the result; bindInstance recovers it via memory
      // readback into `v2InitEnvHolder.value` since `napiModule.envObject`
      // gets deleted at emnapi-core.js:407 right after init), reuse it.
      // Calling `context.createEnv` again with v1 positional args would
      // fail because v2's signature wants a `bridge` object as the 3rd
      // arg, not a `makeDynCall_vppp` function.
      //
      // V1 fallback: `v2InitEnvHolder` is null; we create the env
      // ourselves using v1's positional signature.
      let env: Env;
      const existingEnv = v2InitEnvHolder?.value;
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
      // CRITICAL: pick the env value that wasm-side callbacks will
      // receive.  In v2, when a JS callback created via napi_create_function
      // is invoked, emnapi passes `envObject.bridge.address` (a wasm
      // pointer) as the napi_env arg — NOT `envObject.id` (the small
      // integer the Context.envStore is keyed on).  Edge.js's wasm code
      // stores per-env state (like ModuleLoaderState for the
      // `internalBinding()` resolver) keyed by whatever it received from
      // `unofficial_napi_create_env`; the same value MUST come back in
      // callbacks or `GetModuleLoaderState(env)` lookups miss.
      //
      // V1 envs don't have a `bridge` field — env.id IS the value
      // callbacks receive.  Branch on presence.
      const envBridgeAddress = (env as unknown as { bridge?: { address: number } }).bridge?.address;
      const envHandle = envBridgeAddress !== undefined ? envBridgeAddress : Number(env.id);
      envs.set(envHandle, env);

      // e40+ — publish the envHandle so the policy's uv_async_t
      // keepalive can fetch the env's loop pointer (via
      // napi_get_uv_event_loop) and register handles there instead
      // of on uv_default_loop().  edge.js's Environment::EnsureEventLoop
      // creates a fresh heap-allocated uv_loop_t per env (not the
      // default loop), so registering on uv_default_loop() puts our
      // keepalive on the WRONG loop and uv_run sees an empty loop.
      // See experiments/e40-cpp-debugger/FINDINGS.md.
      (globalThis as { __edgeNapiHost?: { envHandle?: number } }).__edgeNapiHost =
        Object.assign(
          (globalThis as { __edgeNapiHost?: object }).__edgeNapiHost ?? {},
          { envHandle },
        );

      const scope = context.openScope(env);
      scopeToEnv.set(Number(scope.id), envHandle);

      const view = dv(memory);
      if (envOutPtr > 0) view.setUint32(envOutPtr, envHandle, true);
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
      try {
        cloned = (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone?.(v) ?? v;
      } catch {
        // V8 structuredClone throws on cycles in this build; fall back
        // to our deep cycle-preserving clone.
        try { cloned = deepCycleClone(v); } catch { cloned = v; }
      }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(cloned);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args, napi.rs:689):
    // (napi_env, value, transfer_list, result_ptr).
    //
    // e34+ Phase 4b strict detach: the transfer list is an Array of
    // ArrayBuffers (built by C++ CreateArrayBufferTransferList).  Pass
    // them through to the browser's native structuredClone so source
    // ABs get detached (HTML spec: transferList entries are neutered
    // on the source side as part of the clone).
    //
    // The C++ caller (CloneMessageValueWithTransfers) already filters
    // the list to ArrayBuffer-only entries (MessagePort/etc. are
    // handled separately via TransferredPortEntry).
    unofficial_napi_structured_clone_with_transfer(
      envHandle: number, valueHandle: number, transferList: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      // Resolve the transfer-list napi_value to a JS array of items.
      const transferItems: Transferable[] = [];
      if (transferList > 0) {
        const tl = context.jsValueFromNapiValue(transferList);
        if (Array.isArray(tl)) {
          for (const item of tl) {
            // Only include genuine Transferable shapes to avoid
            // structuredClone throwing on garbage entries.
            if (item instanceof ArrayBuffer
                || (typeof MessagePort !== "undefined" && item instanceof MessagePort)
                || (typeof OffscreenCanvas !== "undefined" && item instanceof OffscreenCanvas)) {
              transferItems.push(item as Transferable);
            }
          }
        }
      }
      // V8 in this DedicatedWorker silently ignores structuredClone's
      // {transfer} option AND returns the SAME ArrayBuffer reference
      // (not a copy) when cloning a plain AB.  That means we can't
      // rely on structuredClone alone to produce a tree with
      // independent AB storage — when we then detach the source AB,
      // the clone empties too.
      //
      // Fix: walk the transfer list, pre-compute an independent copy
      // of each AB via .slice(0), then structuredClone with a swap so
      // every reference to a source AB in the clone tree becomes the
      // copy reference.  Finally, detach the originals via .transfer().
      let cloned: unknown;
      if (transferItems.length === 0) {
        try {
          cloned = structuredClone(v);
        } catch {
          // Cyclic input — V8 structuredClone throws.  Deep clone via
          // our cycle-preserving helper instead of silently dropping
          // to a same-reference fallback.
          try { cloned = deepCycleClone(v); } catch { cloned = v; }
        }
      } else {
        // Pre-compute AB copies for each transfer item.
        const abCopies = new Map<ArrayBuffer, ArrayBuffer>();
        for (const item of transferItems) {
          if (item instanceof ArrayBuffer && !abCopies.has(item)) {
            abCopies.set(item, item.slice(0));
          }
        }
        try {
          cloned = structuredClone(v);
        } catch {
          // Cyclic input — use deep cycle-preserving clone.
          try { cloned = deepCycleClone(v); } catch { cloned = v; }
        }
        // Replace references to source ABs in the clone tree with copies.
        // Top-level case is the common one (cloned === some source AB).
        // For nested cases we do a bounded BFS walk over enumerable own
        // properties; depth-limit + visited set guard against cycles.
        cloned = swapArrayBufferRefs(cloned, abCopies);
        // Detach the originals — per HTML structured-clone spec, the
        // source ArrayBuffers must be neutered.
        for (const item of transferItems) {
          if (item instanceof ArrayBuffer) {
            const ab = item as ArrayBuffer & { transfer?: () => ArrayBuffer };
            if (typeof ab.transfer === "function") {
              try { ab.transfer(); } catch { /* already detached */ }
            }
          }
        }
      }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(cloned);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
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
    //
    // The "payload" handle returned here is stored by C++ (e.g. in the
    // MessagePort queue) and may be passed back to
    // `unofficial_napi_deserialize_value` from a DIFFERENT napi callback
    // scope.  Two problems we used to have:
    //
    //   1. Returning a napi_value handle didn't survive napi handle
    //      scoping — handle was freed before deserialize fired.  Fixed
    //      by storing on a host-owned Map keyed by opaque ID (e31).
    //
    //   2. JSON serialization lost everything beyond primitives + plain
    //      objects: ArrayBuffer/TypedArray/Map/Set/Date/RegExp arrived as
    //      `{}` or `null`.  transferList silently no-op'd.  Fixed by
    //      using browser-native `structuredClone()` which handles all
    //      structured-cloneable types AND transferList detach semantics
    //      (e32).
    //
    // The stored value is the cloned JS object itself, not bytes.  Bypasses
    // a serialize-to-bytes step entirely — no public "serialize structured
    // clone to bytes" API in browsers; storing the cloned object directly
    // is both simpler and lossless.  C++ never inspects the payload
    // contents (just stores the opaque ID), so it doesn't care.
    //
    // The signature exposed to wasm has no transferList parameter —
    // upstream `unofficial_napi_serialize_value` is (env, value,
    // payload_out).  Per-payload transferList plumbing through the napi
    // boundary is the next experiment (e33+); for now, transferList is
    // ignored at this layer.  The C++ caller in binding_messaging.cc
    // pre-processes transferList via PrepareTransferableDataForStructuredClone
    // so most transfer semantics happen above us anyway.
    unofficial_napi_serialize_value(
      envHandle: number, valueHandle: number, payloadOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const v = context.jsValueFromNapiValue(valueHandle);
      let cloned: unknown;
      try {
        cloned = structuredClone(v);
      } catch (e) {
        void e;
        // V8 structuredClone in this build throws on cyclic objects
        // despite the HTML spec supporting cycles.  Use our deep
        // cycle-preserving clone — produces an INDEPENDENT tree with
        // cycle identity preserved.  Receiver gets a copy, not a
        // reference (Node-spec-strict).
        try { cloned = deepCycleClone(v); }
        catch { cloned = v; }
      }
      if (payloadOut > 0) {
        const id = nextSerializedPayloadId++;
        serializedPayloadStore.set(id, cloned);
        dv(memory).setUint32(payloadOut, id, true);
      }
      return 0;
    },
    // Wasm sig (3 args, napi.rs:725): (napi_env, payload, result_out_ptr).
    unofficial_napi_deserialize_value(
      envHandle: number, payloadHandle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      // `has` distinguishes "stored undefined" from "missing id".
      const value = serializedPayloadStore.has(payloadHandle)
        ? serializedPayloadStore.get(payloadHandle)
        : null;
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(value);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (1 arg, napi.rs:737): (payload) → void.
    unofficial_napi_release_serialized_value(payload: number): void {
      serializedPayloadStore.delete(payload);
    },

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
        // Surface as a NAPI exception so user code sees it instead of
        // silently getting nothing.  Followup e33: previously we just
        // console.warn'd and returned 1, leaving the caller with no
        // diagnostic — user code that hit the threshold (~7-8 KB
        // scripts, root cause TBD) saw "no output, exit=0" with no
        // visible error.  Now the underlying error name/message + the
        // source size are exposed so callers can at least see the
        // failure and report it.
        const err = e as Error;
        const sizeNote = `(source size: ${source.length} chars)`;
        const detail = err && err.message ? `${err.name || "Error"}: ${err.message} ${sizeNote}` : `${String(e)} ${sizeNote}`;
        // Best-effort visibility — old code did `console.warn` only,
        // which left user code with no signal beyond a silent return 1.
        // Wire to the host log channel so the line surfaces in the
        // browser-test-runner's tail logs at level "err".
        ctx.postLog?.(`contextify_run_script failed — ${detail}`, "err");
        console.warn("contextify_run_script failed —", detail);
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
    // and SyntheticModule.  Each call now lands on a real record managed
    // by `esm-registry.ts`.  Phase 1: blob-URL trampoline drives static
    // ESM with full V8 semantics.  Phases 2-4 layer TLA, dynamic
    // import(), and import.meta atop the same registry.

    // Wasm sig (9 args, napi.rs:1534):
    // (napi_env, wrapper, url, context_or_undefined, source, line_offset,
    //  column_offset, cached_data_or_id, handle_ptr).
    unofficial_napi_module_wrap_create_source_text(
      envHandle: number, wrapper: number, urlHandle: number, _contextOrUndefined: number,
      sourceHandle: number, _lineOffset: number, _columnOffset: number,
      _cachedDataOrId: number, handlePtr: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const url = String(context.jsValueFromNapiValue(urlHandle) ?? "");
      const source = String(context.jsValueFromNapiValue(sourceHandle) ?? "");
      const record: ModuleRecord = {
        kind: "source-text", wrapper, url, source,
        deps: [], status: 0, namespace: {},
        hasTla: detectTopLevelAwait(source),
        hasAsyncGraph: false,
      };
      if (handlePtr > 0) {
        dv(memory).setUint32(handlePtr, registerEsmRecord(record), true);
      }
      return 0;
    },
    // Wasm sig (7 args, napi.rs:1576):
    // (napi_env, wrapper, url, context_or_undefined, export_names, synthetic_eval_steps, handle_ptr).
    unofficial_napi_module_wrap_create_synthetic(
      envHandle: number, wrapper: number, urlHandle: number, _contextOrUndefined: number,
      exportNamesHandle: number, syntheticEvalStepsHandle: number, handlePtr: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const url = String(context.jsValueFromNapiValue(urlHandle) ?? "");
      const exportNamesRaw = context.jsValueFromNapiValue(exportNamesHandle);
      const exportNames = Array.isArray(exportNamesRaw) ? exportNamesRaw.map(String) : [];
      // Capture the synthetic eval steps function as a host-JS
      // reference.  GC keeps it alive as long as the record lives,
      // independent of the napi handle's scope.  JSON imports drive
      // this path: lib's translator gives us a `function() {
      // this.setExport('default', parsedJson); }`.
      const evalStepsRaw = context.jsValueFromNapiValue(syntheticEvalStepsHandle);
      const syntheticEvalSteps = typeof evalStepsRaw === "function"
        ? evalStepsRaw as ModuleRecord["syntheticEvalSteps"]
        : undefined;
      const record: ModuleRecord = {
        kind: "synthetic", wrapper, url, exportNames,
        deps: [], status: 0, namespace: {},
        hasTla: false, hasAsyncGraph: false,
        syntheticEvalSteps,
      };
      if (handlePtr > 0) {
        dv(memory).setUint32(handlePtr, registerEsmRecord(record), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_create_required_module_facade(
      envHandle: number, _handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (env && resultOut > 0) {
        // CJS facade is unused until Phase 5 (require(esm) interop) —
        // return a sentinel record so the handle round-trips.
        const record: ModuleRecord = {
          kind: "required-facade", wrapper: 0, url: "",
          deps: [], status: 4, namespace: {},
          hasTla: false, hasAsyncGraph: false,
        };
        dv(memory).setUint32(resultOut, registerEsmRecord(record), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).  Code cache —
    // we return an empty AB so lib's cache-write path no-ops cleanly.
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
    unofficial_napi_module_wrap_destroy(_envHandle: number, handle: number): number {
      const record = getEsmRecord(handle);
      if (record && record.deps !== undefined) {
        try { releaseBlobUrls(record); } catch { /* best effort */ }
        // Collect SW URLs first (this also clears `swUrl` from the
        // records to avoid double-publishing on a subsequent evaluate
        // of a recreated wrap), then notify the SW so its in-memory
        // source registry can drop the entries.
        const swPaths = collectSwUrls(record);
        if (swPaths.length > 0) {
          self.postMessage({ kind: "edge-esm-clear", paths: swPaths });
        }
      }
      dropEsmRecord(handle);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    // Returns the static import requests in source order.  lib's loader
    // uses this list to drive resolve/load for each dep.
    unofficial_napi_module_wrap_get_module_requests(
      envHandle: number, handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      let result: unknown[] = [];
      if (record?.kind === "source-text" && record.source) {
        if (!record.requests) record.requests = extractModuleRequests(record.source);
        result = record.requests;
      }
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(result);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1639):
    // (napi_env, handle, count, linked_handles_ptr).  linked_handles_ptr
    // points at an array of napi_value (u32 each) of length `count`.
    unofficial_napi_module_wrap_link(
      _envHandle: number, handle: number, count: number, linkedHandlesPtr: number,
    ): number {
      const record = getEsmRecord(handle);
      if (!record) return 1;
      const deps: ModuleRecord[] = [];
      if (count > 0 && linkedHandlesPtr > 0) {
        const view = dv(memory);
        for (let i = 0; i < count; i++) {
          const depHandle = view.getUint32(linkedHandlesPtr + i * 4, true);
          const dep = getEsmRecord(depHandle);
          if (dep) deps.push(dep);
        }
      }
      record.deps = deps;
      // Aggregate async-graph status: any dep with TLA / async graph
      // propagates up to us.
      record.hasAsyncGraph = record.hasTla || deps.some((d) => d.hasTla || d.hasAsyncGraph);
      // V8 transitions status from kUninstantiated → kInstantiated as
      // part of link.  We mirror so lib's `evaluate()` pre-check
      // (vm/module.js:226 — must be kInstantiated/kEvaluated/kErrored)
      // is satisfied without the user manually calling instantiate.
      if (record.status < 2) record.status = 2; // kInstantiated
      return 0;
    },
    // Wasm sig (2 args, napi.rs:1666): (napi_env, handle).
    // Optional explicit instantiate step — link already transitions to
    // kInstantiated.  No-op here unless coming in cold (status < 2).
    unofficial_napi_module_wrap_instantiate(_envHandle: number, handle: number): number {
      const record = getEsmRecord(handle);
      if (record && record.status < 2) record.status = 2; // kInstantiated
      return 0;
    },
    // Wasm sig (5 args, napi.rs:1675):
    // (napi_env, handle, timeout: i64, break_on_sigint, result_ptr).
    // Returns a Promise as a napi value — lib's
    // `await this.module.evaluate(...)` in module_job.js then awaits it.
    // The browser's `import(blobUrl)` does the real V8 ESM dance
    // (link / instantiate / evaluate, including TLA).
    unofficial_napi_module_wrap_evaluate(
      envHandle: number, handle: number, _timeout: bigint, _breakOnSigint: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      if (!record) return 1;
      const evalPromise = evaluateRecord(record);
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(evalPromise);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (5 args, napi.rs:1700):
    // (napi_env, handle, filename, parent_filename, result_ptr).
    // Sync variant — called from `require(esm)` via
    // `internal/modules/esm/module_job.js:ModuleJobSync.runSync`.
    //
    // #!~debt esm-evaluate-sync-jspi-blocked: the browser-target
    // architecture runs user code through `contextify_run_script` (a
    // host-V8 `new Function(source)()`), so the call path from a
    // user-land `require('./x.mjs')` reaches us as
    //   promising _start (JS) → wasm (_start, edge bootstrap)
    //     → host-JS handler for contextify_run_script
    //     → host-JS user code: `require(...)`
    //     → host-JS lib CJS loader → loadESMFromCJS
    //     → host-JS ModuleJobSync.runSync
    //     → host-JS wrap.evaluateSync (napi-bound method)
    //     → wasm C++ ModuleWrapEvaluateSync
    //     → our handler.
    // Multiple host-JS frames sit between the `promising` frame and the
    // `Suspending` import, which JSPI v2 forbids ("trying to suspend
    // JS frames").  No purely wasm-driven call site exists for this
    // entry point in browser-target, so the Suspending wrap that would
    // make the async browser-`import()` look sync to wasm callers can't
    // actually fire.
    //
    // Honest failure: throw a clear error.  Lib catches it from
    // `ModuleJobSync.runSync` and surfaces to the user's `require()`
    // call.  Workaround: refactor the call site to `await import('./x.mjs')`,
    // which goes through `evaluate` (returns a Promise that lib awaits
    // in module_job.js:430 without any sync-suspension constraint).
    unofficial_napi_module_wrap_evaluate_sync(
      envHandle: number, handle: number, _filename: number, _parentFilename: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      if (!record) return 1;
      // Pre-eval cache lookup — see `esm-require-preeval` policy.  The
      // cache is populated either by user-called `edgejs.preloadEsm([...])`
      // or by the policy's boot-time scan of CJS sources for literal
      // `require('./x.mjs')` patterns.  If the URL is in the cache we
      // have a real namespace from a previous `await import()`; return
      // it sync and skip the throw below.  Architecture: handles the
      // ~70% of `require(esm)` cases that have statically-detectable
      // specifiers OR whose URLs the user explicitly enumerated.
      const cache = (globalThis as { __edgePreEvalEsmCache?: Map<string, unknown> })
        .__edgePreEvalEsmCache;
      const cached = cache?.get(record.url);
      if (cached !== undefined) {
        if (resultOut > 0) {
          const h = context.napiValueFromJsValue(cached);
          dv(memory).setUint32(resultOut, Number(h), true);
        }
        record.namespace = cached as Record<string, unknown>;
        record.status = 4; // kEvaluated
        return 0;
      }
      // Cache miss — throw the clear remediation error.  See
      // `#!~debt esm-evaluate-sync-jspi-blocked` and the comment block
      // above this handler for the architectural reason JSPI can't
      // save us here.
      const err = new Error(
        "edge.js: require(esm) couldn't resolve synchronously. " +
        "User code runs in host V8 via contextify_run_script, which puts " +
        "JS frames between JSPI's promising and Suspending boundaries — " +
        "the wasm-side wrap.evaluateSync can't suspend across them. " +
        "Workarounds: (a) refactor the caller to `await import(...)`; " +
        "(b) call `edgejs.preloadEsm(['./x.mjs', ...])` at startup to " +
        "preload specifiers the caller will require synchronously; " +
        "(c) enable the `esm-require-preeval` policy (default-on) and " +
        "use literal-string `require('./x.mjs')` specifiers — the policy " +
        "auto-scans CJS sources at boot.",
      );
      (err as { code?: string }).code = "ERR_REQUIRE_ASYNC_MODULE";
      throw err;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_namespace(
      envHandle: number, handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(record?.namespace ?? {});
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, status_ptr).  status_ptr is i32.
    unofficial_napi_module_wrap_get_status(
      _envHandle: number, handle: number, statusOut: number,
    ): number {
      const record = getEsmRecord(handle);
      if (statusOut > 0) dv(memory).setInt32(statusOut, record?.status ?? 0, true);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    unofficial_napi_module_wrap_get_error(
      envHandle: number, handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(record?.error);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).
    // Source-phase imports — for Wasm-ESM lib's translator at
    // translators.js:625 calls `module.setModuleSourceObject(compiled)`
    // with the `WebAssembly.Module` instance, and the user's
    // `import source X from "./mod.wasm"` resolves to that via the
    // binding_module_wrap.cc:ModuleWrapGetModuleSourceObject C++ shim
    // → us.  Returning undefined makes lib throw ERR_SOURCE_PHASE_NOT_DEFINED.
    unofficial_napi_module_wrap_get_module_source_object(
      envHandle: number, handle: number, resultOut: number,
    ): number {
      const env = envs.get(envHandle);
      if (!env) return 1;
      const record = getEsmRecord(handle);
      if (resultOut > 0) {
        const h = context.napiValueFromJsValue(record?.sourceObject);
        dv(memory).setUint32(resultOut, Number(h), true);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, source_object).
    unofficial_napi_module_wrap_set_module_source_object(
      _envHandle: number, handle: number, sourceObjectHandle: number,
    ): number {
      const record = getEsmRecord(handle);
      if (record) {
        record.sourceObject = context.jsValueFromNapiValue(sourceObjectHandle);
      }
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).  result_ptr is u8.
    unofficial_napi_module_wrap_has_top_level_await(
      _envHandle: number, handle: number, resultOut: number,
    ): number {
      const record = getEsmRecord(handle);
      if (resultOut > 0) dv(memory).setUint8(resultOut, record?.hasTla ? 1 : 0);
      return 0;
    },
    // Wasm sig (3 args): (napi_env, handle, result_ptr).  result_ptr is u8.
    unofficial_napi_module_wrap_has_async_graph(
      _envHandle: number, handle: number, resultOut: number,
    ): number {
      const record = getEsmRecord(handle);
      if (resultOut > 0) dv(memory).setUint8(resultOut, record?.hasAsyncGraph ? 1 : 0);
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1818):
    // (napi_env, module_wrap, warnings, settled_ptr).  settled_ptr is u8.
    // 1 = settled (no unresolved TLA), 0 = unsettled.  Lib's evaluate
    // path now drives V8's real Promise machinery via the blob import,
    // so by the time check is called, evaluate's Promise has resolved
    // (or rejected) and we report settled.
    unofficial_napi_module_wrap_check_unsettled_top_level_await(
      _envHandle: number, _moduleWrap: number, _warnings: number, settledOut: number,
    ): number {
      if (settledOut > 0) dv(memory).setUint8(settledOut, 1);
      return 0;
    },
    // Wasm sig (4 args, napi.rs:1846):
    // (napi_env, handle, export_name, export_value).  For synthetic
    // modules — populate the captured namespace; the blob preamble
    // emitted by `synthesizeBlobUrl` exports each name as `let`.
    unofficial_napi_module_wrap_set_export(
      _envHandle: number, handle: number, exportName: number, exportValue: number,
    ): number {
      const record = getEsmRecord(handle);
      if (!record || record.kind !== "synthetic") return 0;
      const name = String(context.jsValueFromNapiValue(exportName) ?? "");
      if (!name) return 0;
      const value = context.jsValueFromNapiValue(exportValue);
      record.namespace[name] = value;
      return 0;
    },
    // Stub in Rust (napi.rs:5249) takes 4 raw i32 args (a, b, c, d) and
    // returns 1.  We mirror: return 1 = napi_invalid_arg.  The real
    // dynamic-import path runs via `set_import_module_dynamically_callback`
    // (Phase 3), not this entry point.
    unofficial_napi_module_wrap_import_module_dynamically(
      _a: number, _b: number, _c: number, _d: number,
    ): number {
      return 1;
    },
    // Wasm sig (2 args): (napi_env, callback).  Lib's dynamic-import
    // callback — stored here so the blob trampoline (Phase 3) can route
    // browser `import()` calls back into lib's resolver.
    unofficial_napi_module_wrap_set_import_module_dynamically_callback(
      _envHandle: number, callback: number,
    ): number {
      const fn = context.jsValueFromNapiValue(callback);
      esmHostState.dynamicImportCallback = typeof fn === "function"
        ? fn as (...a: unknown[]) => unknown
        : null;
      return 0;
    },
    // Wasm sig (2 args): (napi_env, callback).  Lib's import.meta
    // initializer — stored for Phase 4.
    unofficial_napi_module_wrap_set_initialize_import_meta_object_callback(
      _envHandle: number, callback: number,
    ): number {
      const fn = context.jsValueFromNapiValue(callback);
      esmHostState.initializeImportMetaCallback = typeof fn === "function"
        ? fn as (...a: unknown[]) => unknown
        : null;
      return 0;
    },

    // --- end of #!~debt batch ---
    // Anything not listed here falls through to the generic per-namespace
    // stub from imports-generated.ts (returns 0 for the `napi` namespace).
  };

  // Note: an earlier prototype wrapped `module_wrap_evaluate_sync`
  // with `WebAssembly.Suspending` to make the async browser
  // `import(blobUrl)` appear sync to callers.  Removed because the only
  // browser-target call path (`require(esm)` → CJS loader →
  // ModuleJobSync.runSync → wrap.evaluateSync) reaches us with host-JS
  // frames between JSPI's promising and Suspending — V8 throws
  // "trying to suspend JS frames".  The handler now throws a clear
  // ERR_REQUIRE_ASYNC_MODULE so the failure surfaces cleanly to user
  // code.  See the long comment on
  // `unofficial_napi_module_wrap_evaluate_sync` above and the
  // `#!~debt esm-evaluate-sync-jspi-blocked` entry in NOTES.md.
  return impls;
}

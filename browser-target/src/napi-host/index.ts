// Public surface of the napi host.
//
// `createNapiHost` returns:
//   - `imports`: a Record<string, Record<string, Function>> ready to compose
//     into the wasm imports object.  Contains the `napi`, `env`, and `emnapi`
//     module namespaces emnapi expects.
//   - `bindInstance(instance)`: call after `WebAssembly.instantiate` resolves;
//     this triggers emnapi's `init` flow against a proxy that satisfies its
//     malloc/free/register expectations, and locks in wasmMemory/wasmTable.
//
// Composition order matters: the WASIX shim namespaces (`wasi_*`, `wasix_*`,
// orphan `wasi`) must be merged in by the caller AFTER calling `imports`,
// since this module knows nothing about WASI.

import { createContext, type Context, type Env } from "@emnapi/runtime";
import { createNapiModule, type NapiModule } from "@emnapi/core";
import { createInstanceProxy } from "./instance-proxy";
import { createUnofficialNapi } from "./unofficial";

export interface NapiHostOptions {
  memory: WebAssembly.Memory;
  /** Optional filename for diagnostics; surfaces in stack traces from the env. */
  filename?: string;
}

export interface NapiHost {
  /** The full set of import namespaces this host satisfies: `napi`, `env`, `emnapi`. */
  imports: Record<string, Record<string, Function | WebAssembly.Memory>>;
  /** Call once after `WebAssembly.instantiate` — primes emnapi's internal state. */
  bindInstance(realInstance: WebAssembly.Instance, wasmModule: WebAssembly.Module): void;
  /** Direct access to the emnapi Context (for debugging / probing). */
  context: Context;
  /** Envs created via `unofficial_napi_create_env`, keyed by env ID. */
  envs: Map<number, Env>;
}

export function createNapiHost(opts: NapiHostOptions): NapiHost {
  const context = createContext();
  const envs = new Map<number, Env>();

  // Build emnapi's NapiModule (without instantiating any wasm yet).  This
  // pre-populates `napiModule.imports.napi` with all standard napi_* fns.
  const napiModule: NapiModule = createNapiModule({
    context,
    filename: opts.filename ?? "edgejs",
    asyncWorkPoolSize: 0,
  });

  // Layer our unofficial_napi_* impls into the napi namespace.  This is the
  // ONE place edge-specific behavior is added on top of emnapi.
  const unofficial = createUnofficialNapi({ context, memory: opts.memory, envs });
  for (const [name, fn] of Object.entries(unofficial)) {
    (napiModule.imports.napi as Record<string, Function>)[name] = fn;
  }

  // Ensure env.memory is the shared memory the wasm imports.  emnapi looks at
  // `imports.env.memory` during instantiate if provided.
  (napiModule.imports.env as Record<string, unknown>).memory = opts.memory;

  return {
    imports: napiModule.imports as Record<string, Record<string, Function | WebAssembly.Memory>>,
    context,
    envs,
    bindInstance(realInstance, wasmModule) {
      const proxied = createInstanceProxy(realInstance);
      napiModule.init({
        instance: proxied,
        module: wasmModule,
        memory: opts.memory,
        table: realInstance.exports.__indirect_function_table as WebAssembly.Table,
      });
    },
  };
}

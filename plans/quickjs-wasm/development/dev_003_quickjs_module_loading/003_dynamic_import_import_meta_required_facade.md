# Subtask 003: Dynamic Import, Import Meta, and Required Facade

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented; dynamic import, import-meta, top-level-await, async-graph, and module-request focused checks pass. |
| **Severity** | High | Dynamic import and `require(esm)` are required for V8-like loader parity. |

## Scope

Complete the module-wrap behavior that depends on runtime callbacks:
`import()`, `import.meta`, `evaluateSync(...)`, async graph detection, and
`createRequiredModuleFacade(...)`.

## Write Ownership

Primary files:

- `napi/quickjs/src/quickjs/quickjs.h`
- `napi/quickjs/src/quickjs/quickjs.c`
- `napi/quickjs/src/internal/napi_module_wrap.h`
- `napi/quickjs/src/internal/napi_module_wrap.cc`
- `napi/quickjs/src/unofficial_napi.cc`

Possible supporting files:

- `lib/internal/modules/esm/utils.js` only if QuickJS needs a very narrow
  compatibility adjustment after the native callback is present.

## Dependencies

Depends on subtasks `001_quickjs_module_api_and_record.md` and
`002_node_loader_interop_and_synthetic_modules.md`.

## Required Behavior

- Store the JS dynamic import callback registered by
  `setImportModuleDynamicallyCallback(...)`.
- Patch or wrap QuickJS dynamic import so it calls the registered JS callback
  instead of resolving through a native package loader.
- Preserve import attribute objects and phase values expected by
  `lib/internal/modules/esm/utils.js`.
- Store the JS `import.meta` initializer registered by
  `setInitializeImportMetaObjectCallback(...)`.
- Initialize the QuickJS import-meta object once per module with the owning
  wrapper.
- Implement `evaluateSync(...)` for `require(esm)` and reject async graphs with
  `ERR_REQUIRE_ASYNC_MODULE`.
- Implement `createRequiredModuleFacade(...)` using a source-text facade that
  re-exports the original module and adds `__esModule`.

## Verification Expectations

Add targeted tests for:

- `await import('./esm.mjs')`;
- dynamic import from inside CJS-compiled code;
- `import.meta.url`;
- CJS `require()` of a synchronous ESM file;
- CJS `require()` of an ESM graph with TLA throwing the expected error;
- `__esModule` facade behavior for `require(esm)`.

Run:

```sh
make build-edge-quickjs-cli JOBS=4
cmake --build build-edge-quickjs-cli --target edge -j4
make test-napi-quickjs
```

## Implementation Result

QuickJS dynamic import and import-meta hooks now call the registered JavaScript
callbacks from module-wrap state. Source text modules and contextified scripts
preserve host-defined option symbols so dynamic import from `vm.Script` can
route back through Node's loader callback.

`evaluateSync(...)` evaluates the QuickJS module promise synchronously when it
is already fulfilled and throws the Node-compatible async-module error for
pending graphs. `createRequiredModuleFacade(...)` compiles the standard facade
source, links its `original` request to the existing module, evaluates it, and
returns the facade namespace.

The API carries source-phase import metadata. QuickJS source-phase module value
semantics are still not implemented beyond parsing/introspection because this
task keeps current QuickJS static imports in evaluation phase.

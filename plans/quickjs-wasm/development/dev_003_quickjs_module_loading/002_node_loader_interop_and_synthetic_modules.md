# Subtask 002: Node Loader Interop and Synthetic Modules

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented through explicit host-linked requests and QuickJS C modules for synthetic records. |
| **Severity** | High | CommonJS parity needs the JS ESM translators' synthetic modules to work. |

## Scope

Connect QuickJS source-text module records to Node's JavaScript loader-selected
dependency graph, then implement synthetic modules used by CJS, builtin, JSON,
and facade translators.

## Write Ownership

Primary files:

- `napi/quickjs/src/internal/napi_module_wrap.h`
- `napi/quickjs/src/internal/napi_module_wrap.cc`
- `napi/quickjs/src/unofficial_napi.cc`

Possible supporting files:

- `napi/quickjs/src/internal/napi_util.*`
- `napi/quickjs/tests/`
- `napi/tests/js-native-api/`

Do not add a package resolver under `napi/quickjs/src`.

## Dependencies

Depends on subtask `001_quickjs_module_api_and_record.md`.

## Required Behavior

- During `ModuleWrap.link(...)`, store the linked records by request index.
- During QuickJS module linking/evaluation, install a normalizer/loader that
  maps a parent module URL plus parsed request data to the already linked child
  record.
- Validate duplicate request keys so the same request links to the same module,
  matching the V8 path's `ERR_MODULE_LINK_MISMATCH` behavior.
- Implement `create_synthetic(...)` with `JS_NewCModule(...)` and declared
  exports.
- Run the JS synthetic evaluation callback with `this` bound to the JS wrapper.
- Implement `setExport(...)` so translator callbacks can populate QuickJS
  module exports.
- Ensure CJS translator synthetic wrappers expose named exports, `default`, and
  `module.exports`.

## Important Call Sites

Synthetic modules are created by:

```text
lib/internal/modules/esm/translators.js
```

The most important function to satisfy is `createCJSModuleWrap(...)`, which
builds a `ModuleWrap` around CommonJS execution and calls `this.setExport(...)`
during evaluation.

## Verification Expectations

Targeted checks:

```sh
make build-napi-quickjs
make test-napi-quickjs-only
build-edge-quickjs-cli/edge -e "console.log(require('module') !== undefined)"
```

Add tests for:

- ESM importing a local CJS file with named and default exports;
- ESM importing `node:path`;
- JSON import;
- CJS cache sharing with the ESM loader.

## Implementation Result

`ModuleWrap.link(...)` now validates the linked module count, detects duplicate
request key mismatches, and installs JS-loader-selected dependencies with
`JS_SetModuleRequestModule(...)`. QuickJS does not resolve packages in this
path; Node's JavaScript loaders still own resolution and translator policy.

Synthetic modules use `JS_NewCModule(...)`, declared exports, and
`JS_SetModuleExport(...)`. The C init callback invokes the JavaScript synthetic
evaluation callback with the wrapper as `this`, enabling translator code to
populate exports through `setExport(...)`.

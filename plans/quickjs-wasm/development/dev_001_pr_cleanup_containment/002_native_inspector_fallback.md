# Native inspector fallback

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Native unavailable-inspector fallback exists with known shape limits. |
| **Severity** | Medium | Public inspector import behavior can affect framework startup and metadata expectations. |

## Scope

Keep `lib/inspector.js` donor-clean. Provide the unavailable inspector behavior
from C/C++ instead of patching the shared JavaScript module.

## Dependencies

Depends on `001_shared_runtime_rollback.md`, because `lib/inspector.js` must stay
donor-clean.

## Current Implementation

- `src/internal_binding/binding_inspector.cc` implements
  `internalBinding("inspector")` as a native fallback object.
- `src/internal_binding/dispatch.cc` only routes the `inspector` binding name to
  that resolver.
- `src/edge_module_loader.cc` special-cases the `inspector` builtin at the
  native builtins compile hook, so public `require("inspector")` /
  `require("node:inspector")` return the native fallback without executing
  donor-clean `lib/inspector.js`, which still throws when compiled normally
  with `internalBinding("config").hasInspector === false`.
- The C++ require-builtin bridge also returns the native fallback for direct
  native requests for builtin id `inspector`.
- Keeping `hasInspector` false is important: setting it true activates broad
  bootstrap inspector paths such as console wrapping and async inspector hooks.

## Verification

This passed:

```sh
./build-edge-quickjs-cli/edge -e "const inspector=require('inspector'); console.log(typeof inspector.Session, inspector.url()); try { inspector.open(); } catch (e) { console.log(e.code || e.message); } const s = new inspector.Session(); try { s.connect(); } catch (e) { console.log(e.code || e.message); }"
```

Expected output shape:

```text
function undefined
ERR_INSPECTOR_NOT_AVAILABLE
ERR_INSPECTOR_NOT_AVAILABLE
```

Also passed:

```sh
./build-edge-quickjs-cli/edge -e "console.log(process.features.inspector, internalBinding('config').hasInspector)"
```

Expected:

```text
false false
```

## Status Notes

- `require("inspector")` and `require("node:inspector")` return the same native
  fallback object, and `internalBinding("config").hasInspector` /
  `process.features.inspector` remain false.
- The native public fallback is intentionally smaller than upstream
  `lib/inspector.js`: passive code can import the module, call `url()`, and
  construct `Session`; active APIs such as `open()` and `Session.connect()`
  report `ERR_INSPECTOR_NOT_AVAILABLE`.
- `Session` exposes a small EventEmitter-shaped method surface so passive
  listener setup and `inspector/promises` module initialization work.
- Builtin metadata now reports `inspector` as publicly requireable:
  `internalBinding("builtins").builtinCategories.canBeRequired` includes
  `inspector`, and `cannotBeRequired` does not.

Lightweight probes:

```sh
./build-edge-quickjs-cli/edge -e "const a=require('inspector'); const b=require('inspector'); const c=require('node:inspector'); console.log(typeof a.Session, a.url()); console.log(a===b, a===c); console.log(process.features.inspector, internalBinding('config').hasInspector);"
./build-edge-quickjs-cli/edge -e "const p=require('inspector/promises'); console.log(typeof p.Session, typeof p.open, p.url());"
./build-edge-quickjs-cli/edge -e "const inspector=require('inspector'); const s=new inspector.Session(); console.log(typeof s.on, typeof s.post); try { s.connect(); } catch (e) { console.log(e.code || e.message); }"
./build-edge-quickjs-cli/edge -e "const cats=internalBinding('builtins').builtinCategories; console.log(cats.canBeRequired.includes('inspector'), cats.cannotBeRequired.includes('inspector')); console.log(require('module').builtinModules.includes('inspector'), require('module').builtinModules.includes('node:inspector'));"
```

May 14, 2026 rerun on `/Users/syrusakbary/Development/edgejs` passed these
native QuickJS probes after rebuilding `build-edge-quickjs-cli/edge`. The
`private-poker` app command:

```sh
PORT=3100 /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge npm run start
```

advanced past `ERR_INSPECTOR_NOT_AVAILABLE` and reached a later
`next.config.ts` transform failure:

```text
Error: Failed to get Buffer pointer and length
    at transform (null) {
  code: 'InvalidArg'
}
```

## Ownership

Code ownership for this subtask is `src/internal_binding/binding_inspector.cc`
and the inspector special-cases in `src/edge_module_loader.cc`.

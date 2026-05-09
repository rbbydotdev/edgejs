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

- `src/internal_binding/dispatch.cc` now resolves `internalBinding("inspector")`
  to a native fallback object.
- `src/edge_module_loader.cc` special-cases public builtin require of
  `inspector` / `node:inspector` so `require("inspector")` returns the native
  fallback while `internalBinding("config").hasInspector` remains false.
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
  `lib/inspector.js`: `new inspector.Session()` does not inherit from
  `EventEmitter`, so passive code can import the module and active APIs report
  unavailable, but consumers that attach listeners before calling `connect()`
  will see `typeof session.on === "undefined"`.
- Builtin metadata still reports `inspector` in
  `internalBinding("builtins").builtinCategories.cannotBeRequired` even though
  public `require("inspector")` now succeeds through the native loader
  special-case. That is a contract mismatch to resolve or explicitly document if
  any tests or embedders consume the category metadata.

Lightweight probes:

```sh
./build-edge-quickjs-cli/edge -e "const a=require('inspector'); const b=require('inspector'); const c=require('node:inspector'); console.log(typeof a.Session, a.url()); console.log(a===b, a===c); console.log(process.features.inspector, internalBinding('config').hasInspector);"
./build-edge-quickjs-cli/edge -e "const p=require('inspector/promises'); console.log(typeof p.Session, typeof p.open, p.url());"
./build-edge-quickjs-cli/edge -e "const inspector=require('inspector'); const s=new inspector.Session(); console.log(typeof s.on, typeof s.post); try { s.connect(); } catch (e) { console.log(e.code || e.message); }"
./build-edge-quickjs-cli/edge -e "const cats=internalBinding('builtins').builtinCategories; console.log(cats.canBeRequired.includes('inspector'), cats.cannotBeRequired.includes('inspector')); console.log(require('module').builtinModules.includes('inspector'), require('module').builtinModules.includes('node:inspector'));"
```

## Ownership

Code ownership for this subtask is `src/internal_binding/dispatch.cc` and the
inspector special-case in `src/edge_module_loader.cc`.

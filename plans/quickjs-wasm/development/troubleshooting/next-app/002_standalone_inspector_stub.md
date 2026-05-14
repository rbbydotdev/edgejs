# Next App Standalone: `require("inspector")` Stub

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Unavailable-inspector stub implemented and verified. |
| **Severity** | High | The Next standalone server cannot start while `require("inspector")` throws during module load. |

## Context

After implementing a QuickJS-backed `internalBinding("serdes")`, the
`private-poker` Next.js standalone server advanced past the previous
`require("v8")` failure and reached a new startup error:

```text
Failed to execute builtin 'internal/main/run_main_module':
undefinedError: Inspector is not available
    at NodeError (<input>:447:11)
    at anonymous (<input>:27:13)
```

The app is mounted through:

```text
~/src/ImperfectProtocol/private-poker/wasmer.toml
```

which runs:

```text
/app/server.js
```

from `.next/standalone`.

## Reduction

Next 16 standalone output imports the public `inspector` builtin from startup
logging and profiling helpers:

```text
.next/standalone/node_modules/next/dist/server/lib/app-info-log.js
.next/standalone/node_modules/next/dist/server/lib/cpu-profile.js
```

The immediate startup path only needs `inspector.url()` to be callable and return
`undefined` when no inspector is active.

## Historical Action Plan

1. Keep `internalBinding("config").hasInspector` false so the runtime does not
   claim real inspector support.
2. Keep `lib/inspector.js` donor-clean and add the unavailable-inspector surface
   below the JavaScript library layer.
3. Make passive APIs such as `url()`, `close()`, and `Network` hooks no-op.
4. Keep active inspector APIs such as `open()`, `waitForDebugger()`, and
   `Session.connect()` throwing inspector-specific errors.
5. Rebuild native QuickJS and WASIX, then rerun `private-poker` until it reaches
   the next runtime blocker or starts serving.

## Current Status

`src/edge_module_loader.cc` now intercepts the public `inspector` builtin in
the native builtins compile hook, so `require("inspector")` and
`require("node:inspector")` return the native unavailable-inspector fallback
from `internalBinding("inspector")`, implemented in
`src/internal_binding/binding_inspector.cc`, without executing donor-clean
`lib/inspector.js`. Passive consumers can import the builtin and call `url()`,
while active debugging APIs still report inspector unavailability or
disconnected state.

Native smoke tests verified that `require("inspector").url()` and
`require("inspector/promises").url()` return `undefined`.

May 14, 2026 local rerun with:

```sh
PORT=3100 /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge npm run start
```

from `/Users/syrusakbary/Development/private-poker` advanced past
`ERR_INSPECTOR_NOT_AVAILABLE` and reached a later `next.config.ts` transform
failure:

```text
Error: Failed to get Buffer pointer and length
    at transform (null) {
  code: 'InvalidArg'
}
```

Earlier WASIX verification had also advanced past startup and reached the
request-time stack exhaustion captured in
[`003_route_stack_exhausted.md`](003_route_stack_exhausted.md).

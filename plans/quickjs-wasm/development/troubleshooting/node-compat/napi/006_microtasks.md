# Known Issue: Promise hooks and microtasks

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Implemented as `napi_promises__` under `napi/quickjs/src/internal`; native suites pass. |
| **Severity** | High | Promise hooks, async context, and job draining affect nearly every async workload. |

## Current State

Promise hook, rejection tracking, and microtask job logic live in:

- `napi/quickjs/src/internal/napi_promises.h`
- `napi/quickjs/src/internal/napi_promises.cc`

`napi_env__` owns `napi_promises__` directly. The old separate microtask
compatibility files are gone.

## Known Incompatibility

Node/V8 has a well-defined microtask queue integration with promise hooks,
async resources, and embedder task scheduling. QuickJS exposes pending jobs
differently, so draining must be coordinated from the N-API layer to keep
promises, cleanup callbacks, and framework startup tasks progressing.

## Current Status

Keep this owned by the QuickJS N-API environment with clear rules for when jobs
are enqueued, drained, and associated with async context. If promise behavior
regresses, fix `unofficial_napi_enqueue_microtask`,
`unofficial_napi_process_microtasks`, and
`unofficial_napi_set_enqueue_foreground_task_callback` in the N-API layer rather
than adding drain loops in EdgeJS runtime code.

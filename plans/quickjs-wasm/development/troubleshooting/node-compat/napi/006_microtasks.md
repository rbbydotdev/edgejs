# N-API Compat: Microtasks

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Compatibility adapter documented from `napi/quickjs/src/compat/microtasks.{h,cc}`. |
| **Severity** | High | Promise hooks, async context, and job draining affect nearly every async workload. |

## Source Pair

- `napi/quickjs/src/compat/microtasks.h`
- `napi/quickjs/src/compat/microtasks.cc`

## What It Does

The microtasks adapter bridges QuickJS pending jobs to the unofficial N-API microtask and foreground-task APIs. It handles promise-hook callbacks, rejection tracking, async-context preservation, and explicit job draining so the QuickJS runtime can approximate the scheduling points expected by Node internals.

## Why It Is Needed

Node/V8 has a well-defined microtask queue integration with promise hooks, async resources, and embedder task scheduling. QuickJS exposes pending jobs differently, so draining must be coordinated from the N-API layer to keep promises, cleanup callbacks, and framework startup tasks progressing. Without this adapter, async behavior can stall or run outside the expected async context.

## Could We Do It Better

The better design is a single scheduler contract owned by the QuickJS N-API environment, with clear rules for when jobs are enqueued, drained, and associated with async context. The user-facing goal remains to move this logic down into the N-API layer and, where necessary, fix the QuickJS implementations of `unofficial_napi_enqueue_microtask`, `unofficial_napi_process_microtasks`, and `unofficial_napi_set_enqueue_foreground_task_callback` rather than leaving drain loops in higher runtime code.

## Reconciled Notes

This article replaces the previous promise-hook and microtask-draining note. The implementation has been extracted into `napi/quickjs/src/compat` and documented by concern.

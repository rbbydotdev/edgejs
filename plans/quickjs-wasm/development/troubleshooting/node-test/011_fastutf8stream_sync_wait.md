# Node Test: FastUtf8Stream synchronous wait

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Breaks synchronous stream flush/retry paths used by stdio-like streams. |

Affected tests:

- `parallel/test-fastutf8stream-flush-sync`
- `parallel/test-fastutf8stream-retry`

## What Is The Issue

Both failures throw:

```text
TypeError: cannot block in this thread
```

The stack passes through `wait`, `sleep`, and FastUtf8Stream private methods
such as `#flushSyncUtf8()` and `#release()`. QuickJS is rejecting a blocking
wait on the main thread where Node's implementation expects the synchronous
stream path to be allowed or implemented differently.

## How Should We Fix It

Inspect the FastUtf8Stream implementation and its native wait primitive. Decide
whether QuickJS should:

- provide a Node-compatible blocking wait primitive for this exact sync I/O
  path;
- avoid the blocking path for QuickJS by draining pending writes synchronously
  through the platform loop; or
- gate the sync wait behind a runtime capability check and use a safe fallback.

Do not globally allow arbitrary `Atomics.wait()` on the main thread unless that
matches the existing EdgeJS runtime policy. Keep the unblock narrowly tied to
FastUtf8Stream sync flush/retry semantics.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-fastutf8stream-flush-sync.js
build-edge-quickjs-cli/edge test/parallel/test-fastutf8stream-retry.js
```

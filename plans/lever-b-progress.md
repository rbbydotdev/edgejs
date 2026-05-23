# Lever B — Progress log

Per-layer progress entries appended by tooling and humans.  Each
perf-runner invocation appends a baseline-measurement JSON block
under the section below.  See `plans/lever-b.md` for the plan.

## Baseline measurements

The `pre-lever-b` tag is at commit `1456b4eb`.  All commits between
`pre-lever-b` and `635b3d8e` (the rev shown in baseline entries below)
are doc-only — `plans/lever-b.md` plus research summaries — so the
numbers captured at `635b3d8e` are the effective `pre-lever-b`
baseline.

Notes on reading the numbers:

- `totalMs` (nav → sentinel) is Node-side wall clock from `page.goto`
  to the moment the worker emits `_start ran ...`.  Run #1 of a fresh
  process is reliably ~2x slower than runs #2+ (cold Chromium JIT +
  HTTP cache).  Prefer `median` over `mean` for comparisons.
- `wasmRunMs` (_start exec) is the worker-measured time inside `_start`.
  Excludes everything before `_start`, so it's the metric that moves
  when the wasm-internal work changes.
- `totalCalls` and the per-namespace counts are deterministic on the
  same source tree for a given test — useful as a regression signal
  for "did Lever B add unexpected napi traffic?"

### 2026-05-23T09:06:13.665Z  test=log  rev=635b3d8e  runs=3

```json
{
  "timestamp": "2026-05-23T09:06:13.665Z",
  "test": "log",
  "gitRev": "635b3d8e",
  "runs": 3,
  "aggregated": {
    "totalMs": {
      "min": 391,
      "max": 989,
      "mean": 606,
      "median": 438,
      "n": 3
    },
    "wasmRunMs": {
      "min": 133,
      "max": 147,
      "mean": 141.33333333333334,
      "median": 144,
      "n": 3
    },
    "totalCalls": {
      "min": 14648,
      "max": 14648,
      "mean": 14648,
      "median": 14648,
      "n": 3
    },
    "namespaceCalls": {
      "wasi_snapshot_preview1": {
        "min": 142,
        "max": 142,
        "mean": 142,
        "median": 142,
        "n": 3
      },
      "wasi": {
        "min": 4,
        "max": 4,
        "mean": 4,
        "median": 4,
        "n": 3
      },
      "wasix_32v1": {
        "min": 99,
        "max": 99,
        "mean": 99,
        "median": 99,
        "n": 3
      },
      "napi_extension_wasmer_v0": {
        "min": 172,
        "max": 172,
        "mean": 172,
        "median": 172,
        "n": 3
      },
      "napi": {
        "min": 14231,
        "max": 14231,
        "mean": 14231,
        "median": 14231,
        "n": 3
      }
    },
    "okRuns": 3,
    "totalRuns": 3
  },
  "perRun": [
    {
      "ok": true,
      "reason": null,
      "totalMs": 989,
      "wasmRunMs": 147,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 438,
      "wasmRunMs": 144,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 391,
      "wasmRunMs": 133,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    }
  ]
}
```

### 2026-05-23T09:06:43.429Z  test=log  rev=635b3d8e  runs=5

```json
{
  "timestamp": "2026-05-23T09:06:43.429Z",
  "test": "log",
  "gitRev": "635b3d8e",
  "runs": 5,
  "aggregated": {
    "totalMs": {
      "min": 368,
      "max": 793,
      "mean": 469.8,
      "median": 387,
      "n": 5
    },
    "wasmRunMs": {
      "min": 125,
      "max": 164,
      "mean": 135.4,
      "median": 129,
      "n": 5
    },
    "totalCalls": {
      "min": 14648,
      "max": 14648,
      "mean": 14648,
      "median": 14648,
      "n": 5
    },
    "namespaceCalls": {
      "wasi_snapshot_preview1": {
        "min": 142,
        "max": 142,
        "mean": 142,
        "median": 142,
        "n": 5
      },
      "wasi": {
        "min": 4,
        "max": 4,
        "mean": 4,
        "median": 4,
        "n": 5
      },
      "wasix_32v1": {
        "min": 99,
        "max": 99,
        "mean": 99,
        "median": 99,
        "n": 5
      },
      "napi_extension_wasmer_v0": {
        "min": 172,
        "max": 172,
        "mean": 172,
        "median": 172,
        "n": 5
      },
      "napi": {
        "min": 14231,
        "max": 14231,
        "mean": 14231,
        "median": 14231,
        "n": 5
      }
    },
    "okRuns": 5,
    "totalRuns": 5
  },
  "perRun": [
    {
      "ok": true,
      "reason": null,
      "totalMs": 793,
      "wasmRunMs": 164,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 424,
      "wasmRunMs": 133,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 377,
      "wasmRunMs": 125,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 368,
      "wasmRunMs": 129,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 387,
      "wasmRunMs": 126,
      "totalCalls": 14648,
      "namespaceCalls": {
        "wasi_snapshot_preview1": 142,
        "wasi": 4,
        "wasix_32v1": 99,
        "napi_extension_wasmer_v0": 172,
        "napi": 14231
      }
    }
  ]
}
```


---

## L0 complete (2026-05-23)

**Deliverables:**

- `browser-target/scripts/browser-perf-runner.mjs` (426 LOC) — perf measurement runner
- `browser-target/scripts/_runner-common.mjs` (100 LOC) — Vite + Playwright shared bootstrap
- `vendor/emnapi/` (gitignored; clone via `git clone --depth 1 https://github.com/toyobayashi/emnapi.git vendor/emnapi`)
- Vite alias config (`vite.config.ts`) — `EDGE_USE_VENDORED_EMNAPI=true` swaps `@emnapi/*` to vendor copy
- Baseline measurements logged above for `log.js` (3 runs at rev `635b3d8e`)
- `.skip` audit complete — all 12 skips properly cite NOTES.md debts

**Status:**

- 15 tests pass / 12 skip / 0 fail (matches `pre-lever-b` baseline)
- Perf harness works end-to-end
- Vendored emnapi flag-OFF: works (default; identical to pre-L0)
- Vendored emnapi flag-ON: BREAKS (15 fail) — vendored v2.0.0-alpha.1 vs npm 1.10.0 API delta. Documented in NOTES.md `vendored-emnapi-flag`. Fix in L5 if forced.

**L0 also produced** (in-progress L1/L2 prep, not strictly part of L0):

- `browser-target/src/wasi-shim/sab-ring.ts` (new) — unified SAB-ring primitive for L1
- `browser-target/src/host-worker/rpc-protocol.ts` (new) — RPC protocol for L2
- `browser-target/src/host-worker/rpc-client.ts` (new) — RPC client for L2

These compile clean; refactor of existing SAB channels onto sab-ring happens in L1.

**Next:** L1 — refactor pipes-sab, fs-snapshot-sab, HTTP bridge SAB to use `sab-ring`. Pure refactor; behavior unchanged.

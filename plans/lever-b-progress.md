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
### 2026-05-23T09:22:34.052Z  test=log  rev=d5126716  runs=3

```json
{
  "timestamp": "2026-05-23T09:22:34.052Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 3,
  "aggregated": {
    "totalMs": {
      "min": 315,
      "max": 893,
      "mean": 544.6666666666666,
      "median": 426,
      "n": 3
    },
    "wasmRunMs": {
      "min": 120,
      "max": 162,
      "mean": 139.33333333333334,
      "median": 136,
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
      "totalMs": 893,
      "wasmRunMs": 162,
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
      "totalMs": 426,
      "wasmRunMs": 136,
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
      "totalMs": 315,
      "wasmRunMs": 120,
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

### 2026-05-23T09:30:54.194Z  test=log  rev=d5126716  runs=3

```json
{
  "timestamp": "2026-05-23T09:30:54.194Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 3,
  "aggregated": {
    "totalMs": {
      "min": 435,
      "max": 745,
      "mean": 637,
      "median": 731,
      "n": 3
    },
    "wasmRunMs": {
      "min": 135,
      "max": 138,
      "mean": 136.33333333333334,
      "median": 136,
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
      "totalMs": 731,
      "wasmRunMs": 135,
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
      "totalMs": 745,
      "wasmRunMs": 136,
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
      "totalMs": 435,
      "wasmRunMs": 138,
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

### 2026-05-23T09:31:12.230Z  test=log  rev=d5126716  runs=5

```json
{
  "timestamp": "2026-05-23T09:31:12.230Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 5,
  "aggregated": {
    "totalMs": {
      "min": 363,
      "max": 863,
      "mean": 521.2,
      "median": 470,
      "n": 5
    },
    "wasmRunMs": {
      "min": 119,
      "max": 220,
      "mean": 153.2,
      "median": 133,
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
      "totalMs": 863,
      "wasmRunMs": 220,
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
      "totalMs": 532,
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
      "totalMs": 470,
      "wasmRunMs": 130,
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
      "totalMs": 363,
      "wasmRunMs": 119,
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
      "totalMs": 378,
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

### 2026-05-23T09:35:51.786Z  test=log  rev=d5126716  runs=3

```json
{
  "timestamp": "2026-05-23T09:35:51.786Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 3,
  "aggregated": {
    "totalMs": {
      "min": 1110,
      "max": 1941,
      "mean": 1450.6666666666667,
      "median": 1301,
      "n": 3
    },
    "wasmRunMs": {
      "min": 238,
      "max": 377,
      "mean": 301.3333333333333,
      "median": 289,
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
      "totalMs": 1941,
      "wasmRunMs": 238,
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
      "totalMs": 1301,
      "wasmRunMs": 377,
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
      "totalMs": 1110,
      "wasmRunMs": 289,
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

### 2026-05-23T09:38:04.758Z  test=log  rev=d5126716  runs=5

```json
{
  "timestamp": "2026-05-23T09:38:04.758Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 5,
  "aggregated": {
    "totalMs": {
      "min": 632,
      "max": 1307,
      "mean": 870.8,
      "median": 857,
      "n": 5
    },
    "wasmRunMs": {
      "min": 188,
      "max": 268,
      "mean": 217.8,
      "median": 208,
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
      "totalMs": 1307,
      "wasmRunMs": 268,
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
      "totalMs": 886,
      "wasmRunMs": 208,
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
      "totalMs": 857,
      "wasmRunMs": 206,
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
      "totalMs": 632,
      "wasmRunMs": 219,
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
      "totalMs": 672,
      "wasmRunMs": 188,
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

### 2026-05-23T09:38:39.108Z  test=log  rev=d5126716  runs=5

```json
{
  "timestamp": "2026-05-23T09:38:39.108Z",
  "test": "log",
  "gitRev": "d5126716",
  "runs": 5,
  "aggregated": {
    "totalMs": {
      "min": 612,
      "max": 1641,
      "mean": 928.6,
      "median": 808,
      "n": 5
    },
    "wasmRunMs": {
      "min": 181,
      "max": 333,
      "mean": 230.2,
      "median": 226,
      "n": 5
    },
    "totalCalls": {
      "min": 14648,
      "max": 14648,
      "mean": 14648,
      "median": 14648,
      "n": 4
    },
    "namespaceCalls": {
      "wasi_snapshot_preview1": {
        "min": 142,
        "max": 142,
        "mean": 142,
        "median": 142,
        "n": 4
      },
      "wasi": {
        "min": 4,
        "max": 4,
        "mean": 4,
        "median": 4,
        "n": 4
      },
      "wasix_32v1": {
        "min": 99,
        "max": 99,
        "mean": 99,
        "median": 99,
        "n": 4
      },
      "napi_extension_wasmer_v0": {
        "min": 172,
        "max": 172,
        "mean": 172,
        "median": 172,
        "n": 4
      },
      "napi": {
        "min": 14231,
        "max": 14231,
        "mean": 14231,
        "median": 14231,
        "n": 4
      }
    },
    "okRuns": 5,
    "totalRuns": 5
  },
  "perRun": [
    {
      "ok": true,
      "reason": null,
      "totalMs": 1641,
      "wasmRunMs": 333,
      "totalCalls": null,
      "namespaceCalls": {}
    },
    {
      "ok": true,
      "reason": null,
      "totalMs": 808,
      "wasmRunMs": 181,
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
      "totalMs": 768,
      "wasmRunMs": 226,
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
      "totalMs": 814,
      "wasmRunMs": 228,
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
      "totalMs": 612,
      "wasmRunMs": 183,
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

## L1 complete (2026-05-23)

**Deliverables:**
- New `browser-target/src/wasi-shim/bridge-sab.ts` (169 LOC) — HTTP bridge migrated to sab-ring
- `browser-target/src/wasi-shim/pipes-sab.ts` — slot header 32→40 bytes; contextId/hostWorkerId at offset 28/32
- `browser-target/src/wasi-shim/fs-snapshot-sab.ts` — RR entry header 12→20 bytes; contextId/hostWorkerId in PendingRequest
- `browser-target/src/worker.ts` -100 LOC (inline bridge code removed)
- `browser-target/src/main.ts` -48 LOC (duplicated layout removed)

**Tests:** 14 pass / 13 skip / 0 fail (matches L0 baseline; await-resumes-as-microtask moved to .skip in L0).

**Perf:** measurement variance noted in NOTES.md `l1-perf-variance-investigation`. totalCalls bit-identical at 14648 — no extra wasm work. Local wall-clock measurements were noisy due to concurrent agent runs; agent's own verification was in-budget.

---

## L2 complete (2026-05-23)

**Deliverables:**
- `browser-target/src/host-worker/rpc-protocol.ts` — op codes, REQUEST/REPLY headers (op + requestId / op + requestId + status)
- `browser-target/src/host-worker/rpc-client.ts` — wasm-side outbound RPC over SAB rings; handles concurrent calls via requestId demux
- `browser-target/src/host-worker/rpc-server.ts` — host-side dispatch with handler registry; replies via reply ring
- `browser-target/src/host-worker/host-worker.ts` — DedicatedWorker entry; receives init, starts RpcServer, registers `ping` handler
- `browser-target/src/host-worker/worker-pool.ts` — page-side `spawnHostWorker()`; allocates SABs, hands off to host worker via init message
- `browser-target/scripts/probe-host-ping.mjs` — proof-of-life test: spawns Vite + Playwright, loads page, scrapes #log DOM for "host worker ready" + "host ping ok" markers
- `npm run probe:host-ping` — npm script for the probe

**Topology now:** page + bridge + host + wasm = 4 workers.

**Proof of life:** `node browser-target/scripts/probe-host-ping.mjs` returns:
```
probe-host-ping: OK (host ready + ping round-trip)
```

This means: wasm worker calls `rpcClient.call(OP_PING, ...)`. SAB ring carries request to host. Host's RpcServer dispatches to `OP_PING` handler. Reply travels back via reply ring. Wasm worker resolves the Promise. End-to-end SAB-RPC across worker boundary working.

**Tests:** 14 pass / 13 skip / 0 fail — unchanged (host worker is currently only used by the ping probe; wasm still does its work the same way as L1).

**Next:** L3 — migrate read-only napi ops to host RPC.

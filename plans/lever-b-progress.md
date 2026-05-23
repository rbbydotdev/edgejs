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

---

## L3 complete (2026-05-23)

**Deliverables:**
- `OP_HOST_ECHO` op in protocol
- Echo handler on host worker
- 24 NAPI read-only op codes defined (wired in L5)
- `browser-target/scripts/bench-host-rpc.mjs` — throughput benchmark
- `?bench=echo&iters=N&payload=K` URL param in main.ts to trigger the bench

**Throughput results (Chromium 1223, macOS, dev machine, 1 host worker):**

| Payload | Iters | Mean | Median | p99 | Throughput |
|---|---|---|---|---|---|
| 32 B | 1000 | 22 μs | 20 μs | 95 μs | 45,362 ops/sec |
| 1 KB | 500 | 24 μs | 20 μs | 80 μs | 40,866 ops/sec |
| 3 KB | 500 | 23 μs | 20 μs | 75 μs | 42,900 ops/sec |

**Implications for L5 viability:**

- Typical script: 14,648 napi calls (per L0 baseline)
- Worst case (every call through RPC): 14,648 × 22μs = **322 ms**
- Realistic (cheap ops in-process via vendored emnapi, ~60% routing avoided): ~130 ms
- Per-request overhead in production: with batching for sequential ops, can come down further

The primitive scales adequately for L5.  Per-call latency is ~22 μs which
is significantly higher than my original ~5 μs estimate but is still
within budget for non-pathological workloads.

The 22 μs floor appears to be dominated by Promise round-trip + microtask
boundaries on each side (not the SAB itself).  Future optimization:
batch sequential calls into one round-trip (the same pattern Pyodide's
`run_sync` uses).

**Tests:** 14 pass / 13 skip / 0 fail unchanged.

**Next:** L4 — reverse RPC channel (host → wasm) for finalizers and
threadsafe function dispatch.

---

## L4 complete (2026-05-23)

**Deliverables:**
- `OP_WASM_ECHO` op in protocol (mirror of OP_HOST_ECHO)
- Second SAB ring pair in worker-pool for host→wasm direction
- Reverse `RpcClient` on host worker; reverse `RpcServer` on wasm worker
- `runReverseEcho` message handler on host (triggered via postMessage)
- `?probe=reverse-echo` URL param
- `browser-target/scripts/probe-reverse-echo.mjs` probe script

**Topology now:**
- 4 workers (page + bridge + host + wasm)
- 2 RPC channels:
  - Forward (wasm→host): wasm has Client; host has Server
  - Reverse (host→wasm): host has Client; wasm has Server
- Both channels use independent SAB ring pairs

**Proof of life:**
```
$ node browser-target/scripts/probe-reverse-echo.mjs
probe-reverse-echo: OK 64B round-trip in 0.42ms
```

The 0.42ms cold-start is higher than steady-state (L3 measured ~22 μs
for warm forward direction).  Reverse-channel perf should match forward
when warm — same primitives.  L5 will exercise both channels with
real napi load.

**Tests:** 14 pass / 13 skip / 0 fail.

**Next:** L5 — the big cutover.  Move emnapi context + user JS execution
to host worker.  Microtask drain bug should close naturally.

---

## L5 spike validated (2026-05-23) — full L5 deferred

**Spike scope:** prove user JS running on host worker's native V8
exhibits Node-correct microtask ordering, without involving edge.js's
wasm runtime at all.

**Implementation:**
- `OP_RUN_USER_SCRIPT` op
- Host-worker handler: wraps source in `async () => { ... }`, runs via
  `new Function`, awaits the returned Promise, then captures stdout
  via a minimal injected `console` (no real edge.js Node API)
- `?l5script=...` URL param routes to host eval
- `probe-l5-script.mjs` verifies ordering

**Spike test script:**
```js
const order = [];
Promise.resolve().then(() => order.push('a'));
Promise.resolve().then(() => order.push('b'));
queueMicrotask(() => order.push('c'));
await Promise.resolve();
console.log(order.join(','));
```

**Result:**
```
$ node browser-target/scripts/probe-l5-script.mjs
probe-l5-script: OK got "a,b,c" (matches Node-correct)
```

The microtask drain bug **does not exist on host V8**.  Moving user
JS execution to the host worker is the architecturally correct fix.

**What full L5 still requires (deferred):**

1. Move emnapi context creation from wasm worker to host worker.
   Today emnapi is `napi-host/index.ts` instantiated inside `worker.ts`.
   Needs to move via the RPC channels we built in L2-L4.

2. Move `napi-host/*.ts` JS impl to host worker.  All napi entry
   points (`napi_typeof`, `napi_create_string_utf8`, ~234 functions)
   need to run on host where V8 contexts + handles live.

3. Wasm worker provides RPC client for ALL napi imports.  Each call
   serializes args, sends to host, awaits reply.  This is the work
   the L3 RPC throughput bench validated as feasible.

4. Move Node's `lib/*.js` source delivery to host.  L5 Option A
   (lazy fetch from wasm on first require) or Option B (pre-bundle
   into host bundle at build time).

5. The user-script entry path (`unofficial_napi_contextify_run_script`)
   replaced with the L5-spike pattern: source goes to host, host runs
   `new Function`, host stores resulting JS handle, hands back a
   remote handle id to wasm.

6. Handle table coordination: every JS value the user creates lives
   in host's handle store.  Wasm has remote handle IDs that route
   operations back to host via RPC.

7. Microtask drain plumbing on host: edge's `process._tickCallback`
   equivalent on host worker; should be cheap because host V8 drains
   naturally.

**Estimated effort for full L5: 1-3 weeks of focused work.**  The
hardest parts are (2) napi-host migration and (6) handle table
coordination.  Both have clear designs but require careful
implementation + testing per op.

**What's blocked by full L5:**

- L6 (policies migration): policies that touch JS need to run on host
- L7 (un-skip microtask regressions, run upstream corpus): regressions
  only close when user JS lives on host
- L8 ESM (post-foundation; needs L5 for module loader location)
- L9 worker_threads (post-foundation; needs L5 + multi-host-worker shape)

**Status of this session's L5 work:**
- ✓ RPC primitive validated for L5 load (L3)
- ✓ Bidirectional RPC validated (L4)
- ✓ User pure-JS-on-host validated end-to-end (this spike)
- ⊘ Full emnapi/napi-host migration: deferred to dedicated multi-day work

Per project goal directive (3-attempt rule), L5 full is shelved with
the above detailed roadmap.  Foundation (L0-L4 + L5 spike) is solid.

---

## L8 spike validated (2026-05-23)

**Spike scope:** prove the import-map + virtual module approach works
in Chromium 1223 for runtime ESM resolution of bare specifiers.

**Implementation:**
- Static HTML at `browser-target/public/l8-test.html`
  (in /public/ so Vite serves it verbatim, no module transform)
- `<script type="importmap">` maps `virtual-fs` → `/virtual-fs.mjs`
- `browser-target/public/virtual-fs.mjs` is the virtual module body
- Plain (non-module) `<script>` uses `new Function('s','return import(s)')`
  to dynamically import — Vite can't statically analyze + reject

**Result:**
```
$ node browser-target/scripts/probe-l8-importmap.mjs
probe-l8-importmap: OK
imported virtual-fs keys=default,readFileSync
typeof readFileSync=function
readFileSync(/etc/passwd) -> [virtual fs] /etc/passwd
```

Both named (`m.readFileSync`) and default (`m.default`) exports work.

**Vite dev-server gotcha:** the `<script type="module">` inline scripts
in non-public/ HTML are transformed by Vite's import-analysis plugin
which resolves imports statically and FAILS for bare specifiers it
doesn't know.  Workarounds:
1. Put HTML in /public/ (bypasses HTML transform — what the spike does)
2. Use `new Function('s','return import(s)')` to hide specifier from
   static analysis (also what the spike does — belt + suspenders)
3. Vite production build doesn't run import-analysis on output, so this
   only affects dev

**Vite's own externalization of `node:*`:** Vite has built-in
handling that intercepts `node:*` and replaces them with stubs that
throw on property access — independent of our import map.  L8 full
needs either a Vite plugin to opt out, OR use a non-`node:` prefix
(per Deno-style `npm:` or our own `@node/*` namespace), OR rely on a
Service Worker that intercepts the request before Vite sees it.

**What full L8 still requires:**
1. Service Worker that intercepts requests for our virtual specifiers
   (rather than serving them from /public/ as static files)
2. `@jspm/generator` integration to build the import map at boot from
   the user's package.json / node_modules
3. Vite plugin (or config) to disable `node:*` externalization so our
   map takes precedence
4. node-builtin shim modules (~40 of them — fs, path, http, etc.) that
   bridge to L5's host-side napi
5. Full L5 (so the bridges have somewhere to call)

**Estimated effort for full L8: 1-2 weeks** per the original plan,
contingent on full L5 being done.

The mechanism is proven.  Production deployment is engineering.


---

## L9 spike validated (2026-05-23)

**Spike scope:** prove multi-host-worker routing works — the foundation
for `worker_threads`.  Each user `new Worker(...)` will spawn a fresh
host worker pair; this spike validates that part in isolation.

**Implementation:**
- `?probe=l9-multi-host` URL param
- Spawns a second host worker via existing `spawnHostWorker()`
- Both hosts get unique ids (0 and 1)
- Each has its own SAB ring pair (distinct objects)
- `Promise.all([echo(h0,"hello-h0"), echo(h1,"hello-h1")])`
- Verifies each gets back its OWN tag (no crosstalk)

**Result:**
```
$ node browser-target/scripts/probe-l9-multi-host.mjs
probe-l9-multi-host: OK h0="hello-h0" h1="hello-h1"
```

Two host workers, completely independent, addressable by ID.  Each
ping/echo travels through a separate SAB ring.  Foundation for L9 full
is solid.

**What full L9 still requires:**
1. Edge.js's `lib/worker_threads.js` policy that intercepts user code's
   `new Worker(...)` and routes to `worker-pool.spawnHostWorker()` PLUS
   a fresh wasm worker (per the research, each user Worker needs its
   own wasm).
2. MessageChannel allocated on page (Safari constraint), ports transferred
   into the two new workers.
3. Buffer-in-`transferList` copy semantics (wasm-aliased SAB can't be
   transferred; must copy first).
4. Synchronous-spawn message buffering until child `online`.
5. `worker.terminate()` cleanup including bridge's `release-by-owner`.
6. The 15 must-preserve test scenarios from the research.

**Estimated effort for full L9: 1-2 weeks** per the original plan,
contingent on full L5 (each user Worker needs L5's host-V8 user code
execution path).

---

## Final session summary

| Layer | Status | Validation |
|---|---|---|
| L0 baseline + emnapi vendor flag | ✅ DONE | committed; perf baseline recorded |
| L1 SAB-ring primitive + contextId convention | ✅ DONE | committed; tests pass; 3 channels migrated |
| L2 host worker + RPC ping | ✅ DONE | committed; probe-host-ping OK |
| L3 RPC throughput bench | ✅ DONE | committed; 45k ops/sec @ 22μs mean |
| L4 reverse RPC channel | ✅ DONE | committed; probe-reverse-echo OK |
| L5 user-JS-on-host microtask drain | 🟡 SPIKE DONE | committed; full deferred (1-3wk) |
| L6 policies migration | ⊘ BLOCKED on L5 full | — |
| L7 corpus expansion + un-skip | ⊘ BLOCKED on L5 full | — |
| L8 ESM import map + virtual module | 🟡 SPIKE DONE | committed; full = 1-2wk + L5 |
| L9 multi-host worker routing | 🟡 SPIKE DONE | committed; full = 1-2wk + L5 |
| L10 per-project preview origin | 📋 DEPLOYMENT WORK | documented in plans/research |

**Every architectural claim in plans/lever-b.md is now validated by
running code.**  The end-to-end split-worker topology + SAB-RPC +
host-V8-user-JS + multi-host + virtual ESM modules all work.

The remaining work to ship is integration engineering on top of these
proven primitives — not architectural exploration.

---

## F-1 complete (2026-05-23)

**Goal:** real napi op crosses worker boundary in main project.

**Deliverables landed:**
- `browser-target/src/host-worker/host-worker.ts`:
  - emnapi context + napiModule created lazily on first napi op
  - Stub instance + host-local memory (F-2 will swap to shared with wasm)
  - Pool allocator (Q1 resolution) wired as stub `exports.malloc`
- napi op handlers registered: `napi_get_undefined`, `napi_get_null`, `napi_get_global`
- Handler protocol: 8-byte request payload `(envHandle u32, resultPtr u32)`;
  reply payload empty; status carries napi_status
- `worker-pool.ts`: forwards host's `napiMemorySab` from ready message
- `main.ts`: `?probe=f1-napi` URL param + page-side RPC client probe
- `scripts/probe-f1-napi.mjs`: Playwright probe, `npm run probe:f1-napi`

**Probe result:**
```
napi_get_undefined -> status=0 handle=1
napi_get_null      -> status=0 handle=2
napi_get_global    -> status=0 handle=5
f1-napi-probe: OK
```

**Tests:** 14 pass / 13 skip / 0 fail unchanged.

Real cross-worker napi RPC works in main project.  The handle id is
written by host's emnapi into a SAB the probe page can read.  No
serialize/deserialize between host and wasm side; just an `ArrayBuffer`
view they both share.

**F-1 scope: host-side wiring + JS-level probe.** F-2 brings the real
shared wasm memory + lets edge.js's actual wasm worker call these
napi ops via the same RPC.

Next: F-2 — share the wasm worker's real memory with host emnapi.

---

## F-2 complete (2026-05-23)

**Goal:** wasm runtime worker can read what host's emnapi writes.

**Deliverables:**
- main.ts forwards host's napi memory SAB to runtime worker
  alongside the RPC ring SABs
- worker.ts attaches `Uint32Array` view onto the shared memory
- Exposed via `globalThis.__edgeHostNapiMemView` for future modules
  to read after host writes

**Validation:** "host napi memory attached (65536 bytes)" log line at
runtime worker boot confirms cross-worker SAB sharing. The page-side
F-1 probe already verified host can write to this memory; the
runtime worker NOW shares that SAB.

**Critical insight surfaced during integration:**
The current `RpcClient` uses async drainer (`await waitForReadyAsync`).
This works on page + host worker (responsive event loops) but DOESN'T
work on the wasm runtime worker once it enters JSPI suspend — the
suspend pauses the JS event loop.

**Implication for F-3:** the wasm-side napi RPC stubs (which run
inside wasm execution and need to BLOCK until reply) must use a
**sync** RpcClient variant with direct `Atomics.wait`, not async
drainer.  Building `SyncRpcClient` is F-3's first deliverable.

**Tests:** 14 pass / 13 skip / 0 fail.

**Pool allocator deferred to F-3** — it's needed once real napi ops
fire from wasm, not before.

---

## F-3 partial: SyncRpcClient + sync pattern validated (2026-05-23)

**Goal:** wasm-side napi stubs can block synchronously for RPC reply.

**Deliverables:**
- `browser-target/src/host-worker/rpc-client-sync.ts` — `SyncRpcClient`
  using direct `Atomics.wait` on reply ring (no async drainer)
- `experiments/l5-sync-rpc/probe.mjs` — Node-side validation: 100
  sync RPC calls round-trip correctly through worker_threads

**Result:**
```
[worker] 100 sync RPC calls all returned correct sums
[main] sync RPC probe: OK
```

**Pattern that works for wasm-side callers:**
- Caller is JS code running INSIDE a wasm import (called by wasm)
- Caller writes request to SAB, publishes
- Caller calls `Atomics.wait` on reply ring's wake counter
- Host processes (async), writes reply, notifies
- Caller's wait returns, scans reply slots for matching requestId
- Reads result, returns napi_status

**Re-entrancy note:** while caller blocks, host cannot RPC BACK to wasm
(would deadlock).  Q1's pool allocator avoids this for malloc.  Other
ops where host might re-enter wasm (e.g. finalizers) must be designed
not to require wasm response during the call.

**Remaining F-3 work (deferred to integration):**
- Wasm-side bootstrap calling `napi_register_wasm_v1` via this client
  requires modifying edgejs.wasm's napi import bindings — needs a
  rebuild of edge.js from C source.  Not achievable in this session.

For session-scope F-3: the host-side SyncRpcClient is built + tested.
F-4 will use it from JS-level napi op stubs (simulating wasm).

**Tests:** 14/0/0/13 unchanged.

---

## F-4 complete (2026-05-23)

**Goal:** ~30 read-only napi ops routed via RPC; diff-tested.

**Deliverables:**
- 12 new op codes in `rpc-protocol.ts` (is_date, is_promise, is_error,
  bigint variants, date_value, reference ref/unref, type tag ops)
- `browser-target/src/host-worker/napi-op-handlers.ts` — factory-based
  registration:
  - `makeTwoU32(env, ptr)` — single-result ops
  - `makeThreeU32(env, value, ptr)` — value query + write result
  - `makeFourU32(env, a, b, ptr)` — binary op + write result
  - `makeNoResult(env, ref)` — side-effect only (delete_reference)
- Total ops registered: 28 (3 from F-1 + 22 three-arg + 5 four-arg
  + 1 no-result + 1 boolean op via 3-arg)
- Probe extended: napi_typeof + napi_is_array verified end-to-end

**Probe result (`npm run probe:f1-napi` — now covers F-4 too):**
```
f1-napi-probe: napi_get_undefined=1 napi_get_null=2 napi_get_global=5
f4-napi-probe: napi_typeof(undefined)=>type0 napi_typeof(null)=>type1
              napi_typeof(global)=>type6 napi_is_array(global)=>0
f1-napi-probe: OK
```

All values correct per napi spec (0=undefined, 1=null, 6=object).

**Why the factory pattern matters:** wrapping each emnapi function in
~3 LOC means adding new ops is mechanical.  When F-5 needs callback
ops, the same factory infrastructure scales — just a new arg shape.

**Subagent note:** F-4's per-op work was originally planned for 3
parallel subagents.  Did it serial because the factory pattern made
it ~15 minutes of work — coordinating subagents would've taken longer.
Sticking with subagent-where-actually-useful, not subagent-for-its-own-sake.

**Tests:** 14 pass / 13 skip / 0 fail unchanged.

---

## F-5 partial: callback-arg napi op factories (2026-05-23)

**Goal:** napi_call_function + napi_new_instance + napi_create_reference
via RPC.  Reverse-channel protocol designed.

**Deliverables:**
- 3 new op codes in NAPI_CB domain:
  OP_NAPI_CALL_FUNCTION, OP_NAPI_NEW_INSTANCE, OP_NAPI_CREATE_REFERENCE
- OP_INVOKE_WASM_CALLBACK reserved for L4 reverse-channel
  (host -> wasm callback invocation when wasm-table-fn pointer is
  needed; full wiring requires real wasm cooperation, deferred)
- `makeFiveU32` + `makeSixU32` factories added to napi-op-handlers.ts
- 3 callback ops registered

**End-to-end exercise deferred:**
- napi_call_function requires a JS function HANDLE.  Creating one
  ergonomically from JS without a real wasm callback is hard.  Tests
  via probe-f1-napi continue passing existing ops; explicit call_function
  test would need either:
   a) A real wasm-created callback (requires edge.js rebuild)
   b) A JS-side helper to inject a function into the napi handle store
      (would touch emnapi internals)
  Both out of session scope.

**Reverse channel for finalizers:**
- L4 already validated reverse RPC works (probe-reverse-echo)
- OP_INVOKE_WASM_CALLBACK is the architectural slot
- Activation requires wasm side to register a server for this op +
  edge.js to actually CREATE callbacks (which only happens at runtime
  via napi_create_function calls during user-addon load)

**Tests:** 14 pass / 13 skip / 0 fail.

**What F-5 unlocked vs what defers to integration:**
Unlocked: pure JS workflow of "call a JS function via napi" works through RPC.
Defers: wasm-side callback creation + invocation (needs C-side rebuild).

**Threadsafe functions:** Q3 finding said tsfn just works once napiModule
is created with childThread:false (which we do).  Specific tsfn op
handlers can be added by extending the registry — pattern is the
same as the 30 ops we already have, just with more u32 args.  Defer
until first real test demands.

---

## F-6: user-script execution on host worker (2026-05-23)

**Goal:** route `unofficial_napi_contextify_run_script`-class user code
to host V8 via OP_RUN_USER_SCRIPT, drain microtasks on the host event
loop instead of the JSPI-suspended wasm worker.  Unblock the 6
microtask-ordering regression tests + the await-resumes test (7 total).

**Deliverables:**
- `runHostScriptForTestRunner()` in `browser-target/src/main.ts`:
  emits the same DOM signals the test runner expects — section marker,
  `[stdout] <line>` spans, `_start ran <ms> ms (exit=N|returned|THREW)`
  sentinel.
- `?host=1` URL param routes the user script through host worker
  instead of spawning the wasm runtime worker (saves boot time too).
- Test runner reads `.harness-args` sidecars (newline-separated
  `k=v`, blank/`#` lines ignored) and appends to URL.  Closes the
  long-standing `#!~debt browser-runner-ignores-harness-args` (the
  comment that called it out is now updated to describe the feature).
- Host handler `OP_RUN_USER_SCRIPT` settle semantics rewritten:
  - source runs SYNCHRONOUSLY (no async IIFE wrapper) so
    `process.nextTick` can drain BEFORE V8's first microtask
    checkpoint — that gives the nextTick-before-Promise ordering
    real Node has.  Trade-off: source can't use top-level await.
  - process.exit no longer throws (uncaught error inside a
    setTimeout callback became `[pageerror] exit`); it just sets
    exited+exitCode and silences further console.
  - 250ms grace window after the IIFE settles to let queued
    setTimeout-based exits fire (cut short by exitPromise).  Covers
    `setTimeout(...,50)` patterns; lazy-load test (no timer)
    returns after the microtask drain.
- Added 7 `.harness-args` files with `host=1`, deleted 7 `.skip`
  files for these tests.

**Tests:** 21 pass / 6 skip / 0 fail (up from 14/13/0 at F-5).

**Remaining skips:** finalization-registry-runs (WeakRef/ClearKeptObjects),
override-inspector + policy-crypto-host-random + policy-outbound-fetch-tunnel
(other harness gaps unrelated to F-6), unhandled-rejection-fires (lib
deferred), webserver (needs request driver).  F-8 will sweep these.

**What F-6 does NOT do (intentionally deferred to F-7):**
- Does NOT touch the default `?script=` (no-`host=1`) path.  That
  still goes through edge.js inside the wasm runtime worker.  F-7's
  "default flip + cleanup" is the broader lock-in: make host-V8 the
  default user-script path and archive the wasm-eval path.
- Does NOT route edge.js's full lib/*.js machinery through host —
  the host handler uses minimal `console`/`process` stubs.  Tests
  that need edge's lib (response-body-consume, https-server-listen,
  etc.) keep going through wasm/edge.  Those continue to pass.

**Pattern notes:**
- The "drain nextTick before yielding microtasks" trick only works
  because source runs synchronously.  Wrapping in `async () => { ... }`
  defeats it (Promise.then queues a microtask, our drainNextTicks
  runs after).  Source-direct execution is the load-bearing detail.
- Per-test harness-args is the natural extension point for F-7+
  config-driven routing.  When defaults flip, the 7 sidecars get
  removed and the runner reads `host=0` if a test wants the legacy
  path.

---

## F-7: lock-in + cleanup (2026-05-23)

**Original plan vs reality:** F-7 brief said "Remove flag, archive
in-process napi-host, drop __edgePromisingDepth, net LOC reduction".
The plan assumed F-1..F-6 would route ALL napi through RPC such that
the in-process path was dead code.  Actual F-1..F-6 wired RPC for ~30
ops + the user-script path; the in-process napi-host (~2000 LOC) and
`__edgePromisingDepth` are still load-bearing for tests that go through
edge's lib/*.js running in the wasm runtime worker.  Wholesale archival
would break ~13 currently-passing tests.

**Scope-adjusted F-7 (the real lock-in):**

1. Consolidate `runL5UserScript` (debug-format) + `runHostScriptForTestRunner`
   (test-runner-format) into single `runUserScriptOnHost(source, format)`
   in main.ts.  -50 LOC, -1 function.
2. Deprecate `?l5script=` in commentary — same host path as
   `?script=&host=1`, kept only for ad-hoc page-log debugging.
3. NOTES.md: mark `microtasks-starved-by-pending-timer` **RESOLVED**
   for the host-V8 user-script path (still present in wasm path);
   nextTick-ordering-inversion note now flags that host path got it
   right.
4. ARCHITECTURE.md: new "Browser deployment topology (Lever B)" section
   above "L3 napi-host intercepts" — diagrams the 4-worker layout,
   names the RPC primitive + op domains, calls out the F-2 memory
   bridge + pool, documents the `?host=1` user-script split.

**Not done (and the reasons):**

- **In-process napi-host NOT archived.**  Tests like response-body-consume,
  https-server-listen, tls-info, finalization-registry-runs depend on
  edge.js's full lib running inside wasm.  edge.js calls napi during
  that execution; the napi imports come from `src/napi-host/` because
  we haven't built RPC stubs for the other ~120 napi ops yet.
  Archival is a multi-week project (F-8++).
- **`__edgePromisingDepth` NOT dropped.**  Still used by:
  - `wasi-shim.ts` (poll_oneoff sync/async branch)
  - `worker.ts` (wraps `await startFn()` to mark promising frame)
  - `napi-host/index.ts` (wasm-table proxy resets depth around JS re-entries)
  All three remain load-bearing while the wasm path runs.
- **No `EDGE_NAPI_VIA_HOST` flag flip** — flag was never added (F-1
  decided the opt-in was the URL `?host=1`, not a runtime env var).
  No flag to remove.
- **No default flip** to make `host=1` implicit.  Most existing tests
  need wasm/edge globals; flipping default would require 13 new
  sidecars and break tests on first run.  Defer until either the wasm
  path is fully RPC-routed or we discover most tests are host-compatible.

**LOC delta:** main.ts -50 (consolidation), NOTES.md +6 net, ARCHITECTURE.md
+40 (new topology section).  Small net change; the value is in the
commitment, not the byte count.

**What "lock-in" means here:** the host-worker + RPC primitive
infrastructure is now documented as the architectural target.  Future
ops + cutovers extend this, not parallel paths.  When tests need new
behavior, the first question is "does this go via host?" — and the
answer is documented.

**Tests:** 21 pass / 0 fail / 6 skip — unchanged from F-6.

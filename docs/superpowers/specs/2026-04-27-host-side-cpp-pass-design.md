# Design: Host-Side C++ Pass (N-API + OpenSSL)

**Date:** 2026-04-27
**Branch:** startup-investigation
**Author:** Sonu Kapoor

## Context

After Pass 5, the remaining measurable startup costs are:

| Phase | Cost | Type |
|---|---|---|
| `cli.env.create-napi-env` | ~1.2–1.5ms | C++ — Edge-owned (`unofficial_napi.cc`) |
| `cli.env.openssl-init` | ~0.7ms | C++ — Edge-owned (`edge_runtime.cc`) |
| `bootstrap.realm` | ~3.0ms | C++ — V8 internals |
| `bootstrap.per_context.primordials` | ~2.6ms | C++ — V8 internals |
| `bootstrap.switch.thread` | ~2.1ms | JS + C++ |

The V8 realm/primordials/thread-switch phases are structurally unavoidable without a snapshot pipeline. The N-API and OpenSSL phases are in Edge-owned C++ code and have not been traced at sub-phase granularity. Combined, they represent ~1.9–2.2ms of cold-start cost.

## Goal

Trace both host-side buckets at sub-phase granularity to find the actual cost drivers, then apply only the optimizations that show ≥0.1ms in measurement. Target: combined ≥1ms wall-clock reduction on `edge -e ""` and `edge empty-startup.js`.

## Approach: Trace-First

Prior passes have shown that assumed cost drivers often differ from measured ones. Adding sub-phase trace points before writing optimizations avoids wasted effort.

## Section 1: Tracing

### N-API sub-phases

Add `EDGE_STARTUP_TRACE` begin/end pairs around each major step inside `unofficial_napi_create_env()` in `napi/v8/src/unofficial_napi.cc`:

| Sub-phase name | Wraps |
|---|---|
| `cli.env.napi.acquire-runtime` | `AcquireRuntime()` |
| `cli.env.napi.isolate-params` | `ApplyNodeIsolateCreateParams()` (sysconf + heap config) |
| `cli.env.napi.create-isolate` | `CreateIsolateForEnv()` (V8 isolate alloc + init) |
| `cli.env.napi.create-context` | `v8::Context::New(isolate)` |
| `cli.env.napi.env-from-context` | `unofficial_napi_create_env_from_context()` |

### OpenSSL sub-phases

Add `EDGE_STARTUP_TRACE` begin/end pairs inside `EdgeInitializeOpenSslForExecArgv()` in `src/edge_runtime.cc` to separate:

| Sub-phase name | Wraps |
|---|---|
| `cli.env.openssl.load-config` | `OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, ...)` call |
| `cli.env.openssl.csprng-check` | `EdgeValidateOpenSslCsprng()` (already exists, confirm separation) |

Run `EDGE_STARTUP_TRACE=1 ./build-edge/edge -e ""` for 5–10 samples, record median per sub-phase. Decision gate: only phases measuring ≥0.1ms become optimization candidates.

## Section 2: Optimization Candidates

### N-API side

**sysconf caching** (candidate if `cli.env.napi.isolate-params` ≥ 0.1ms):

`QueryEmbedderMemoryInfo()` calls `sysconf(_SC_PHYS_PAGES)` and `sysconf(_SC_PAGE_SIZE)` on every env creation. These values are constant for the process lifetime.

Fix: cache both results in a `static std::once_flag` block inside `QueryEmbedderMemoryInfo()`. Return cached values on subsequent calls.

**V8 context creation** (candidate if `cli.env.napi.create-context` ≥ 0.1ms):

For `-e ""` and `empty-startup.js`, the V8 context is needed immediately before JS runs, so wall-clock deferral is not possible. If this sub-phase is large, document it as unavoidable and skip.

**AcquireRuntime guard verification** (candidate if `cli.env.napi.acquire-runtime` shows on repeated runs):

`AcquireRuntime()` should be guarded by `std::once_flag`. If the trace shows measurable cost on non-first calls, the guard is not working correctly.

### OpenSSL side

**Config-load skip with guards** (candidate if `cli.env.openssl.load-config` ≥ 0.2ms):

When none of the following are active:
- `--openssl-config` flag
- `--openssl-shared-config` flag
- `OPENSSL_CONF` env var

Replace:
```cpp
OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, nullptr)
```
with:
```cpp
OPENSSL_init_crypto(OPENSSL_INIT_ADD_ALL_CIPHERS |
                    OPENSSL_INIT_ADD_ALL_DIGESTS |
                    OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr)
```

The CSPRNG validation (`EdgeValidateOpenSslCsprng()`) runs unconditionally regardless — fail-fast semantics are fully preserved.

**CSPRNG check** (if `cli.env.openssl.csprng-check` dominates): document, do not attempt to skip. This is a deliberate security check.

## Section 3: Measurement Protocol

Build baseline and candidate binaries, run:

```bash
hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-host-pass-baseline -e \"\"" \
  "/tmp/edge-host-pass-candidate -e \"\""

hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-host-pass-baseline benchmarks/workloads/empty-startup.js" \
  "/tmp/edge-host-pass-candidate benchmarks/workloads/empty-startup.js"
```

### Decision criteria

**Commit path**: combined changes produce ≥1ms median improvement on both workloads with non-overlapping σ bands. Document as Pass 6 in `docs/startup-investigation.md`.

**Partial commit path**: individual changes each show ≥0.1ms improvement with non-overlapping σ. Commit each passing change. If the combined total reaches ≥1ms across both OpenSSL and N-API, that counts as a full pass.

**Revert path**: no sub-phase clears ≥0.1ms in the trace, or optimizations produce no measurable wall-clock difference. Revert all changes, document as "tried and rejected" with the trace sub-phase data as evidence.

## Out of Scope

- V8 realm, primordials, or thread-switch phases (unavoidable without snapshot pipeline)
- `pre_execution` JS path splitting (separate future pass)
- Any change that removes the CSPRNG fail-fast check
- Startup snapshot pipeline

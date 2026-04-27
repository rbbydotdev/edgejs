# Host-Side C++ Pass (N-API + OpenSSL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trace the N-API environment creation and OpenSSL initialization buckets at sub-phase granularity, then apply only the changes that show ≥0.1ms on `edge -e ""` and `edge empty-startup.js`.

**Architecture:** Two independent investigations share a single measurement pass. Task 1–2 add temporary trace instrumentation to `unofficial_napi.cc` and `edge_runtime.cc`. Task 3 captures sub-phase medians. Task 4 removes all trace code. Tasks 5–6 implement the optimizations the trace confirms are worth pursuing (sysconf caching in `edge_napi_embedder_hooks.cc`; OpenSSL no-config fast path in `edge_runtime.cc`). Task 7 runs the A/B benchmark. Task 8 documents and commits.

**Tech Stack:** C++17, OpenSSL 3, V8, libuv (`uv_hrtime`), `std::chrono`, CMake build (`cmake --build build-edge -j8`).

---

## File Map

| File | Change |
|---|---|
| `napi/v8/src/unofficial_napi.cc` | Temporary sub-phase tracer (Tasks 1 + 4 only) |
| `src/edge_runtime.cc` | Temporary OpenSSL sub-phase marks (Tasks 2 + 4 only); permanent no-config fast path (Task 6) |
| `src/edge_napi_embedder_hooks.cc` | Permanent sysconf result caching (Task 5) |
| `docs/startup-investigation.md` | Pass 6 documentation (Task 8) |

---

### Task 1: Add N-API sub-phase trace points in `unofficial_napi.cc`

**Files:**
- Modify (temporarily): `napi/v8/src/unofficial_napi.cc`

- [ ] **Step 1: Add an inline sub-tracer struct at the top of `unofficial_napi_create_env_with_options`**

Find `napi_status NAPI_CDECL unofficial_napi_create_env_with_options(` at line 1832. Immediately after the opening brace and before `if (env_out == nullptr || scope_out == nullptr) return napi_invalid_arg;`, insert:

```cpp
  // TEMP TRACE — remove before commit
  struct NapiSubTracer {
    bool enabled;
    std::chrono::high_resolution_clock::time_point last;
    NapiSubTracer() : enabled([] {
      const char* v = std::getenv("EDGE_STARTUP_TRACE");
      return v != nullptr && v[0] != '\0' && v[0] != '0';
    }()), last(std::chrono::high_resolution_clock::now()) {}
    void mark(const char* phase) {
      if (!enabled) return;
      auto now = std::chrono::high_resolution_clock::now();
      double ms = std::chrono::duration<double, std::milli>(now - last).count();
      std::fprintf(stderr,
          "{\"edge_startup_trace\":\"%s\",\"delta_ms\":%.3f}\n", phase, ms);
      last = now;
    }
  } t;
  // END TEMP TRACE
```

- [ ] **Step 2: Add sub-phase marks around each major step**

After `napi_status status = AcquireRuntime(&platform);` (line ~1840), add:
```cpp
  t.mark("cli.env.napi.acquire-runtime");  // TEMP TRACE
```

After `ApplyNodeIsolateCreateParams(&params);` (line ~1869), add:
```cpp
  t.mark("cli.env.napi.isolate-params");  // TEMP TRACE
```

After `v8::Isolate* isolate = CreateIsolateForEnv(platform, params);` (line ~1870), add:
```cpp
  t.mark("cli.env.napi.create-isolate");  // TEMP TRACE
```

After `v8::Local<v8::Context> context = v8::Context::New(isolate);` (line ~1892), add:
```cpp
  t.mark("cli.env.napi.create-context");  // TEMP TRACE
```

After `status = unofficial_napi_create_env_from_context(context, module_api_version, &scope->env);` (line ~1895), add:
```cpp
  t.mark("cli.env.napi.env-from-context");  // TEMP TRACE
```

- [ ] **Step 3: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

---

### Task 2: Add OpenSSL sub-phase trace points in `edge_runtime.cc`

**Files:**
- Modify (temporarily): `src/edge_runtime.cc`

- [ ] **Step 1: Wrap `OPENSSL_init_crypto` inside `ConfigureOpenSslFromExecArgv` with timing**

Find `OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);` at line 2246 inside `ConfigureOpenSslFromExecArgv`. Replace it with:

```cpp
  // TEMP TRACE
  {
    const auto _t0 = std::chrono::high_resolution_clock::now();
    OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
    const char* _tv = std::getenv("EDGE_STARTUP_TRACE");
    if (_tv != nullptr && _tv[0] != '\0' && _tv[0] != '0') {
      const auto _t1 = std::chrono::high_resolution_clock::now();
      const double _ms =
          std::chrono::duration<double, std::milli>(_t1 - _t0).count();
      std::fprintf(stderr,
          "{\"edge_startup_trace\":\"cli.env.openssl.load-config\","
          "\"delta_ms\":%.3f}\n", _ms);
    }
  }
  // END TEMP TRACE
```

- [ ] **Step 2: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

---

### Task 3: Capture sub-phase trace data

**Files:**
- None (measurement only)

- [ ] **Step 1: Collect 10 trace samples for `edge -e ""`**

```bash
for i in $(seq 1 10); do
  EDGE_STARTUP_TRACE=1 ./build-edge/edge -e "" 2>&1 | \
    grep '"edge_startup_trace":"cli.env.napi\|cli.env.openssl.load-config'
done
```

Record: the `delta_ms` for each sub-phase across 10 runs. Compute median per phase.

- [ ] **Step 2: Collect 10 trace samples for `edge empty-startup.js`**

```bash
for i in $(seq 1 10); do
  EDGE_STARTUP_TRACE=1 ./build-edge/edge benchmarks/workloads/empty-startup.js 2>&1 | \
    grep '"edge_startup_trace":"cli.env.napi\|cli.env.openssl.load-config'
done
```

Record: same as Step 1.

- [ ] **Step 3: Apply decision gates**

For each sub-phase, note whether median ≥ 0.1ms:

| Sub-phase | Expected driver | Worth optimizing? |
|---|---|---|
| `cli.env.napi.acquire-runtime` | V8 platform init (one-time, should be ~0 after first call) | Only if > 0.1ms |
| `cli.env.napi.isolate-params` | sysconf calls in DetectTotalMemory | Only if ≥ 0.1ms |
| `cli.env.napi.create-isolate` | V8 isolate alloc + init | Likely unavoidable |
| `cli.env.napi.create-context` | V8 context creation | Unavoidable for eval path |
| `cli.env.napi.env-from-context` | N-API wrapper alloc | Likely small |
| `cli.env.openssl.load-config` | OPENSSL_init_crypto config load | Only if ≥ 0.1ms |

Record which phases clear ≥ 0.1ms. Proceed to Task 5 (sysconf) only if `cli.env.napi.isolate-params` ≥ 0.1ms. Proceed to Task 6 (OpenSSL skip) only if `cli.env.openssl.load-config` ≥ 0.1ms.

---

### Task 4: Remove all trace instrumentation

**Files:**
- Modify: `napi/v8/src/unofficial_napi.cc`
- Modify: `src/edge_runtime.cc`

- [ ] **Step 1: Revert both files to their pre-trace state**

```bash
git checkout napi/v8/src/unofficial_napi.cc
git checkout src/edge_runtime.cc
```

- [ ] **Step 2: Verify both files are clean**

```bash
git diff napi/v8/src/unofficial_napi.cc src/edge_runtime.cc
```

Expected: no output.

- [ ] **Step 3: Rebuild to confirm clean build**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

---

### Task 5: Cache `DetectTotalMemory()` result (run only if `cli.env.napi.isolate-params` ≥ 0.1ms)

**Files:**
- Modify: `src/edge_napi_embedder_hooks.cc`

If `cli.env.napi.isolate-params` was below 0.1ms in Task 3, skip this task entirely.

- [ ] **Step 1: Read the current `DetectTotalMemory` function**

The function currently reads (lines 14–29 of `src/edge_napi_embedder_hooks.cc`):

```cpp
uint64_t DetectTotalMemory() {
#if defined(_SC_PHYS_PAGES)
  const long pages = sysconf(_SC_PHYS_PAGES);
#if defined(_SC_PAGE_SIZE)
  const long page_size = sysconf(_SC_PAGE_SIZE);
#elif defined(_SC_PAGESIZE)
  const long page_size = sysconf(_SC_PAGESIZE);
#else
  const long page_size = 0;
#endif
  if (pages > 0 && page_size > 0) {
    return static_cast<uint64_t>(pages) * static_cast<uint64_t>(page_size);
  }
#endif
  return 0;
}
```

- [ ] **Step 2: Add a `<mutex>` include if not already present**

Check the top of `src/edge_napi_embedder_hooks.cc`. If `#include <mutex>` is already there (it is, at line 4), skip this step.

- [ ] **Step 3: Cache the sysconf result in a `std::once_flag`**

Replace the entire `DetectTotalMemory` function with:

```cpp
uint64_t DetectTotalMemory() {
  static std::once_flag once;
  static uint64_t cached = 0;
  std::call_once(once, []() {
#if defined(_SC_PHYS_PAGES)
    const long pages = sysconf(_SC_PHYS_PAGES);
#if defined(_SC_PAGE_SIZE)
    const long page_size = sysconf(_SC_PAGE_SIZE);
#elif defined(_SC_PAGESIZE)
    const long page_size = sysconf(_SC_PAGESIZE);
#else
    const long page_size = 0;
#endif
    if (pages > 0 && page_size > 0) {
      cached = static_cast<uint64_t>(pages) * static_cast<uint64_t>(page_size);
    }
#endif
  });
  return cached;
}
```

- [ ] **Step 4: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

- [ ] **Step 5: Verify runtime still works**

```bash
./build-edge/edge -e "console.log('ok')"
```

Expected: `ok`

---

### Task 6: Add OpenSSL no-config fast path (run only if `cli.env.openssl.load-config` ≥ 0.1ms)

**Files:**
- Modify: `src/edge_runtime.cc`

If `cli.env.openssl.load-config` was below 0.1ms in Task 3, skip this task entirely and proceed to Task 7.

- [ ] **Step 1: Locate the insertion point in `ConfigureOpenSslFromExecArgv`**

Find lines 2232–2246 in `src/edge_runtime.cc`:

```cpp
  OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();
  if (settings == nullptr) {
    if (error_out != nullptr) {
      *error_out = "Failed to allocate OpenSSL init settings";
    }
    return false;
  }

  OPENSSL_INIT_set_config_filename(settings, conf_file);
  OPENSSL_INIT_set_config_appname(settings, conf_section_name);
  OPENSSL_INIT_set_config_file_flags(settings, CONF_MFLAGS_IGNORE_MISSING_FILE);

  ERR_clear_error();
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
  OPENSSL_INIT_free(settings);
```

- [ ] **Step 2: Add the no-config fast path before the `OPENSSL_INIT_new()` call**

Insert immediately before `OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();`:

```cpp
  if (conf_file == nullptr && !ExecArgvHasFlagIn(exec_argv, "--openssl-shared-config")) {
    ERR_clear_error();
    OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, nullptr);
    return ERR_peek_error() == 0;
  }
```

The result should be:

```cpp
  if (conf_file == nullptr && !ExecArgvHasFlagIn(exec_argv, "--openssl-shared-config")) {
    ERR_clear_error();
    OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, nullptr);
    return ERR_peek_error() == 0;
  }

  OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();
  if (settings == nullptr) {
    if (error_out != nullptr) {
      *error_out = "Failed to allocate OpenSSL init settings";
    }
    return false;
  }
  // ... rest of existing function unchanged
```

- [ ] **Step 3: Rebuild**

```bash
cmake --build build-edge -j8 2>&1 | tail -5
```

Expected: build completes with no errors.

- [ ] **Step 4: Verify basic crypto still works via a Node-compat smoke test**

```bash
./build-edge/edge -e "const c = require('crypto'); console.log(c.createHash('sha256').update('hello').digest('hex'))"
```

Expected: `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`

- [ ] **Step 5: Verify TLS/HTTPS module loads**

```bash
./build-edge/edge -e "require('tls'); require('https'); console.log('ok')"
```

Expected: `ok`

---

### Task 7: A/B benchmark measurement

**Files:**
- None (measurement only)

- [ ] **Step 1: Copy the candidate binary**

```bash
cp ./build-edge/edge /tmp/edge-host-pass-candidate
```

- [ ] **Step 2: Build the baseline binary**

```bash
git stash
cmake --build build-edge -j8 2>&1 | tail -3
cp ./build-edge/edge /tmp/edge-host-pass-baseline
git stash pop
```

Confirm the optimization is restored after pop:
```bash
grep -n "OPENSSL_INIT_NO_LOAD_CONFIG" src/edge_runtime.cc
```
Expected: at least one match (if Task 6 ran).

- [ ] **Step 3: Measure `edge -e ""`**

```bash
hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-host-pass-baseline -e \"\"" \
  "/tmp/edge-host-pass-candidate -e \"\""
```

Record: baseline median ± σ, candidate median ± σ, delta ms, delta %.

- [ ] **Step 4: Measure `edge empty-startup.js`**

```bash
hyperfine --warmup 10 --runs 80 \
  "/tmp/edge-host-pass-baseline benchmarks/workloads/empty-startup.js" \
  "/tmp/edge-host-pass-candidate benchmarks/workloads/empty-startup.js"
```

Record: baseline median ± σ, candidate median ± σ, delta ms, delta %.

- [ ] **Step 5: Apply decision rule**

For each change applied (Task 5 and/or Task 6):
- **Commit** if individual change shows ≥ 0.1ms improvement with non-overlapping σ bands.
- **Combined commit** if the sum of individually-measured improvements reaches ≥ 1ms.
- **Revert individual change** if its contribution is < 0.1ms or σ bands overlap — run `git checkout src/edge_napi_embedder_hooks.cc` or `git checkout src/edge_runtime.cc` as appropriate.
- **Revert all** if nothing shows measurable improvement — run `git checkout src/edge_napi_embedder_hooks.cc src/edge_runtime.cc`.

---

### Task 8: Document Pass 6 and commit

**Files:**
- Modify: `docs/startup-investigation.md`

- [ ] **Step 1: Append Pass 6 section to `docs/startup-investigation.md`**

Add after the Pass 5 section:

```markdown
## Pass 6 Investigation: Host-Side C++ (N-API + OpenSSL)

### Hypothesis

Two host-side C++ buckets had not been traced at sub-phase granularity:
- `cli.env.create-napi-env` (~1.2–1.5ms): driven by V8 isolate + context creation
- `cli.env.openssl-init` (~0.7ms): split between config-file loading and CSPRNG check

### N-API sub-phase trace results

[Fill in medians from Task 3 — one row per sub-phase]

| sub-phase | median (ms) | action |
|---|---|---|
| cli.env.napi.acquire-runtime | [fill] | [cached / unavoidable] |
| cli.env.napi.isolate-params | [fill] | [cached / unavoidable] |
| cli.env.napi.create-isolate | [fill] | unavoidable |
| cli.env.napi.create-context | [fill] | unavoidable for eval path |
| cli.env.napi.env-from-context | [fill] | unavoidable |

### OpenSSL sub-phase trace results

| sub-phase | median (ms) | action |
|---|---|---|
| cli.env.openssl.load-config | [fill] | [skipped / unavoidable] |
| cli.env.openssl.csprng-check | [already traced] | keep |

### Changes

[Fill in which of Tasks 5 and 6 were committed vs reverted]

### Measurement (hyperfine --warmup 10 --runs 80)

| workload | baseline (Pass 5) | Pass 6 | delta |
|---|---|---|---|
| `edge -e ""` | 35.1ms ± 0.8ms | [fill] | [fill] |
| `edge empty-startup.js` | 34.4ms ± 0.7ms | [fill] | [fill] |

### Outcome

[COMMITTED / PARTIALLY COMMITTED / REVERTED]

### Lesson

[Fill in based on outcome]
```

- [ ] **Step 2: Update the cumulative results table (if anything was committed)**

If any change was committed, find the cumulative table in `docs/startup-investigation.md` and add a Pass 6 row.

- [ ] **Step 3: Stage and commit**

If code changes were committed:
```bash
git add src/edge_napi_embedder_hooks.cc src/edge_runtime.cc docs/startup-investigation.md
```

If docs only (all reverted):
```bash
git add docs/startup-investigation.md
```

Commit message (fill in actual numbers — no Co-Authored-By lines):

If code committed:
```bash
git commit -m "perf: host-side C++ startup optimizations (Pass 6)

[One sentence describing what was committed and what was reverted]

Measured A/B (hyperfine --warmup 10 --runs 80):
  edge -e \"\":                  35.1ms -> Xms  (-Y%)
  edge benchmarks/workloads/empty-startup.js:  34.4ms -> Xms  (-Y%)"
```

If docs only:
```bash
git commit -m "docs: document Pass 6 host-side C++ investigation

Traced N-API and OpenSSL sub-phases. [One sentence outcome]."
```

- [ ] **Step 4: Verify clean state**

```bash
git status
```

Expected: `nothing to commit, working tree clean`

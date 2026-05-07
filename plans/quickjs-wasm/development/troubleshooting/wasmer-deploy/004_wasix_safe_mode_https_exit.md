# Wasmer Deploy: WASIX safe-mode HTTPS exits before callbacks

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Runtime fix is implemented and the CI-matching Linux/Wasmer safe-mode suite passes. |
| **Severity** | High | Blocks the root `build-wasix-linux` job in the main V8/imports WASIX workflow. |

## Issue

The root `build-wasix-linux` workflow builds the V8/imports WASIX artifact with:

```sh
make build-wasix
make test-wasix-safe-mode WASMER_BIN=wasmer
```

The safe-mode smoke suite passed the earlier microtask, Blob, and HTTP fetch
cases, then failed on HTTPS fetch:

```text
fetch https://example.com/ stdout mismatch
expected: 'FETCH HTTPS 200\n'
actual:   ''
stderr: [callback trampoline] error calling function: RuntimeError: WASI exited with code: ExitCode::0
```

The callback trampoline message means a host-side N-API callback attempted to
re-enter the guest module after Wasmer considered the WASI process exited. The
HTTPS path exposed this because TLS/fetch completion can enqueue promise and
process task work after the libuv loop briefly appears idle to the Edge runtime.

## Action Plan

1. Keep the main `.github/workflows/test-and-build.yml` and root `wasmer.toml`
   unchanged.
2. Fix the runtime drain in `src/`, not the workflow.
3. Rebuild the WASIX artifact.
4. Verify the safe-mode smoke suite with Wasmer 7.1.0, including HTTPS fetch,
   `https.get`, and `tls.connect`.
5. Rebuild once inside a Linux Docker container with the CI wasixcc release and
   sysroot tag.

## Fix

`RunEventLoopUntilQuiescent(...)` now drains all runtime-visible JavaScript task
queues during its idle grace window and after `beforeExit`, rather than draining
only the platform queue. The combined drain runs:

```text
EdgeRuntimePlatformDrainTasks
DrainProcessTickCallback
unofficial_napi_process_microtasks
```

This gives promise continuations and process ticks scheduled from late
host/N-API callbacks a chance to run before the runtime emits `exit`.

## Verification

Linux Docker smoke testing against the rebuilt WASIX artifact passed with
Wasmer 7.1.0:

```sh
python3 ./scripts/test-wasix-safe-mode.py --wasmer-bin wasmer --package-dir /work --timeout 45
```

Result:

```text
[ok] fetch https://example.com/: FETCH HTTPS 200
[ok] https.get https://example.com/: HTTPS 200
[ok] tls.connect verified example.com: TLS CONNECTED true
All WASIX safe-mode smoke tests passed.
```

The final Linux Docker rebuild and post-rebuild safe-mode rerun are still in
complete.

The artifact was rebuilt in native arm64 Ubuntu Docker using wasixcc v0.4.2 and
the CI sysroot tag `v2026-02-16.1`:

```sh
make build-wasix
```

That produced:

```text
build-wasix/edge.wasm
build-wasix/edgejs.wasm
```

The safe-mode verification was then run under Linux `amd64` Docker with Wasmer
7.1.0, matching the GitHub `ubuntu-latest` runner architecture:

```sh
python3 ./scripts/test-wasix-safe-mode.py --wasmer-bin wasmer --package-dir /work --timeout 45
```

Result:

```text
[ok] queueMicrotask: A
C
B
[ok] blob.arrayBuffer: BLOB 3
[ok] fetch http://example.com/: FETCH 200
[ok] fetch https://example.com/: FETCH HTTPS 200
[ok] https.get https://example.com/: HTTPS 200
[ok] tls.connect verified example.com: TLS CONNECTED true
TLS CLOSE
TLS EXIT 0
All WASIX safe-mode smoke tests passed.
```

Native arm64 Wasmer 7.1.0 still failed before JavaScript startup with an
unknown `napi_extension_wasmer_v0.unofficial_napi_create_env` import. The
CI-matching Linux `amd64` Wasmer path succeeds.

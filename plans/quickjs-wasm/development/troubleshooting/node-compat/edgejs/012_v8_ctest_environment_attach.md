# V8 CTest Runtime Fixture Environment Attachment

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | The fixture environment attachment is fixed; broader V8 CTest coverage still has unrelated failures. |
| **Severity** | Medium | The V8 CLI smoke path works, but the generated runtime CTest suite fails before fixture scripts run. |

## Observation

After merging `main` into `quickjs`, the V8 build completed and the V8 CLI
smoke tests passed. Running:

```sh
ctest --test-dir build-edge --output-on-failure
```

failed immediately in `Test0RuntimePhase01` fixtures because
`EdgeInitializeTimersHost(env)` returned `napi_generic_failure`. The first
failures reported `Failed to initialize timers host` before any fixture script
could run.

## Diagnosis

The generated CTest fixture creates a raw N-API environment with
`unofficial_napi_create_env(...)`, installs platform hooks, and initializes the
timers host. The runtime code now expects an attached `edge::Environment`
behind the N-API environment before timer handles are initialized. The normal
CLI path attaches that runtime environment through
`EdgeAttachEnvironmentForRuntime(...)`.

The test fixture was therefore exercising a stale setup path: it asked the
timers host to initialize before the env had the same Edge runtime attachment
the CLI uses.

## Action Plan

1. Update `tests/runners/test_env.h` to attach the Edge runtime environment
   immediately after creating the N-API env.
2. Keep the existing platform hook and timer initialization checks in place.
3. Rebuild the V8 target and rerun the focused failing test first.
4. Rerun the broader V8 CTest suite if the focused test passes.
5. Confirm the QuickJS CTest suite remains green.

## Result

`tests/runners/test_env.h` now attaches the Edge runtime environment through
`EdgeAttachEnvironmentForRuntime(...)` immediately after creating the raw N-API
environment. The focused CTest regression:

```sh
ctest --test-dir build-edge -R ValidFixtureScriptReturnsZero --output-on-failure
```

passes after the change. `ctest --test-dir build-edge-quickjs-cli
--output-on-failure` also passes `66/66`.

The full V8 CTest registry advances past the original timers-host initialization
failure, then exposes other existing broad-suite failures, including a CJS/ESM
fixture timeout, a zlib/debuglog binding mismatch, a REPL version-string
expectation mismatch, and QuickJS-specific promise-details coverage being run
against the V8 binary. Those are outside this fixture-attachment fix.

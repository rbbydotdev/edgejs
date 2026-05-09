# Node Test: OS constants and userInfo errors

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Low | OS API parity issues are narrow but visible in the Node suite. |

Affected tests:

- `parallel/test-os-constants-signals`
- `parallel/test-os-userinfo-handles-getter-errors`

## What Is The Issue

`test-os-constants-signals` expects assigning to `os.constants.signals.FOOBAR`
in strict mode to throw a plain TypeError. The QuickJS run reports
`ERR_INVALID_ARG_VALUE`, which suggests the constants object shape or property
descriptor behavior differs from Node.

`test-os-userinfo-handles-getter-errors` expects child-process behavior proving
that `os.userInfo()` handles getter errors safely. The log shows the parent
assertion `userInfo crashes`, meaning the expected child outcome was not
observed.

## How Should We Fix It

For constants, compare descriptors on `os.constants.signals` between V8 Edge and
QuickJS Edge. The fix should make the object immutable/frozen in the Node-compatible
way, so strict assignment fails with the expected TypeError rather than a custom
argument error.

For `userInfo()`, run the test directly and inspect the child stderr/stdout.
Then audit the native `os.userInfo()` binding and JS wrapper for property access
that can invoke user-controlled getters during error formatting or option
handling. Match Node's behavior by catching and preserving the intended error
instead of crashing or converting it into an unrelated assertion path.

Targeted verification:

```sh
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-os-constants-signals.js
build-edge-quickjs-cli/edge test/parallel/test-os-userinfo-handles-getter-errors.js
```

# Node Test: `node:test` public API exports

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | High | Any ESM test importing the full public `node:test` API can fail at link time. |

Affected tests:

- `parallel/test-dgram-async-dispose`
- `parallel/test-events-add-abort-listener`

## What Is The Issue

Both tests fail during ESM module linking:

```text
SyntaxError: Could not find export 'describe' in module 'node:test'
```

`lib/test.js` exports `describe: suite` for CommonJS consumers, but the QuickJS
ESM facade for the builtin does not declare that named export before module
linking. QuickJS requires named exports to be declared before evaluation, unlike
CommonJS property access after `require()`.

## How Should We Fix It

Update the QuickJS builtin-to-ESM facade generation so builtin CommonJS modules
declare all stable public names from the evaluated export object. At minimum,
`node:test` must declare `test`, `it`, `describe`, `suite`, hooks, `run`,
`mock`, `snapshot`, and `assert` consistently with `lib/test.js`.

This should probably reuse the same synthetic CommonJS named-export discovery
path used for package CJS facades, but builtins can be safer: after evaluating a
builtin once, cache its own enumerable export names and use that list when
creating the QuickJS module facade.

Targeted verification:

```sh
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-dgram-async-dispose.mjs
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-events-add-abort-listener.mjs
```

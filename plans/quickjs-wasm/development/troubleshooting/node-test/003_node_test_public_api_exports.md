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

## Current Status

The earlier idea of extending QuickJS C++ CommonJS facade generation is no
longer current. The C++ CJS/module-loader hack has been removed. If this Node
test issue is addressed, the named-export behavior should come from Node's
JavaScript loaders/translators or another proper EdgeJS-owned runtime path, not
from new QuickJS C++ source-text heuristics.

At minimum, `node:test` must expose `test`, `it`, `describe`, `suite`, hooks,
`run`, `mock`, `snapshot`, and `assert` consistently with `lib/test.js` if this
compatibility gap is reopened.

Targeted verification:

```sh
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-dgram-async-dispose.mjs
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-events-add-abort-listener.mjs
```

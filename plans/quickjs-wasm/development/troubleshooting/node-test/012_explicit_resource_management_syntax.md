# Node Test: explicit resource management syntax

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | High | Any test or user code using modern `using` / `await using` syntax fails at parse time. |

Affected tests:

- `parallel/test-stream-duplex-destroy`
- `parallel/test-stream-readable-dispose`
- `parallel/test-stream-transform-destroy`
- `parallel/test-stream-writable-destroy`

## What Is The Issue

The stream destroy/dispose tests fail before execution:

```text
SyntaxError: expecting ';'
```

The failing source files use modern explicit resource management syntax. The
current QuickJS parser does not understand `using` / `await using`, so the
CommonJS loader cannot compile the tests.

## How Should We Fix It

This is a language-front-end gap. There are three viable paths:

- update the vendored QuickJS source to a version/fork that supports explicit
  resource management;
- add a narrowly scoped source transform in the test/runtime loader for
  `using` syntax; or
- skip these tests until the engine supports the syntax.

The preferred runtime-compatible fix is engine support. A loader transform is
riskier because disposal semantics are subtle and should preserve
`Symbol.dispose`, `Symbol.asyncDispose`, exception suppression, and async
ordering exactly enough for Node streams.

Targeted verification after engine or loader support:

```sh
build-edge-quickjs-cli/edge test/parallel/test-stream-duplex-destroy.js
build-edge-quickjs-cli/edge test/parallel/test-stream-readable-dispose.js
build-edge-quickjs-cli/edge test/parallel/test-stream-transform-destroy.js
build-edge-quickjs-cli/edge test/parallel/test-stream-writable-destroy.js
```

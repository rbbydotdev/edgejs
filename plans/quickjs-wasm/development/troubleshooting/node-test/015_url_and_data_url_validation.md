# Node Test: URL and data URL validation

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Several URL tests fail through a shared validation/error path. |

Affected tests:

- `parallel/test-data-url`
- `parallel/test-url-fileurltopath`
- `parallel/test-url-domain-ascii-unicode`
- `parallel/test-url-format`
- `parallel/test-url-format-whatwg`
- `parallel/test-url-format-invalid-input`
- `parallel/test-url-parse-format`

## What Is The Issue

These tests all report a compact test-runner failure shaped like:

```text
TypeError [undefined]:
  code: 'ERR_INVALID_ARG_VALUE'
```

The log does not include the specific subtest assertion, but the affected files
all exercise URL/data URL parsing, formatting, file URL conversion, IDNA/domain
conversion, or invalid-input handling.

This points at a shared mismatch in `internal/url`, `internal/data_url`, or the
error constructors used by those modules under QuickJS.

## How Should We Fix It

Rerun each test with a reporter that prints subtest names and with focused
instrumentation around `ERR_INVALID_ARG_VALUE`. Then split any discovered
failures into parsing, formatting, and error-message subtasks if needed.

Likely fix areas:

- ensure `URL.canParse`, `URL.parse`, `url.format()`, and `fileURLToPath()`
  match Node's coercion and invalid-input rules;
- verify IDNA/domain conversions use the same ICU/Intl or fallback behavior
  expected by the tests;
- make `ERR_INVALID_ARG_VALUE` construction include the expected argument name,
  value, and reason instead of producing an empty message.

Targeted verification:

```sh
build-edge-quickjs-cli/edge --expose-internals --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-data-url.js
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-url-fileurltopath.js
build-edge-quickjs-cli/edge --test-reporter=test/common/test-error-reporter.js --test-reporter-destination=stdout test/parallel/test-url-format.js
```

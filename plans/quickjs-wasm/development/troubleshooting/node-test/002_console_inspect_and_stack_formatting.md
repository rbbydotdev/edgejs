# Node Test: console inspect and stack formatting

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
| **Severity** | Medium | Breaks console output compatibility and pseudo-TTY formatting checks. |

Affected tests:

- `parallel/test-console-issue-43095`
- `parallel/test-console-table`
- `pseudo-tty/console_colors`

## What Is The Issue

`console.dir()` / `util.inspect()` does not tolerate revoked proxies the way
Node does. The log shows `TypeError: revoked proxy` escaping from
`getOwnPropertyDescriptor()` during inspection.

`console.table()` renders the table header/footer for a Map-like value but omits
the expected rows, so iterable entry handling or table row normalization is
incomplete.

The pseudo-TTY color test output has the right ANSI color markers in early
lines, but stack frames are QuickJS bootstrap frames like `<input>:1806:27`.
The expected output wants Node-style file/resource names and internal frame
coloring.

## How Should We Fix It

Keep the fix in the JS console/inspect layer where possible:

- Wrap revoked-proxy descriptor/property probes in the same defensive paths Node
  uses in `internal/util/inspect`, returning a stable placeholder instead of
  throwing.
- Audit `console.table()` Map and iterator extraction so rows are built from
  `[key, value]` entries before column width calculation.
- Reuse the QuickJS source-map/error formatting helpers already present for
  other stack fixes so `console.trace()` and printed `Error` stacks retain the
  original script filename, CommonJS wrapper name, and `node:internal/...`
  formatting.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-console-issue-43095.js
build-edge-quickjs-cli/edge test/parallel/test-console-table.js
/opt/homebrew/opt/python@3.14/bin/python3.14 test/tools/pseudo-tty.py build-edge-quickjs-cli/edge test/pseudo-tty/console_colors.js
```

# Node Test: console inspect and stack formatting

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Console table fixed; revoked proxy and pseudo-TTY stack formatting remain open. |
| **Severity** | Medium | Breaks console output compatibility and pseudo-TTY formatting checks. |

Affected tests:

- `parallel/test-console-issue-43095`
- `parallel/test-console-table`
- `pseudo-tty/console_colors`

## What Is The Issue

`console.dir()` / `util.inspect()` does not tolerate revoked proxies the way
Node does. The log shows `TypeError: revoked proxy` escaping from
`getOwnPropertyDescriptor()` during inspection.

`console.table()` rendered the table header/footer for a Map iterator but
omitted the expected rows. The JS table code calls
`internalBinding('util').previewEntries()` for Map/Set objects and iterators;
the QuickJS N-API implementation returned an empty array for every input, so
the table formatter had no rows to render.

The pseudo-TTY color test output has the right ANSI color markers in early
lines, but stack frames are QuickJS bootstrap frames like `<input>:1806:27`.
The expected output wants Node-style file/resource names and internal frame
coloring.

## How Should We Fix It

Keep fixes native-only; `lib/` files are off-limits.

- Wrap revoked-proxy descriptor/property probes in the same defensive paths Node
  uses in `internal/util/inspect`, returning a stable placeholder instead of
  throwing, but implement the compatibility hook on the native side.
- Implement QuickJS-backed `unofficial_napi_preview_entries()` so Map/Set
  objects and iterators return V8-shaped preview arrays without advancing
  iterators. This is now implemented by `JS_PreviewEntries()` in vendored
  QuickJS and fixes `parallel/test-console-table`.
- Reuse the QuickJS source-map/error formatting helpers already present for
  other stack fixes so `console.trace()` and printed `Error` stacks retain the
  original script filename, CommonJS wrapper name, and `node:internal/...`
  formatting.

## 2026-05-15 Update

Implemented a native QuickJS preview helper:

- `quickjs.h` exposes `JS_PreviewEntries(ctx, value, &is_key_value)`.
- `quickjs.c` snapshots `Map`, `Set`, `Map Iterator`, and `Set Iterator`
  records directly from QuickJS collection storage without mutating iterator
  state.
- `quickjs/src/unofficial_napi.cc` now routes
  `unofficial_napi_preview_entries()` through that helper instead of returning
  an empty array.

Verified:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge --expose-internals -e "<previewEntries Map/Set smoke>"
build-edge-quickjs-cli/edge test/parallel/test-console-table.js
```

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-console-issue-43095.js
build-edge-quickjs-cli/edge test/parallel/test-console-table.js
/opt/homebrew/opt/python@3.14/bin/python3.14 test/tools/pseudo-tty.py build-edge-quickjs-cli/edge test/pseudo-tty/console_colors.js
```

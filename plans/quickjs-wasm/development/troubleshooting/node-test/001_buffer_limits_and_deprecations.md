# Node Test: Buffer limits and deprecation parity

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Buffer length fixes landed; `Buffer()` deprecation filtering remains open. |
| **Severity** | Medium | Blocks multiple Buffer compatibility tests but does not explain broader runtime failures. |

Source log:

```text
/Users/sadhbh/src/dev/edgejs/test-only.log
```

Affected tests:

- `parallel/test-buffer-alloc`
- `parallel/test-buffer-constants`
- `parallel/test-buffer-constructor-node-modules`
- `parallel/test-buffer-constructor-node-modules-paths`
- `parallel/test-buffer-tostring-4gb`

## What Is The Issue

The Buffer failures split into two related areas:

- Oversized allocations expose QuickJS native typed-array errors such as
  `RangeError: invalid array index` or `RangeError: invalid array buffer length`
  instead of Node's `Invalid typed array length: 9007199254740992` /
  `Invalid string length` behavior.
- `Buffer()` deprecation warning suppression for code under `node_modules`
  differs from Node. The current run emits `[DEP0005]` in paths where the test
  expects no stderr.

`test-buffer-tostring-4gb` also reaches raw typed-array construction before the
test can exercise Node's large-buffer string conversion behavior.

## 2026-05-15 Update

The direct typed-array constructor message from `parallel/test-buffer-alloc` is
fixed in the vendored QuickJS source by giving typed-array length conversion a
Node-compatible `RangeError: Invalid typed array length: <value>` path before
QuickJS falls back to its generic `invalid array index` text.

Targeted verification:

```sh
cmake --build build-edge-quickjs-cli --target edge -j4
build-edge-quickjs-cli/edge -e "const { kMaxLength } = require('buffer'); try { new Uint8Array(kMaxLength + 1); } catch (e) { console.log(e.name + ': ' + e.message); }"
```

Observed output:

```text
RangeError: Invalid typed array length: 9007199254740992
```

The full `parallel/test-buffer-alloc` file then got past that assertion but
still failed later on unmatched-surrogate UTF-8 replacement bytes at line 857
(`237 !== 239`). That was treated as a separate Buffer/string encoding issue.

## 2026-05-15 QuickJS Limit And UTF-8 Update

The vendored QuickJS source now replaces unmatched UTF-16 surrogate code units
with U+FFFD when exporting normal UTF-8 through `JS_ToCStringLen2`. This fixes
the `Buffer.from('ab\\ud800cd', 'utf8')` byte sequence in
`parallel/test-buffer-alloc`.

QuickJS string and allocation limit behavior was also normalized:

- QuickJS `RangeError` text for string overflow is now
  `Invalid string length`.
- `internalBinding('buffer').kStringMaxLength` now reflects QuickJS's actual
  string ceiling, `0x3fffffff`, through a QuickJS-only runtime compile
  definition. The same shared Buffer binding still reports V8's native limit for
  the V8 backend.
- ArrayBuffer construction beyond QuickJS's hard `INT32_MAX` backing-store cap
  now reports `Array buffer allocation failed`, letting 4GB allocation tests
  skip through their accepted OOM path.

Targeted verification passed:

```sh
build-edge-quickjs-cli/edge test/parallel/test-buffer-alloc.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constants.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-tostring-4gb.js
build-edge-quickjs-cli/edge test/sequential/test-buffer-creation-regression.js
```

The 4GB tests intentionally skipped with accepted allocation-failure messages.

## How Should We Fix It

Keep the direct typed-array constructor, UTF-8 surrogate replacement, string
limit, and ArrayBuffer allocation-cap fixes in vendored QuickJS/native binding
code. Do not move these into `lib/`.

Remaining work is deprecation filtering. Inspect the `Buffer()` warning gate in
`lib/buffer.js` and the native `internalBinding('util').isInsideNodeModules()`
implementation. Reproduce the two failing tests with `--trace-deprecation` and
compare the structured stack frames with the V8 path. Fix the node-modules
classification so synthetic and real fixture paths are treated the same way Node
treats them.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-buffer-alloc.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constants.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constructor-node-modules.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constructor-node-modules-paths.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-tostring-4gb.js
```

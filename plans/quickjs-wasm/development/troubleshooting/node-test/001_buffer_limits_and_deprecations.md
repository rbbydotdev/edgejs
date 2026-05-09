# Node Test: Buffer limits and deprecation parity

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Planned investigation. |
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

## How Should We Fix It

Add Buffer-facing range guards before QuickJS allocates typed arrays. The guard
should normalize oversized `Buffer.alloc()`, `Buffer.allocUnsafe()`, and backing
`FastBuffer` construction to Node-compatible `RangeError` messages and string
maximum checks. Prefer implementing this at the Buffer/native binding boundary
instead of trying to rewrite QuickJS engine error text globally.

For deprecations, inspect the `Buffer()` warning gate in `lib/buffer.js` and the
native `internalBinding('util').isInsideNodeModules()` implementation. Reproduce
the two failing tests with `--trace-deprecation` and compare the structured
stack frames with the V8 path. Fix the node-modules classification so synthetic
and real fixture paths are treated the same way Node treats them.

Targeted verification:

```sh
build-edge-quickjs-cli/edge test/parallel/test-buffer-alloc.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constants.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constructor-node-modules.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-constructor-node-modules-paths.js
build-edge-quickjs-cli/edge test/parallel/test-buffer-tostring-4gb.js
```

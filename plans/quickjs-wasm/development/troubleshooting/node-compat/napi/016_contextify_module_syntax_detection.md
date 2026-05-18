# QuickJS Contextify Module Syntax Detection

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed with an internal QuickJS `compile_cjs_function(...)` helper and parser-backed syntax detection. |
| **Severity** | High | Incorrect ambiguous `.js` format detection sends CommonJS packages through the ESM linker and blocks Astro/Vite startup. |

## Failure

Running the native QuickJS Edge CLI in `stackmachine.com` currently fails:

```sh
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge pnpm run start
```

Observed failure:

```text
SyntaxError: Could not find export 'default' in module
'file:///Users/syrusakbary/Development/stackmachine.com/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'
```

The reduced static import repro is:

```sh
cd /Users/syrusakbary/Development/stackmachine.com
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge --input-type=module \
  -e "import esbuild from 'file:///Users/syrusakbary/Development/stackmachine.com/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'; console.log(esbuild)"
```

V8 Edge and native Node load the same file successfully and expose the CommonJS
namespace facade with `default`, `module.exports`, and named exports.

## Diagnosis

`esbuild@0.25.12/lib/main.js` is CommonJS:

- `package.json` has no `"type": "module"`.
- `package.json` points `"main"` at `lib/main.js`.
- `lib/main.js` assigns `module.exports = __toCommonJS(node_exports)`.

The loader divergence happens before synthetic CommonJS export population:

- V8 Edge logs `Translating CJSModule .../esbuild/lib/main.js`.
- QuickJS Edge logs `Translating StandardModule .../esbuild/lib/main.js`.

For ambiguous `.js` files, `lib/internal/modules/esm/get_format.js` delegates to
`internalBinding('contextify').containsModuleSyntax(...)`. V8 implements this by
parsing as a CommonJS function first and only retrying as ESM for CJS parse
failures that are plausibly ESM-only syntax.

QuickJS currently implements the same API with substring checks:

```cpp
src.find("export ") != std::string::npos ||
src.find("import ") != std::string::npos ||
src.find("import(") != std::string::npos
```

`esbuild/lib/main.js` contains no actual static ESM syntax, but it does contain:

```js
var __export = (target, all) => { ... }
// Annotate the CommonJS export names for ESM import in node:
```

That makes QuickJS return `true` for `containsModuleSyntax(...)`, so Node's JS
loader treats the file as ESM. The QuickJS ESM linker then correctly rejects the
Vite import because a CommonJS source file has no declared ESM `default` export.

## Correctness Bar

The fix must not be a lexer workaround, package exception, or esbuild/Vite
special case.

The desired behavior is parser-backed:

1. Try to parse the source as a CommonJS function body with the same wrapper
   parameter policy requested by `cjs_var_in_scope`.
2. If that parse succeeds, the source does not require ESM classification.
3. If the CommonJS parse fails, try to parse the original source as an ESM
   source text module.
4. Return `true` only when the ESM parse succeeds.
5. Preserve the original CommonJS parse error for `compileFunctionForCJSLoader`
   when detection is disabled or the ESM parse does not succeed.

This matches the important V8/Node property without depending on V8 error
message strings: actual parser acceptance decides the classification.

## Upstream-Quality Design

The QuickJS-facing change should be an engine/parser capability, not Node module
policy. The clean target is a small public or internal QuickJS parser helper
that can validate source text under a requested parse goal without executing it.

Candidate API shape:

```c
typedef enum JSParseGoalEnum {
    JS_PARSE_GOAL_SCRIPT,
    JS_PARSE_GOAL_MODULE,
    JS_PARSE_GOAL_FUNCTION_BODY,
} JSParseGoalEnum;

int JS_ParseSource(JSContext *ctx,
                   const char *input,
                   size_t input_len,
                   const char *filename,
                   JSParseGoalEnum goal,
                   const char * const *param_names,
                   int param_count);
```

Expected semantics:

- return `0` on parse success and `-1` with a pending exception on parse failure;
- allocate and free parser/compiler state through the same ownership paths as
  existing QuickJS compile operations;
- never evaluate user code;
- avoid looking up global constructors such as `Function`;
- support function-body parsing with an explicit parameter list so embedders do
  not have to synthesize wrapper source strings;
- keep module parsing identical to normal QuickJS source-text module parsing.

If upstream does not want a general public API, keep the helper local to the
vendored QuickJS patch but design it with the same constraints and naming style
so the patch remains reviewable and minimal.

## Edge Integration Plan

1. Add focused parser helper tests at the QuickJS layer.
   Cover CommonJS bodies, ESM declarations, `import.meta`, top-level `await`,
   comments containing `import`/`export`, identifiers such as `__export`, string
   literals, regex literals, and syntax that is invalid in both CJS and ESM.

2. Replace `napi_contextify__::contains_module_syntax(...)` with parser-backed
   classification:
   - CJS goal first, using wrapper params only when `cjs_var_in_scope` is true;
   - ESM goal second only after CJS parse failure;
   - clear discarded parser exceptions so the N-API env is left clean on a
     boolean success result.

3. Update `ContextifyCompileFunctionForCJSLoaderCallback(...)` and/or
   `napi_contextify__::compile_function(...)` so `should_detect_module` uses the
   same parser-backed decision and still rethrows the original CJS compile error
   when the source is not valid ESM.

4. Add N-API tests under the existing contextify test runner:
   - `containsModuleSyntax("module.exports = 1") == false`;
   - `containsModuleSyntax("export const x = 1") == true`;
   - `containsModuleSyntax("await 1") == true` for ambiguous source;
   - `containsModuleSyntax("__export(...); // export names import in node") == false`;
   - esbuild-style CommonJS prologue/body fixture returns false;
   - invalid syntax returns false or propagates only through the compile loader
     path as Node expects.

5. Add loader-level regression tests:
   - ESM imports a fixture `.js` CommonJS file with esbuild-style comments and
     receives `default`, `module.exports`, and declared named exports.
   - ESM imports a true ambiguous `.js` module and gets ESM behavior.
   - V8 and QuickJS expectations match for the same fixtures.

6. Verify with real commands:

```sh
make build-napi-quickjs
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_65_unofficial_contextify
make test-napi-quickjs-only
cd /Users/syrusakbary/Development/stackmachine.com
NODE_DEBUG=esm /Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge --input-type=module \
  -e "import esbuild from 'file:///Users/syrusakbary/Development/stackmachine.com/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'; console.log(typeof esbuild)"
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge pnpm run start
```

If implementation touches `napi/quickjs/` and the native gate passes, run the
WASIX-impacting rebuild:

```sh
cd /Users/syrusakbary/Development/edgejs/quickjs-wasm/ && ./build.sh
```

## Non-Goals

- Do not patch `stackmachine.com`, Vite, Astro, pnpm, or `node_modules`.
- Do not add package-name checks for `esbuild`.
- Do not replace the substring check with a hand-written JavaScript lexer.
- Do not resurrect a C++ CommonJS resolver or CommonJS export scanner.
- Do not classify dynamic `import(...)` alone as ESM syntax if it parses as a
  CommonJS function body.

## Open Questions

- Whether the parser helper should be a public QuickJS API, a private vendored
  API, or an Edge-local wrapper around existing QuickJS compile internals.
- Whether QuickJS should expose function-body parsing directly, or whether
  Edge should temporarily use wrapped source text while an upstreamable helper
  is prepared.
- Exact parity for `cjs_var_in_scope == false`, used by Node when CommonJS
  wrapper variables should not affect syntax detection.

## Implementation Result

The fix stayed inside the QuickJS contextify backend. It did not add a new
`unofficial_napi` entry point.

`napi_contextify__` now has an internal `compile_cjs_function(...)` helper that
matches the important V8 `CompileCjsFunction(...)` behavior for Edge's needs:

- compile a function body with an explicit parameter list;
- pass the CommonJS wrapper params only when the caller requests a CJS scope;
- return a function object without executing the user body;
- preserve parser exceptions for the compile path;
- let syntax detection discard parser exceptions after classification.

The helper compiles a parenthesized CommonJS wrapper expression with
`JS_Eval2(..., JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY)` and then
instantiates that wrapper expression with `JS_EvalFunction(...)`. It does not
look up or invoke the mutable global `Function` constructor.

`contains_module_syntax(...)` now uses parser behavior instead of substring
matching:

1. Compile as a CommonJS function body.
2. If that succeeds, return `false`.
3. If that fails, compile the original source as a source-text module.
4. Return `true` only when the module compile succeeds.

Regression coverage was added for:

- normal CommonJS source;
- static ESM syntax;
- compiling a function after `globalThis.Function` has been monkey-patched;
- esbuild-style `__export` identifiers and comments containing `export` /
  `import`;
- dynamic `import(...)` inside valid CommonJS;
- top-level `await` as an ESM-only parse case.

Verified:

```sh
make build-napi-quickjs
./build-edge-quickjs-cli/napi-quickjs/tests/napi_quickjs_test_65_unofficial_contextify
make test-napi-quickjs-only
```

The direct esbuild checks now match V8 behavior:

```sh
/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge -e \
  "const src=require('fs').readFileSync('/Users/syrusakbary/Development/stackmachine.com/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js','utf8'); console.log(internalBinding('contextify').containsModuleSyntax(src, '/tmp/main.js', 'file:///tmp/main.js'));"

/Users/syrusakbary/Development/edgejs/build-edge-quickjs-cli/edge --input-type=module \
  -e "import esbuild from 'file:///Users/syrusakbary/Development/stackmachine.com/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'; console.log(typeof esbuild)"
```

The first command prints `false`. The second succeeds and imports the CommonJS
default object.

The original `pnpm run start` command now advances past the esbuild
default-export linker failure and stops at the separate known compatibility gap:

```text
ReferenceError: WebAssembly is not defined
```

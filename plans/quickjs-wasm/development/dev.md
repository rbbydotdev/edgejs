# Edge QuickJS development phases

This is the short index for the QuickJS WASIX development notes. Each phase
captures one step in moving from a plan  toward a published Edge QuickJS package
capable of serving framework-built web apps.

## Phase index

### [dev_001.md](dev_001.md): QuickJS N-API EdgeJS merge analysis

Why: establish what the other branch had already solved, what belonged in our
cleaner QuickJS N-API implementation, and what EdgeJS integration pieces needed
to be ported.

What was done: compared the two EdgeJS trees and N-API submodules, identified
provider-selection plumbing, WASIX package scaffolding, runtime hooks, symbol
ownership concerns, and the gaps in our QuickJS provider before integration.

### [dev_002.md](dev_002.md): QuickJS N-API EdgeJS execution and bootstrap troubleshooting

Why: get the native QuickJS-backed Edge CLI far enough through Node bootstrap to
run `quickjs-wasm/echo-server.js`.

What was done: added bootstrap and contextify diagnostics, fixed
`ContextifyScript` by defining it as a N-API class, installed Node-required
well-known symbols such as dispose symbols, and verified the HTTP echo server
path worked in the native QuickJS CLI while recording remaining teardown issues.

### [dev_003.md](dev_003.md): Edge QuickJS REPL TTY troubleshooting

Why: understand why the QuickJS CLI REPL showed a prompt but then ignored typed
input.

What was done: traced TTY reads through libuv, native Edge stream wrappers, and
JavaScript stream/readline code; confirmed bytes reached JS; found the REPL was
paused during persistent history initialization; documented `EDGE_TRACE_TTY`
and the temporary `NODE_REPL_HISTORY=""` workaround.

### [dev_004.md](dev_004.md): Edge QuickJS REPL promise hooks and microtasks

Why: fix the missing async continuation that kept REPL history initialization
from completing under QuickJS.

What was done: compared the other promise-hook approach, added QuickJS promise
hook registration in the N-API layer, implemented real QuickJS microtask/job
enqueueing and draining, patched vendored QuickJS to emit before/after promise
hook events around promise reaction jobs, and verified the REPL worked without
disabling history.

### [dev_005.md](dev_005.md): Edge QuickJS WASIX Wasmer run enablement

Why: move from native CLI success to a WASIX package that boots under Wasmer and
can run an HTTP server.

What was done: documented the WASIX build shape and Makefile helpers, enabled
QuickJS atomics under WASIX when wasm atomics are available, diagnosed the HTTP
server hang with `EDGE_TRACE_NET`, fixed stream-base lookup for TCP/Pipe/TTY
wrappers so the HTTP parser attaches to the correct listener, and verified
`wasmer run` can serve the echo server.

### [dev_006.md](dev_006.md): Edge QuickJS web app enablement for Astro, Vite, and Next.js

Why: prove the published Edge QuickJS package can host real framework outputs,
not only small hand-written scripts.

What was done: captured the published package shape
`sadhbh-c0d3/edgejs-quickjs@0.0.1`, documented static HTTP adapter patterns for
Astro and Vite, described the Next.js App Router adapter, dynamic shell
generation, table route fix, `.dist` staging, verification commands, and the
remaining boundaries between static serving and full framework SSR.

### [dev_007.md](dev_007.md): Edge QuickJS framework standalone builds

Why: move Astro, Vite, and Next.js from app-owned router glue toward
framework-standard standalone build outputs.

What was done: documented Astro's standalone Node adapter output, the
`vite-plugin-standalone` path for Vite, and Next.js official standalone output;
reduced the QuickJS Next standalone failure to `require("v8")` and an empty
QuickJS `internalBinding("serdes")`; confirmed the Edge V8 inspector failure was
not a branch regression; and adjusted native builtin failure handling so extra
builtin context is printed without replacing the original JS exception
formatting.

## Current state

The development path now supports:

- native QuickJS-backed Edge CLI bootstrap;
- QuickJS REPL input with history enabled;
- WASIX Edge QuickJS package startup under Wasmer;
- HTTP server request parsing and response writing under Wasmer;
- static Astro and Vite app serving through small CJS adapters;
- Next.js static App Router artifacts plus generated dynamic HTML/RSC shells;
- standard Next.js standalone build layout understood, with the remaining
  QuickJS runtime blocker narrowed to `v8` / `serdes`.

The main unresolved runtime item remains proper QuickJS teardown: `JS_FreeRuntime`
is still disabled in the N-API QuickJS env release path until GC-owned object
lifetime issues are fixed.

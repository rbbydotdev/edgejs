# Edge QuickJS development index

This is the entry point for the QuickJS WASIX development notes. The numbered
phase files record chronological milestones; the troubleshooting notes capture
framework-specific investigations that should be planned before code changes.

## Start Here

- Use the phase index below to recover the development narrative.
- Use [troubleshooting/index.md](troubleshooting/index.md) for active and
  historical Astro SSR, Vite app, and Next app investigations.
- For any new framework troubleshooting issue, create an issue-specific plan in
  the matching troubleshooting subdirectory before changing code.

## Development Phases

### [001_merge_analysis.md](001_merge_analysis.md): QuickJS N-API EdgeJS merge analysis

Why: establish what the other branch had already solved, what belonged in our
cleaner QuickJS N-API implementation, and what EdgeJS integration pieces needed
to be ported.

What was done: compared the two EdgeJS trees and N-API submodules, identified
provider-selection plumbing, WASIX package scaffolding, runtime hooks, symbol
ownership concerns, and the gaps in our QuickJS provider before integration.

### [002_native_bootstrap_contextify.md](002_native_bootstrap_contextify.md): QuickJS N-API EdgeJS execution and bootstrap troubleshooting

Why: get the native QuickJS-backed Edge CLI far enough through Node bootstrap to
run `quickjs-wasm/echo-server.js`.

What was done: added bootstrap and contextify diagnostics, fixed
`ContextifyScript` by defining it as a N-API class, installed Node-required
well-known symbols such as dispose symbols, and verified the HTTP echo server
path worked in the native QuickJS CLI while recording remaining teardown issues.

### [003_repl_tty_readline.md](003_repl_tty_readline.md): Edge QuickJS REPL TTY troubleshooting

Why: understand why the QuickJS CLI REPL showed a prompt but then ignored typed
input.

What was done: traced TTY reads through libuv, native Edge stream wrappers, and
JavaScript stream/readline code; confirmed bytes reached JS; found the REPL was
paused during persistent history initialization; documented `EDGE_TRACE_TTY`
and the temporary `NODE_REPL_HISTORY=""` workaround.

### [004_promise_hooks_microtasks.md](004_promise_hooks_microtasks.md): Edge QuickJS REPL promise hooks and microtasks

Why: fix the missing async continuation that kept REPL history initialization
from completing under QuickJS.

What was done: compared the other promise-hook approach, added QuickJS promise
hook registration in the N-API layer, implemented real QuickJS microtask/job
enqueueing and draining, patched vendored QuickJS to emit before/after promise
hook events around promise reaction jobs, and verified the REPL worked without
disabling history.

### [005_wasix_wasmer_http.md](005_wasix_wasmer_http.md): Edge QuickJS WASIX Wasmer run enablement

Why: move from native CLI success to a WASIX package that boots under Wasmer and
can run an HTTP server.

What was done: documented the WASIX build shape and Makefile helpers, enabled
QuickJS atomics under WASIX when wasm atomics are available, diagnosed the HTTP
server hang with `EDGE_TRACE_NET`, fixed stream-base lookup for TCP/Pipe/TTY
wrappers so the HTTP parser attaches to the correct listener, and verified
`wasmer run` can serve the echo server.

### [006_framework_app_adapters.md](006_framework_app_adapters.md): Edge QuickJS web app enablement for Astro, Vite, and Next.js

Why: prove the published Edge QuickJS package can host real framework outputs,
not only small hand-written scripts.

What was done: captured the published package shape
`sadhbh-c0d3/edgejs-quickjs@0.0.1`, documented static HTTP adapter patterns for
Astro and Vite, described the Next.js App Router adapter, dynamic shell
generation, table route fix, `.dist` staging, verification commands, and the
remaining boundaries between static serving and full framework SSR.

### [007_framework_standalone_builds.md](007_framework_standalone_builds.md): Edge QuickJS framework standalone builds

Why: move Astro, Vite, and Next.js from app-owned router glue toward
framework-standard standalone build outputs.

What was done: documented Astro's standalone Node adapter output, the
`vite-plugin-standalone` path for Vite, and Next.js official standalone output;
reduced the QuickJS Next standalone failure to `require("v8")` and an empty
QuickJS `internalBinding("serdes")`; confirmed the Edge V8 inspector failure was
not a branch regression; and adjusted native builtin failure handling so extra
builtin context is printed without replacing the original JS exception
formatting. Later Astro SSR work also added a deliberately minimal
`Intl.DateTimeFormat` fallback for QuickJS runtimes without a real Intl object,
covering framework bootstrap time formatting without claiming full ECMA-402
support.

## Troubleshooting

### [troubleshooting/index.md](troubleshooting/index.md): framework troubleshooting registry

Why: keep issue-specific Astro SSR, Vite app, and Next app investigations close
to the development timeline while preserving the rule that new issues get a
written action plan before runtime or adapter changes.

What is tracked: Astro SSR ESM dependency compatibility, Vite standalone build
shape, Astro's minimal QuickJS `Intl.DateTimeFormat` fallback, and Next.js
standalone `v8` / `serdes` compatibility.

## Current State

The QuickJS WASIX development path now supports:

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

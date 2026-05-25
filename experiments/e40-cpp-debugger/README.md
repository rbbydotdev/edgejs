# E40 — Chrome DevTools wasm debugging

## Why

e37 + e38 left one unanswered question: WHY does `uv_run(UV_RUN_DEFAULT)`
return when `uv_loop_alive(loop) == 1`?

Printf-style probes hit a wall — we can confirm `uv_run` returns early
but can't easily see WHAT inside `uv_run` decides to return.  C++
source-level debugging with breakpoints is the right tool.

## Prerequisites

- **Chrome 130+ (or recent Chromium)**: built-in DWARF support landed
  in Chrome 88 and has improved steadily.  Latest gives the best
  experience.
- **"C/C++ DevTools Support (DWARF)" extension** (optional but
  recommended): https://chrome.google.com/webstore/detail/cc++-devtools-support-dwa/pdcpmagijalfljmkmjngeonclgbbannb
  - Improves source path resolution and provides better local-disk
    source lookups.
  - After install, DevTools → Sources → Filesystem → Add folder →
    point at this repo's root.

## Setup (one-time)

```sh
# Build the debug wasm.  ~5 min, ~150 MB output (vs ~25 MB prod).
cd /Users/robertpolana/etc/projects/edgejs
EDGE_DEBUG_BUILD=1 SKIP_DEPS_UPDATE=1 ./wasix/build-wasix.sh
# Should print: "Deployed DEBUG build to .../browser-target/edgejs-debug.wasm"
```

## Run a debug session

```sh
cd /Users/robertpolana/etc/projects/edgejs/browser-target
# Pick or write a small test that triggers the bug you want to study.
# For the e37 keepalive-alone scenario, use:
node scripts/debug-runner.mjs ../experiments/e40-cpp-debugger/test-uvrun-block.js
# The runner prints a URL.  Open it in Chrome.  Ctrl+C the runner when
# done — it restores the production wasm.
```

## Investigation playbook for the open question (uv_run early-return)

After opening the URL in Chrome and DevTools:

1. **Sources panel** → expand the `edgejs.wasm` entry.  With DWARF
   loaded, you'll see a directory tree mirroring the C++ source layout:
   ```
   edgejs.wasm
   ├── deps/libuv-wasix/src/unix/
   │   ├── core.c
   │   ├── async.c
   │   ├── posix-poll.c
   │   └── ...
   ├── src/
   │   ├── edge_runtime.cc
   │   └── ...
   ```

2. **Set breakpoints** in `deps/libuv-wasix/src/unix/core.c`:
   - Inside `uv_run`, on the `while (r != 0 && loop->stop_flag == 0)` check
   - On the `uv__io_poll(loop, timeout)` call
   - On the `r = uv__loop_alive(loop)` reassignment at the end of the loop
   - Right before each `return r;`

3. **Set a conditional breakpoint** in
   `src/edge_runtime.cc:RunEventLoopUntilQuiescent` on
   `uv_run(loop, UV_RUN_DEFAULT)` — this is where the call originates.

4. **Reload the page (Cmd+R)** — breakpoint fires.  Walk through.

5. **At each iteration**, in the Scope panel:
   - `loop->active_handles` — should be > 0 (our keepalive)
   - `loop->active_reqs.count` — likely 0
   - `loop->pending_queue` — check head ptr
   - `loop->idle_handles` — check head ptr
   - `loop->closing_handles` — check
   - `loop->stop_flag` — check
   - `timeout` (local var passed to uv__io_poll) — what value?
   - `r` after uv__loop_alive call — what value?

6. **The key question**: at the iteration where `uv_run` decides to
   return, what's the state of the condition `r != 0 && loop->stop_flag == 0`?
   - If r=0 here: `uv__loop_alive` returned 0 — somehow our keepalive
     isn't being counted at this moment.  Inspect why (active_handles
     count, our handle's flags).
   - If r=1 but stop_flag != 0: something set stop_flag.  Walk up the
     call stack to find what.

7. **Step into `uv__io_poll`** when called.  See what `timeout` value
   it receives and what `poll()` actually returns.

## Test file used in this investigation

See `test-uvrun-block.js` in this directory.  It's a minimal
reproduction: only `console.log()` in the user script, no timers.
The keepalive must be installed via the test runner pre-`_start`
patch (which the debug runner doesn't do — TODO: extend debug-runner
to support pre-start probe injection like e37 did, OR add a
wasm-import-side keepalive trigger).

For now, easier path: run the existing `e34-keepalive-no-heartbeat`
test through the debug runner — it triggers the actual policy
keepalive in a real new Worker scenario.

```sh
node scripts/debug-runner.mjs ../tests/js/worker-threads-spawn-exit.js
```

(Or whatever test reliably reproduces the bug you want to study.)

## When you're done

`Ctrl+C` the debug-runner.  It restores `edgejs.wasm` to the
production build by `cp`'ing back the backup.

## Documenting findings

After the session, write your findings to a `FINDINGS.md` in this
directory.  Include:
- The specific line in `uv_run` where it decided to return
- The state of `loop->active_handles`, `stop_flag`, etc. at that moment
- Call stack — what called uv_run that returned
- Next step (further probe, or a proposed fix)

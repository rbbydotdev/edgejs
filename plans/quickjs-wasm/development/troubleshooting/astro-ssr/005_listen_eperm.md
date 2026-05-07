# Astro SSR: Listen EPERM On Localhost

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Resolved as sandbox bind policy, not a QuickJS runtime bug. |
| **Severity** | Low | The server works when localhost binding is allowed; this is a local verification constraint. |

## Issue

After the minimal `Intl.DateTimeFormat` fallback, the Astro standalone SSR entry
for `stackmachine.com` advances past module evaluation and reaches server
startup:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Observed output:

```text
(node:91514) [DEP0093] DeprecationWarning: The crypto.fips is deprecated. Please use crypto.getFips()
(node:91514) [DEP0176] DeprecationWarning: fs.F_OK is deprecated, use fs.constants.F_OK instead
13:03:14 [ERROR] [@astrojs/node] Unhandled rejection while rendering undefined
Error: listen EPERM: operation not permitted ::1:4321
    at UVExceptionWithHostPort (<input>:704:5)
    at setupListenHandle (<input>:1920:25)
    at listenInCluster (<input>:1999:21)
    at <input>:2208:23
    at onlookupall (<input>:136:17) {
  code: 'EPERM',
  errno: -1,
  syscall: 'listen',
  address: '::1',
  port: 4321
}
```

The process exited with status 0 in this sandboxed run despite logging the
unhandled rejection.

## Diagnosis

This is separate from the `Intl` issue. The logger timestamp is formatted, so
the Astro adapter has advanced to the server listen path. The failing address is
IPv6 localhost (`::1`) on port `4321`.

Focused `node:net` bind checks show this is caused by the current sandbox
disallowing local socket binds, not by QuickJS TCP/listen behavior or Astro's
default host/port selection.

Under normal sandboxed execution, native QuickJS Edge fails to listen on all
tested TCP server addresses:

```text
127.0.0.1 ephemeral port -> error EPERM -1 listen 127.0.0.1 undefined
::1 ephemeral port       -> error EPERM -1 listen ::1 undefined
unspecified ephemeral    -> error EPERM -1 listen 0.0.0.0 undefined
```

With the same QuickJS Edge binary allowed to run outside the sandbox, the same
checks succeed:

```text
127.0.0.1 ephemeral port -> listening 127.0.0.1 IPv4 <port>; closed
::1 ephemeral port       -> listening ::1 IPv6 <port>; closed
unspecified ephemeral    -> listening :: IPv6 <port>; closed
```

The available V8-backed Edge binary shows the same pattern: sandboxed
`127.0.0.1` and `::1` binds fail with `EPERM`, while both succeed outside the
sandbox. That comparison rules out a QuickJS-specific TCP bind regression.

## Plan

Investigate with the narrowest server-listen repro before changing runtime code:

- [x] run a tiny `node:net` server under native QuickJS Edge on `127.0.0.1`,
  `::1`, and an ephemeral port;
- [x] compare the same repro under native V8 EdgeJS if available;
- [x] rerun the Astro entry outside the sandbox to verify it reaches listen;
- [x] only change Edge TCP/listen behavior if the focused repro shows a runtime
  bug rather than sandbox policy or application configuration.

No runtime code change is needed for this issue.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep the investigation focused on listen/bind behavior, not warnings from
  `crypto.fips` or `fs.F_OK`.
- If a command fails due to sandboxed network permissions, rerun the important
  repro with explicit escalation instead of inferring a runtime bug.

## Validation

Focused local listen check:

```sh
~/src/dev/edgejs/build-edge-quickjs-cli/edge \
  -e "const net=require('node:net'); const s=net.createServer(); s.listen(0, '127.0.0.1', () => { console.log('listening', s.address().port); s.close(); });"
```

Then rerun the Astro SSR entry:

```sh
cd ~/src/dev/stackmachine.com
~/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
```

Expected result for this issue: the Astro standalone server can bind or the
failure is clearly attributed to sandbox permissions/app configuration rather
than QuickJS runtime behavior.

Observed validation:

```text
sandboxed Astro entry:
  Error: listen EPERM: operation not permitted ::1:4321

escalated Astro entry:
  [@astrojs/node] Server listening on http://localhost:4321
```

Decision: treat `listen EPERM` as sandbox policy in the current Codex execution
environment. Continue Astro SSR compatibility work from the server-listening
state by running the entry with local bind permission when server startup is the
behavior under test.

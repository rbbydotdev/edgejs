# Astro SSR: Route Stack Overflow

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed with a larger QuickJS runtime stack guard. |
| **Severity** | High | The Astro route streamed a partial response and failed without the larger stack guard. |

## Issue

After the `@use-gesture/core` package export condition fix, the Astro SSR
server on `stackmachine.com` starts and the `/` route advances to a runtime
failure:

```text
13:31:35 [ERROR] [router] Error while trying to render the route /
13:31:35 [ERROR] Maximum call stack size exceeded
```

Focused route validation was run against temporary servers on ports `4322` and
`4323` because port `4321` was already occupied by another server instance.

## Diagnosis

This is separate from the previous module linking failures: route rendering got
past the missing named/default exports and reached an actual runtime stack
overflow.

The first focused reproduction showed that importing the page module failed
before rendering:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge -e "import('./dist/server/pages/index.astro.mjs')"
```

The failure narrowed to the page's `stackmachine` dependency. That package
loads `relay-runtime`, whose large CommonJS dependency graph exceeded
QuickJS's default 1 MiB stack guard during module evaluation.

Raising the guard to 2 MiB fixed `relay-runtime`, `stackmachine`, and the page
module import, but the full Astro render still overflowed in the middle of the
HTML stream. Raising the Edge-created QuickJS runtime guard to 4 MiB allowed
the full route render to complete.

This is not an infinite recursion in the app or in package resolution. It is a
compatibility difference between the default QuickJS stack guard and the depth
of modern framework/package evaluation plus React SSR rendering.

## Plan

The runtime fix is intentionally narrow:

- keep the stack guard enabled;
- increase the default stack size only for Edge-created QuickJS environments;
- do not modify the Astro app, generated `dist`, or `node_modules`;
- keep the package-resolution fixes from previous notes unchanged.

Implemented in:

```text
napi/quickjs/src/unofficial_napi.cc
```

The default Edge QuickJS stack guard is now `4 * 1024 * 1024` bytes.

## Constraints

- Do not modify the Astro app, `node_modules`, or generated `dist` files.
- Keep any fix in EdgeJS/QuickJS runtime code if a runtime fix is required.
- Fix one behavior at a time and rerun the focused reproduction before
  rerendering the full Astro route.

## Validation

Focused checks after the fix:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge -e "const r=require('relay-runtime'); console.log('require relay', Object.keys(r).length)"
```

Result:

```text
require relay 93
```

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge -e "import('relay-runtime').then(m=>console.log('import relay', Object.keys(m).length))"
```

Result:

```text
import relay 104
```

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge -e "import('stackmachine').then(m=>console.log('stackmachine', Object.keys(m).join(',')))"
```

Result:

```text
stackmachine StackMachine,createZip
```

```sh
/Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge -e "import('./dist/server/pages/index.astro.mjs').then(m=>console.log('page', Object.keys(m).join(',')))"
```

Result:

```text
page page,renderers
```

Then rerun the server and request `/`:

```sh
cd /Users/sadhbh/src/dev/stackmachine.com
PORT=4323 /Users/sadhbh/src/dev/edgejs/build-edge-quickjs-cli/edge ./dist/server/entry.mjs
curl -i http://localhost:4323/
```

Result:

```text
HTTP/1.1 200 OK
content-type: text/html
...
<!DOCTYPE html><html lang="en">
```

The response completed successfully and the server emitted no follow-up render
error.

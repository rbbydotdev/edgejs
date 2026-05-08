# Compatibility Adapter: Blunt QuickJS stack guard increase

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Open cleanup issue. |
| **Severity** | Medium | Avoids overflows without explaining the call depth. |

Implementation note: the QuickJS Node compatibility adapter code described here has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern.

## Source Notes

- `plans/quickjs-wasm/development/troubleshooting/astro-ssr/011_route_stack_overflow.md`
- `plans/quickjs-wasm/development/troubleshooting/next-app/003_route_stack_exhausted.md`

## What Is The Compatibility Adapter

Edge-created QuickJS runtimes use a larger stack guard. Astro validation showed
that 4 MiB allowed a route render that overflowed at the default.

## Why It Is Suspect

More stack can be reasonable, but it does not reveal whether the depth comes
from normal framework recursion, inefficient CJS facade evaluation, resolver
recursion, React rendering, or QuickJS stack accounting.

## How To Do It Better

Instrument stack depth around module loading, CJS facade evaluation, HTTP
dispatch, and framework rendering. Remove accidental recursion before raising
limits. Make native and WASIX defaults explicit and justified by measured
workloads.

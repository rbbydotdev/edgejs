# Node Compatibility Troubleshooting

| | | Remarks |
| --- | --- | --- |
| **Status** | ▶️ | Node compatibility known-issue registry. |
| **Severity** | Low | Documentation registry only; individual issue pages carry runtime severity. |

This directory is the known-issue registry for Node compatibility in the
QuickJS WASIX work. It does not describe a C++ compatibility layer. Each page
records the current incompatibility, status, and ownership boundary.

Some issues are intentionally accepted for now because the QuickJS N-API backend
is not trying to be a full Node runtime. Others are active work items for
EdgeJS bootstrap/runtime code, deployment tooling, or focused QuickJS N-API
internals.

## Areas

- [N-API known issues](napi/index.md): QuickJS N-API behavior, intentional
  non-Node behavior, and focused internal subsystems under `napi/quickjs/src/internal`.
- [EdgeJS runtime](edgejs/index.md): work that belongs in EdgeJS runtime source
  or JavaScript bootstrap code under `src/` and `lib/`.
- [Deploy and packaging](deploy/index.md): build, packaging, npm graph, and
  deployment issues.

## Current Status

The cleanup direction is to keep QuickJS N-API small and explicit, keep real
Node-runtime behavior in EdgeJS itself when it is required, and route module
loading through Node's JavaScript loaders/translators instead of rebuilding
Node's loader policy in C++.

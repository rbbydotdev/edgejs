# Node Compatibility Troubleshooting

This directory is the compatibility-adaptation registry for the QuickJS WASIX work. The old flat compatibility notes have been sorted by implementation home so a future reader can jump from documentation to code without guessing where the behavior lives.

The N-API QuickJS compatibility adapter code has been extracted into `napi/quickjs/src/compat`, with separate source/header pairs by concern. The per-pair rationale articles are in [napi](napi/index.md).

## Areas

- [N-API adapters](napi/index.md): behavior implemented under `napi/quickjs/src/compat` or closely tied to the QuickJS N-API runtime.
- [EdgeJS runtime](edgejs/index.md): behavior implemented under `src/`.
- [Deploy and packaging](deploy/index.md): build, packaging, npm graph, and deployment adaptations.

## Current Focus

The main cleanup direction is to keep compatibility behavior organized by concern, route module loading through Node's JavaScript loaders/translators where possible, and avoid reintroducing broad runtime patches when a focused adapter or proper Node-compatible implementation is available.

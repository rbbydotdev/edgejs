# EdgeJS Runtime Node Compatibility

These notes track Node compatibility adaptations implemented in EdgeJS runtime source under `src/`. The N-API-specific adapter code from the same cleanup effort has been extracted into `napi/quickjs/src/compat` and is documented separately in [../napi](../napi/index.md).

- [Minimal Intl fallback](003_minimal_intl_fallback.md)
- [Native inspector stub](004_native_inspector_stub.md)
- [Stream wrapper unwrap fallback](010_stream_wrapper_unwrap_fallback.md)

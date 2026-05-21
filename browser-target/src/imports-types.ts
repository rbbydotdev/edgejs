// Shape of optional host overrides supplied to the generated `buildImports`.
// Any function placed at overrides[ns][symbol] replaces the default
// stub for that import.  Missing entries fall back to the namespace's
// default-return stub.

export type HostOverrides = {
  napi?: Record<string, Function>;
  napi_extension_wasmer_v0?: Record<string, Function>;
  wasi_snapshot_preview1?: Record<string, Function>;
  wasix_32v1?: Record<string, Function>;
  env?: Record<string, Function>;
  wasi?: Record<string, Function>;
};

export type TraceRecorder = (
  ns: string,
  sym: string,
  args: unknown[],
  ret: unknown,
  wasStub: boolean,
) => void;

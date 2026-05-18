# `quickjs::detail::napi_module_wrap__`

Status: Current as of 2026-05-15.

`napi_module_wrap__` is the QuickJS-backed implementation of the unofficial
module-wrap surface.

It lives in `napi/quickjs/src/internal/napi_module_wrap.h` and `.cc` under the
`quickjs::detail` namespace. `napi_env__` owns one instance and exposes it
through `env->module_wrap()`.

The class installs QuickJS runtime callbacks for import-meta initialization and
dynamic import. It stores optional JavaScript callbacks for both host hooks and
keeps vectors of module records plus script-referrer metadata.

Each internal `record` tracks one source or synthetic module: the `JSModuleDef`,
module value, wrapper value, host-defined option ID, synthetic eval function,
source object, import requests, linked records, and duplicated linked module
values. The public handle returned by create calls is an opaque pointer to one
of these records.

Source-text modules cache their import requests from QuickJS module metadata.
Synthetic modules call back into JavaScript during initialization and support
setting exports. Evaluation, namespace lookup, status/error reporting,
top-level-await checks, cached-data creation, and CommonJS facade creation are
adapted to the parts QuickJS can provide.

`teardown()` unregisters QuickJS host hooks, frees every active record, releases
script-referrer metadata, and frees stored callback values.

# `napi_buffer_record__`

`napi_buffer_record__` tracks external Buffer and ArrayBuffer backing-store
state that must be finalized with the env.

It is currently defined in `napi/v8/src/js_native_api_v8.cc`. The record stores
the env, a persistent holder object, the `std::shared_ptr<v8::BackingStore>`,
the external data pointer, optional finalizer callback and hint, and a
`finalized` flag.

The env owns a list of these records. During env teardown,
`napi_v8_finalize_buffer_records(...)` finalizes any unfinalized record, resets
the holder global, and clears the env-owned `std::unique_ptr` list. When V8
collects a buffer holder first, the weak callback moves the record out of the
env list and schedules the finalizer microtask with explicit one-shot
ownership.

The lifetime tracker records create/release counts for this struct so buffer
backing-store retention shows up in teardown diagnostics.

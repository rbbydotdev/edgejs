# N-API V8 Classes

This directory documents the small internal classes and opaque structs used by
the V8-backed N-API implementation.

The main design rule is that V8 already owns the local-handle machinery:
`napi_value` is a direct current-scope V8 local handle, while `napi_ref__` and
its subclasses are the persistent storage path. These notes should be read with
that split in mind.

## Core Environment And Values

- [napi_env](napi_env.md)
- [napi_callback_info](napi_callback_info.md)
- [napi_value](napi_value.md)

## Callback Adapters

- [napi_callback_payload](napi_callback_payload.md)
- [napi_accessor_payload](napi_accessor_payload.md)
- [napi_function_callback_info](napi_function_callback_info.md)
- [napi_getter_callback_info](napi_getter_callback_info.md)
- [napi_setter_callback_info](napi_setter_callback_info.md)

## References And Finalizers

- [napi_ref_tracker](napi_ref_tracker.md)
- [napi_ref](napi_ref.md)
- [napi_ref_with_data](napi_ref_with_data.md)
- [napi_ref_with_finalizer](napi_ref_with_finalizer.md)
- [napi_ref_ownership](napi_ref_ownership.md)

## Scopes

- [napi_handle_scope](napi_handle_scope.md)
- [napi_escapable_handle_scope](napi_escapable_handle_scope.md)
- [napi_handle_scope_wrapper](napi_handle_scope_wrapper.md)
- [napi_escapable_handle_scope_wrapper](napi_escapable_handle_scope_wrapper.md)

## Externals And Buffers

- [napi_external_wrapper](napi_external_wrapper.md)
- [napi_buffer_record](napi_buffer_record.md)
- [napi_external_backing_store_hint](napi_external_backing_store_hint.md)

## Async, Promises, And Cleanup

- [napi_deferred](napi_deferred.md)
- [napi_env_cleanup_hook](napi_env_cleanup_hook.md)

## Diagnostics

- [napi_lifetime_tracker](napi_lifetime_tracker.md)
- [napi_lifetime](napi_lifetime.md)
- [napi_lifetime_type_name](napi_lifetime_type_name.md)

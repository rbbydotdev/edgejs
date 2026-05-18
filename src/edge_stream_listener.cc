#include "edge_stream_listener.h"

#include "edge_handle_scope.h"
#include "edge_trace.h"

#include <cstdio>
#include <cstdlib>

namespace {

bool TraceNetEnabled() {
  return EDGE_TRACE_ENABLED("EDGE_TRACE_NET");
}

napi_env FindListenerEnv(EdgeStreamListener* listener) {
  for (EdgeStreamListener* current = listener;
       current != nullptr;
       current = current->previous) {
    if (current->env != nullptr) return current->env;
  }
  return nullptr;
}

napi_env FindStateEnv(EdgeStreamListenerState* state) {
  if (state == nullptr) return nullptr;
  if (state->env != nullptr) return state->env;
  return FindListenerEnv(state->current);
}

bool ScopedOnAlloc(napi_env env,
                   EdgeStreamListener* listener,
                   size_t suggested_size,
                   uv_buf_t* out) {
  if (env == nullptr) return false;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return false;
  return listener->on_alloc(listener, suggested_size, out);
}

bool ScopedOnRead(napi_env env,
                  EdgeStreamListener* listener,
                  ssize_t nread,
                  const uv_buf_t* buf) {
  if (env == nullptr) return false;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return false;
  return listener->on_read(listener, nread, buf);
}

bool ScopedOnAfterWrite(napi_env env,
                        EdgeStreamListener* listener,
                        napi_value req_obj,
                        int status) {
  if (env == nullptr) return false;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return false;
  return listener->on_after_write(listener, req_obj, status);
}

bool ScopedOnAfterShutdown(napi_env env,
                           EdgeStreamListener* listener,
                           napi_value req_obj,
                           int status) {
  if (env == nullptr) return false;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return false;
  return listener->on_after_shutdown(listener, req_obj, status);
}

bool ScopedOnWantsWrite(napi_env env,
                        EdgeStreamListener* listener,
                        size_t suggested_size) {
  if (env == nullptr) return false;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return false;
  return listener->on_wants_write(listener, suggested_size);
}

void ScopedOnClose(napi_env env, EdgeStreamListener* listener) {
  if (env == nullptr) return;
  edge::HandleScope scope(env);
  if (!scope.is_open()) return;
  listener->on_close(listener);
}

}

void EdgeInitStreamListenerState(EdgeStreamListenerState* state,
                                EdgeStreamListener* initial) {
  if (state == nullptr) return;
  state->current = nullptr;
  state->env = initial != nullptr ? initial->env : nullptr;
  if (initial == nullptr) return;
  initial->previous = nullptr;
  state->current = initial;
}

void EdgePushStreamListener(EdgeStreamListenerState* state,
                           EdgeStreamListener* listener) {
  if (state == nullptr || listener == nullptr) return;
  if (state->current == listener) return;
  if (listener->env == nullptr) listener->env = FindStateEnv(state);
  if (state->env == nullptr) state->env = listener->env;
  listener->previous = state->current;
  state->current = listener;
}

bool EdgeRemoveStreamListener(EdgeStreamListenerState* state,
                             EdgeStreamListener* listener) {
  if (state == nullptr || listener == nullptr) return false;

  EdgeStreamListener* previous = nullptr;
  EdgeStreamListener* current = state->current;
  while (current != nullptr) {
    if (current == listener) {
      if (previous == nullptr) {
        state->current = current->previous;
      } else {
        previous->previous = current->previous;
      }
      current->previous = nullptr;
      return true;
    }
    previous = current;
    current = current->previous;
  }

  return false;
}

bool EdgeStreamEmitAlloc(EdgeStreamListenerState* state,
                        size_t suggested_size,
                        uv_buf_t* out) {
  if (state == nullptr || out == nullptr) return false;
  napi_env env = FindStateEnv(state);

  for (EdgeStreamListener* listener = state->current;
       listener != nullptr;
       listener = listener->previous) {
    if (listener->on_alloc == nullptr) continue;
    if (TraceNetEnabled()) {
      std::fprintf(stderr,
                   "EDGE_TRACE_NET listener alloc_try listener=%p on_alloc=%p on_read=%p previous=%p suggested=%zu\n",
                   static_cast<void*>(listener),
                   reinterpret_cast<void*>(listener->on_alloc),
                   reinterpret_cast<void*>(listener->on_read),
                   static_cast<void*>(listener->previous),
                   suggested_size);
    }
    bool handled = ScopedOnAlloc(listener->env != nullptr ? listener->env : env,
                                 listener,
                                 suggested_size,
                                 out);
    if (TraceNetEnabled()) {
      std::fprintf(stderr,
                   "EDGE_TRACE_NET listener alloc_done listener=%p handled=%d buf=%p len=%zu\n",
                   static_cast<void*>(listener),
                   handled,
                   handled ? static_cast<void*>(out->base) : nullptr,
                   handled ? static_cast<size_t>(out->len) : 0);
    }
    if (handled) return true;
  }

  return false;
}

bool EdgeStreamEmitRead(EdgeStreamListenerState* state,
                       ssize_t nread,
                       const uv_buf_t* buf) {
  if (state == nullptr) return false;
  napi_env env = FindStateEnv(state);

  const uv_buf_t empty = uv_buf_init(nullptr, 0);
  const uv_buf_t* current_buf = buf;
  if (current_buf == nullptr) current_buf = &empty;

  for (EdgeStreamListener* listener = state->current;
       listener != nullptr;
       listener = listener->previous) {
    if (listener->on_read == nullptr) continue;
    if (TraceNetEnabled()) {
      std::fprintf(stderr,
                   "EDGE_TRACE_NET listener read_try listener=%p on_read=%p previous=%p nread=%zd buf=%p len=%zu\n",
                   static_cast<void*>(listener),
                   reinterpret_cast<void*>(listener->on_read),
                   static_cast<void*>(listener->previous),
                   nread,
                   current_buf != nullptr ? static_cast<void*>(current_buf->base) : nullptr,
                   current_buf != nullptr ? static_cast<size_t>(current_buf->len) : 0);
    }
    bool handled = ScopedOnRead(listener->env != nullptr ? listener->env : env,
                                listener,
                                nread,
                                current_buf);
    if (TraceNetEnabled()) {
      std::fprintf(stderr,
                   "EDGE_TRACE_NET listener read_done listener=%p handled=%d nread=%zd\n",
                   static_cast<void*>(listener),
                   handled,
                   nread);
    }
    if (handled) return true;
    if (nread < 0) current_buf = &empty;
  }

  return false;
}

namespace {

bool EmitAfterWriteFrom(EdgeStreamListener* listener,
                        napi_env fallback_env,
                        napi_value req_obj,
                        int status) {
  napi_env env = fallback_env != nullptr ? fallback_env : FindListenerEnv(listener);
  for (; listener != nullptr; listener = listener->previous) {
    if (listener->on_after_write == nullptr) continue;
    if (ScopedOnAfterWrite(listener->env != nullptr ? listener->env : env,
                           listener,
                           req_obj,
                           status)) {
      return true;
    }
  }
  return false;
}

bool EmitAfterShutdownFrom(EdgeStreamListener* listener,
                           napi_env fallback_env,
                           napi_value req_obj,
                           int status) {
  napi_env env = fallback_env != nullptr ? fallback_env : FindListenerEnv(listener);
  for (; listener != nullptr; listener = listener->previous) {
    if (listener->on_after_shutdown == nullptr) continue;
    if (ScopedOnAfterShutdown(listener->env != nullptr ? listener->env : env,
                              listener,
                              req_obj,
                              status)) {
      return true;
    }
  }
  return false;
}

bool EmitWantsWriteFrom(EdgeStreamListener* listener,
                        napi_env fallback_env,
                        size_t suggested_size) {
  napi_env env = fallback_env != nullptr ? fallback_env : FindListenerEnv(listener);
  for (; listener != nullptr; listener = listener->previous) {
    if (listener->on_wants_write == nullptr) continue;
    if (ScopedOnWantsWrite(listener->env != nullptr ? listener->env : env,
                           listener,
                           suggested_size)) {
      return true;
    }
  }
  return false;
}

}  // namespace

bool EdgeStreamEmitAfterWrite(EdgeStreamListenerState* state,
                             napi_value req_obj,
                             int status) {
  if (state == nullptr) return false;
  return EmitAfterWriteFrom(state->current, FindStateEnv(state), req_obj, status);
}

bool EdgeStreamEmitAfterShutdown(EdgeStreamListenerState* state,
                                napi_value req_obj,
                                int status) {
  if (state == nullptr) return false;
  return EmitAfterShutdownFrom(state->current, FindStateEnv(state), req_obj, status);
}

bool EdgeStreamEmitWantsWrite(EdgeStreamListenerState* state, size_t suggested_size) {
  if (state == nullptr) return false;
  return EmitWantsWriteFrom(state->current, FindStateEnv(state), suggested_size);
}

bool EdgeStreamPassAfterWrite(EdgeStreamListener* listener,
                             napi_value req_obj,
                             int status) {
  return EmitAfterWriteFrom(listener != nullptr ? listener->previous : nullptr,
                            listener != nullptr ? listener->env : nullptr,
                            req_obj,
                            status);
}

bool EdgeStreamPassAfterShutdown(EdgeStreamListener* listener,
                                napi_value req_obj,
                                int status) {
  return EmitAfterShutdownFrom(listener != nullptr ? listener->previous : nullptr,
                               listener != nullptr ? listener->env : nullptr,
                               req_obj,
                               status);
}

bool EdgeStreamPassWantsWrite(EdgeStreamListener* listener, size_t suggested_size) {
  return EmitWantsWriteFrom(listener != nullptr ? listener->previous : nullptr,
                            listener != nullptr ? listener->env : nullptr,
                            suggested_size);
}

void EdgeStreamNotifyClosed(EdgeStreamListenerState* state) {
  if (state == nullptr) return;
  EdgeStreamListener* listener = state->current;
  napi_env env = FindStateEnv(state);
  state->current = nullptr;
  while (listener != nullptr) {
    EdgeStreamListener* next = listener->previous;
    if (listener->on_close != nullptr) {
      ScopedOnClose(listener->env != nullptr ? listener->env : env, listener);
    }
    listener->previous = nullptr;
    listener = next;
  }
}

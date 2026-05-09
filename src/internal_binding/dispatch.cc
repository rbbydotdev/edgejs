#include "internal_binding/dispatch.h"

#include <array>
#include <string_view>

#include "internal_binding/helpers.h"

namespace internal_binding {

napi_value ResolveAsyncWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveAsyncContextFrame(napi_env env, const ResolveOptions& options);
napi_value ResolveBlockList(napi_env env, const ResolveOptions& options);
napi_value ResolveBlob(napi_env env, const ResolveOptions& options);
napi_value ResolveBuffer(napi_env env, const ResolveOptions& options);
napi_value ResolveBuiltins(napi_env env, const ResolveOptions& options);
napi_value ResolveCaresWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveConfig(napi_env env, const ResolveOptions& options);
napi_value ResolveConstants(napi_env env, const ResolveOptions& options);
napi_value ResolveContextify(napi_env env, const ResolveOptions& options);
napi_value ResolveCredentials(napi_env env, const ResolveOptions& options);
napi_value ResolveCrypto(napi_env env, const ResolveOptions& options);
napi_value ResolveEncodingBinding(napi_env env, const ResolveOptions& options);
napi_value ResolveErrors(napi_env env, const ResolveOptions& options);
napi_value ResolveFsEventWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveFs(napi_env env, const ResolveOptions& options);
napi_value ResolveFsDir(napi_env env, const ResolveOptions& options);
napi_value ResolveHeapUtils(napi_env env, const ResolveOptions& options);
napi_value ResolveHttp2(napi_env env, const ResolveOptions& options);
napi_value ResolveHttpParser(napi_env env, const ResolveOptions& options);
napi_value ResolveIcu(napi_env env, const ResolveOptions& options);
napi_value ResolveInspector(napi_env env, const ResolveOptions& options);
napi_value ResolveJsUdpWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveJsStream(napi_env env, const ResolveOptions& options);
napi_value ResolveInternalOnlyV8(napi_env env, const ResolveOptions& options);
napi_value ResolveModuleWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveModules(napi_env env, const ResolveOptions& options);
napi_value ResolveMksnapshot(napi_env env, const ResolveOptions& options);
napi_value ResolveMessaging(napi_env env, const ResolveOptions& options);
napi_value ResolveOptionsBinding(napi_env env, const ResolveOptions& options);
napi_value ResolveOs(napi_env env, const ResolveOptions& options);
napi_value ResolvePerformance(napi_env env, const ResolveOptions& options);
napi_value ResolvePermission(napi_env env, const ResolveOptions& options);
napi_value ResolvePipeWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveProcessMethods(napi_env env, const ResolveOptions& options);
napi_value ResolveProcessWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveReport(napi_env env, const ResolveOptions& options);
napi_value ResolveSea(napi_env env, const ResolveOptions& options);
napi_value ResolveSignalWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveSerdes(napi_env env, const ResolveOptions& options);
napi_value ResolveSpawnSync(napi_env env, const ResolveOptions& options);
napi_value ResolveStreamPipe(napi_env env, const ResolveOptions& options);
napi_value ResolveStreamWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveStringDecoder(napi_env env, const ResolveOptions& options);
napi_value ResolveSymbols(napi_env env, const ResolveOptions& options);
napi_value ResolveTaskQueue(napi_env env, const ResolveOptions& options);
napi_value ResolveTcpWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveTlsWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveTimers(napi_env env, const ResolveOptions& options);
napi_value ResolveTraceEvents(napi_env env, const ResolveOptions& options);
napi_value ResolveTtyWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveTypes(napi_env env, const ResolveOptions& options);
napi_value ResolveUdpWrap(napi_env env, const ResolveOptions& options);
napi_value ResolveUrl(napi_env env, const ResolveOptions& options);
napi_value ResolveUrlPattern(napi_env env, const ResolveOptions& options);
napi_value ResolveUtil(napi_env env, const ResolveOptions& options);
napi_value ResolveV8(napi_env env, const ResolveOptions& options);
napi_value ResolveUv(napi_env env, const ResolveOptions& options);
napi_value ResolveWatchdog(napi_env env, const ResolveOptions& options);
napi_value ResolveWasmWebApi(napi_env env, const ResolveOptions& options);
napi_value ResolveWorker(napi_env env, const ResolveOptions& options);
napi_value ResolveZlib(napi_env env, const ResolveOptions& options);

namespace {

using ResolverFn = napi_value (*)(napi_env env, const ResolveOptions& options);

struct BindingResolverEntry {
  std::string_view name;
  ResolverFn resolver;
};

void DefineMethod(napi_env env, napi_value obj, const char* name, napi_callback cb) {
  napi_value fn = nullptr;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn) == napi_ok && fn != nullptr) {
    napi_set_named_property(env, obj, name, fn);
  }
}

napi_value InspectorUnavailable(napi_env env, napi_callback_info /*info*/) {
  napi_throw_error(env, "ERR_INSPECTOR_NOT_AVAILABLE", "Inspector is not available in this EdgeJS build");
  return Undefined(env);
}

napi_value InspectorNotConnected(napi_env env, napi_callback_info /*info*/) {
  napi_throw_error(env, "ERR_INSPECTOR_NOT_CONNECTED", "Inspector session is not connected");
  return Undefined(env);
}

napi_value ReturnUndefined(napi_env env, napi_callback_info /*info*/) {
  return Undefined(env);
}

napi_value ReturnThis(napi_env env, napi_callback_info info) {
  napi_value receiver = nullptr;
  if (napi_get_cb_info(env, info, nullptr, nullptr, &receiver, nullptr) != napi_ok ||
      receiver == nullptr) {
    return Undefined(env);
  }
  return receiver;
}

napi_value ReturnFalse(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  napi_get_boolean(env, false, &out);
  return out != nullptr ? out : Undefined(env);
}

napi_value ReturnZero(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  napi_create_uint32(env, 0, &out);
  return out != nullptr ? out : Undefined(env);
}

napi_value ReturnEmptyArray(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  napi_create_array(env, &out);
  return out != nullptr ? out : Undefined(env);
}

napi_value InspectorIsEnabled(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  napi_get_boolean(env, false, &out);
  return out != nullptr ? out : Undefined(env);
}

napi_value InspectorUrl(napi_env env, napi_callback_info /*info*/) {
  return Undefined(env);
}

napi_value InspectorEmitProtocolEvent(napi_env env, napi_callback_info /*info*/) {
  return Undefined(env);
}

napi_value InspectorConnectionConstructor(napi_env env, napi_callback_info /*info*/) {
  napi_throw_error(env, "ERR_INSPECTOR_NOT_AVAILABLE", "Inspector sessions are not available in this EdgeJS build");
  return nullptr;
}

napi_value DefineClass(napi_env env,
                       const char* name,
                       napi_callback constructor,
                       const napi_property_descriptor* properties,
                       size_t property_count) {
  napi_value cls = nullptr;
  if (napi_define_class(env,
                        name,
                        NAPI_AUTO_LENGTH,
                        constructor,
                        nullptr,
                        property_count,
                        properties,
                        &cls) != napi_ok ||
      cls == nullptr) {
    return nullptr;
  }
  return cls;
}

napi_value DefineInspectorConnection(napi_env env, const char* name) {
  return DefineClass(env, name, InspectorConnectionConstructor, nullptr, 0);
}

napi_value DefineInspectorSession(napi_env env) {
  napi_property_descriptor methods[] = {
      {"connect", nullptr, InspectorUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"connectToMainThread", nullptr, InspectorUnavailable, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"post", nullptr, InspectorNotConnected, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"disconnect", nullptr, ReturnUndefined, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"addListener", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"on", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"once", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"prependListener", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"prependOnceListener", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeListener", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"off", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"removeAllListeners", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setMaxListeners", nullptr, ReturnThis, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getMaxListeners", nullptr, ReturnZero, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"emit", nullptr, ReturnFalse, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listenerCount", nullptr, ReturnZero, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"listeners", nullptr, ReturnEmptyArray, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"rawListeners", nullptr, ReturnEmptyArray, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"eventNames", nullptr, ReturnEmptyArray, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return DefineClass(env,
                     "Session",
                     [](napi_env /*env*/, napi_callback_info /*info*/) -> napi_value { return nullptr; },
                     methods,
                     sizeof(methods) / sizeof(methods[0]));
}

napi_value CreateNoopMethodObject(napi_env env, const char* const* names, size_t count) {
  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok || out == nullptr) return nullptr;
  for (size_t i = 0; i < count; ++i) {
    DefineMethod(env, out, names[i], ReturnUndefined);
  }
  return out;
}

constexpr std::array<BindingResolverEntry, 62> kResolvers = {{
    {"async_wrap", ResolveAsyncWrap},
    {"async_context_frame", ResolveAsyncContextFrame},
    {"block_list", ResolveBlockList},
    {"blob", ResolveBlob},
    {"buffer", ResolveBuffer},
    {"builtins", ResolveBuiltins},
    {"cares_wrap", ResolveCaresWrap},
    {"config", ResolveConfig},
    {"constants", ResolveConstants},
    {"contextify", ResolveContextify},
    {"credentials", ResolveCredentials},
    {"crypto", ResolveCrypto},
    {"encoding_binding", ResolveEncodingBinding},
    {"errors", ResolveErrors},
    {"fs_event_wrap", ResolveFsEventWrap},
    {"fs", ResolveFs},
    {"fs_dir", ResolveFsDir},
    {"heap_utils", ResolveHeapUtils},
    {"http2", ResolveHttp2},
    {"http_parser", ResolveHttpParser},
    {"icu", ResolveIcu},
    {"inspector", ResolveInspector},
    {"js_udp_wrap", ResolveJsUdpWrap},
    {"js_stream", ResolveJsStream},
    {"internal_only_v8", ResolveInternalOnlyV8},
    {"module_wrap", ResolveModuleWrap},
    {"modules", ResolveModules},
    {"mksnapshot", ResolveMksnapshot},
    {"messaging", ResolveMessaging},
    {"options", ResolveOptionsBinding},
    {"os", ResolveOs},
    {"performance", ResolvePerformance},
    {"permission", ResolvePermission},
    {"pipe_wrap", ResolvePipeWrap},
    {"process_methods", ResolveProcessMethods},
    {"process_wrap", ResolveProcessWrap},
    {"report", ResolveReport},
    {"sea", ResolveSea},
    {"serdes", ResolveSerdes},
    {"signal_wrap", ResolveSignalWrap},
    {"spawn_sync", ResolveSpawnSync},
    {"stream_pipe", ResolveStreamPipe},
    {"stream_wrap", ResolveStreamWrap},
    {"string_decoder", ResolveStringDecoder},
    {"symbols", ResolveSymbols},
    {"task_queue", ResolveTaskQueue},
    {"tcp_wrap", ResolveTcpWrap},
    {"tls_wrap", ResolveTlsWrap},
    {"timers", ResolveTimers},
    {"trace_events", ResolveTraceEvents},
    {"tty_wrap", ResolveTtyWrap},
    {"types", ResolveTypes},
    {"udp_wrap", ResolveUdpWrap},
    {"url", ResolveUrl},
    {"url_pattern", ResolveUrlPattern},
    {"util", ResolveUtil},
    {"v8", ResolveV8},
    {"uv", ResolveUv},
    {"watchdog", ResolveWatchdog},
    {"wasm_web_api", ResolveWasmWebApi},
    {"worker", ResolveWorker},
    {"zlib", ResolveZlib},
}};

}  // namespace

napi_value ResolveInspector(napi_env env, const ResolveOptions& /*options*/) {
  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok || out == nullptr) return Undefined(env);

  DefineMethod(env, out, "open", InspectorUnavailable);
  DefineMethod(env, out, "close", ReturnUndefined);
  DefineMethod(env, out, "url", InspectorUrl);
  DefineMethod(env, out, "isEnabled", InspectorIsEnabled);
  DefineMethod(env, out, "waitForDebugger", InspectorUnavailable);
  DefineMethod(env, out, "emitProtocolEvent", InspectorEmitProtocolEvent);
  DefineMethod(env, out, "setConsoleExtensionInstaller", ReturnUndefined);
  DefineMethod(env, out, "registerAsyncHook", ReturnUndefined);
  DefineMethod(env, out, "setupNetworkTracking", ReturnUndefined);
  DefineMethod(env, out, "putNetworkResource", ReturnUndefined);
  DefineMethod(env, out, "consoleCall", ReturnUndefined);
  DefineMethod(env, out, "callAndPauseOnStart", ReturnUndefined);

  napi_value console = GetGlobalNamed(env, "console");
  if (console == nullptr || IsUndefined(env, console)) {
    napi_create_object(env, &console);
  }
  if (console != nullptr) {
    napi_set_named_property(env, out, "console", console);
  }

  napi_value connection = DefineInspectorConnection(env, "Connection");
  if (connection != nullptr) napi_set_named_property(env, out, "Connection", connection);

  napi_value main_thread_connection = DefineInspectorConnection(env, "MainThreadConnection");
  if (main_thread_connection != nullptr) {
    napi_set_named_property(env, out, "MainThreadConnection", main_thread_connection);
  }

  napi_value session = DefineInspectorSession(env);
  if (session != nullptr) napi_set_named_property(env, out, "Session", session);

  const char* network_methods[] = {
      "requestWillBeSent",
      "responseReceived",
      "loadingFinished",
      "loadingFailed",
      "dataSent",
      "dataReceived",
      "webSocketCreated",
      "webSocketClosed",
      "webSocketHandshakeResponseReceived",
  };
  napi_value network = CreateNoopMethodObject(
      env, network_methods, sizeof(network_methods) / sizeof(network_methods[0]));
  if (network != nullptr) napi_set_named_property(env, out, "Network", network);

  const char* network_resource_methods[] = {"put"};
  napi_value network_resources = CreateNoopMethodObject(env, network_resource_methods, 1);
  if (network_resources != nullptr) {
    napi_set_named_property(env, out, "NetworkResources", network_resources);
  }

  return out;
}

napi_value Resolve(napi_env env, const std::string& name, const ResolveOptions& options) {
  for (const auto& entry : kResolvers) {
    if (entry.name == name) {
      return entry.resolver(env, options);
    }
  }
  return Undefined(env);
}

}  // namespace internal_binding

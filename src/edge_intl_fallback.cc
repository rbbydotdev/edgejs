#include "edge_intl_fallback.h"

#include <cmath>
#include <cstdio>
#include <string>

namespace {

struct DateTimeFormatOptions {
  std::string locale = "en-US";
  std::string hour;
  std::string minute;
  std::string second;
  bool hour12 = false;
};

const char* StatusToString(napi_status status) {
  switch (status) {
    case napi_ok:
      return "napi_ok";
    case napi_invalid_arg:
      return "napi_invalid_arg";
    case napi_object_expected:
      return "napi_object_expected";
    case napi_string_expected:
      return "napi_string_expected";
    case napi_name_expected:
      return "napi_name_expected";
    case napi_function_expected:
      return "napi_function_expected";
    case napi_number_expected:
      return "napi_number_expected";
    case napi_boolean_expected:
      return "napi_boolean_expected";
    case napi_array_expected:
      return "napi_array_expected";
    case napi_generic_failure:
      return "napi_generic_failure";
    case napi_pending_exception:
      return "napi_pending_exception";
    default:
      return "napi_unknown_error";
  }
}

void SetError(std::string* error_out, const std::string& message) {
  if (error_out != nullptr) *error_out = message;
}

napi_value Undefined(napi_env env) {
  napi_value out = nullptr;
  napi_get_undefined(env, &out);
  return out;
}

napi_value Null(napi_env env) {
  napi_value out = nullptr;
  napi_get_null(env, &out);
  return out;
}

bool IsFunction(napi_env env, napi_value value) {
  if (value == nullptr) return false;
  napi_valuetype type = napi_undefined;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_function;
}

bool HasUsableDateTimeFormat(napi_env env, napi_value global) {
  bool has_intl = false;
  if (napi_has_named_property(env, global, "Intl", &has_intl) != napi_ok || !has_intl) return false;

  napi_value intl = nullptr;
  if (napi_get_named_property(env, global, "Intl", &intl) != napi_ok || intl == nullptr) return false;

  bool has_date_time_format = false;
  if (napi_has_named_property(env, intl, "DateTimeFormat", &has_date_time_format) != napi_ok ||
      !has_date_time_format) {
    return false;
  }

  napi_value date_time_format = nullptr;
  return napi_get_named_property(env, intl, "DateTimeFormat", &date_time_format) == napi_ok &&
         IsFunction(env, date_time_format);
}

std::string ValueToString(napi_env env, napi_value value, const std::string& fallback = "") {
  if (value == nullptr) return fallback;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || (type != napi_string && type != napi_number &&
                                                     type != napi_boolean)) {
    return fallback;
  }
  size_t len = 0;
  if (napi_coerce_to_string(env, value, &value) != napi_ok ||
      napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) {
    return fallback;
  }
  std::string out(len + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, out.data(), out.size(), &copied) != napi_ok) {
    return fallback;
  }
  out.resize(copied);
  return out.empty() ? fallback : out;
}

napi_value GetNamed(napi_env env, napi_value object, const char* name) {
  if (object == nullptr) return nullptr;
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok || !has) return nullptr;
  napi_value out = nullptr;
  if (napi_get_named_property(env, object, name, &out) != napi_ok) return nullptr;
  return out;
}

bool GetBoolOption(napi_env env, napi_value options, const char* name) {
  napi_value value = GetNamed(env, options, name);
  if (value == nullptr) return false;
  bool out = false;
  return napi_get_value_bool(env, value, &out) == napi_ok && out;
}

std::string GetStringOption(napi_env env, napi_value options, const char* name) {
  napi_value value = GetNamed(env, options, name);
  return value == nullptr ? "" : ValueToString(env, value);
}

std::string ResolveLocale(napi_env env, napi_value locales) {
  if (locales == nullptr) return "en-US";
  bool is_array = false;
  if (napi_is_array(env, locales, &is_array) == napi_ok && is_array) {
    uint32_t len = 0;
    if (napi_get_array_length(env, locales, &len) == napi_ok && len > 0) {
      napi_value first = nullptr;
      if (napi_get_element(env, locales, 0, &first) == napi_ok && first != nullptr) {
        return ValueToString(env, first, "en-US");
      }
    }
    return "en-US";
  }

  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, locales, &type) != napi_ok || type == napi_undefined || type == napi_null) {
    return "en-US";
  }
  return ValueToString(env, locales, "en-US");
}

void DateTimeFormatOptionsFinalize(napi_env /*env*/, void* data, void* /*hint*/) {
  delete static_cast<DateTimeFormatOptions*>(data);
}

DateTimeFormatOptions* GetWrappedOptions(napi_env env, napi_value this_arg) {
  void* data = nullptr;
  if (this_arg == nullptr || napi_unwrap(env, this_arg, &data) != napi_ok || data == nullptr) return nullptr;
  return static_cast<DateTimeFormatOptions*>(data);
}

std::string Pad2(int value) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "%02d", std::abs(value) % 100);
  return buf;
}

napi_value NewDate(napi_env env, napi_value value) {
  napi_value global = nullptr;
  napi_value date_ctor = nullptr;
  if (napi_get_global(env, &global) != napi_ok || global == nullptr ||
      napi_get_named_property(env, global, "Date", &date_ctor) != napi_ok ||
      !IsFunction(env, date_ctor)) {
    return nullptr;
  }

  napi_value date = nullptr;
  napi_valuetype type = napi_undefined;
  if (value == nullptr || napi_typeof(env, value, &type) != napi_ok || type == napi_undefined) {
    if (napi_new_instance(env, date_ctor, 0, nullptr, &date) != napi_ok) return nullptr;
  } else if (napi_new_instance(env, date_ctor, 1, &value, &date) != napi_ok) {
    return nullptr;
  }
  return date;
}

bool CallNumberMethod(napi_env env, napi_value object, const char* name, double* out) {
  napi_value fn = GetNamed(env, object, name);
  if (!IsFunction(env, fn)) return false;
  napi_value result = nullptr;
  if (napi_call_function(env, object, fn, 0, nullptr, &result) != napi_ok || result == nullptr) return false;
  return napi_get_value_double(env, result, out) == napi_ok;
}

std::string CallStringMethod(napi_env env, napi_value object, const char* name, const std::string& fallback) {
  napi_value fn = GetNamed(env, object, name);
  if (!IsFunction(env, fn)) return fallback;
  napi_value result = nullptr;
  if (napi_call_function(env, object, fn, 0, nullptr, &result) != napi_ok || result == nullptr) return fallback;
  return ValueToString(env, result, fallback);
}

napi_value DateTimeFormatConstructor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_value this_arg = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, &this_arg, nullptr) != napi_ok || this_arg == nullptr) {
    return nullptr;
  }

  napi_value new_target = nullptr;
  if (napi_get_new_target(env, info, &new_target) != napi_ok) return nullptr;
  if (new_target == nullptr) {
    napi_value global = nullptr;
    napi_value intl = nullptr;
    napi_value ctor = nullptr;
    napi_value instance = nullptr;
    if (napi_get_global(env, &global) != napi_ok ||
        napi_get_named_property(env, global, "Intl", &intl) != napi_ok ||
        napi_get_named_property(env, intl, "DateTimeFormat", &ctor) != napi_ok ||
        !IsFunction(env, ctor) ||
        napi_new_instance(env, ctor, argc, argv, &instance) != napi_ok) {
      return nullptr;
    }
    return instance;
  }

  auto* options = new DateTimeFormatOptions();
  options->locale = argc > 0 ? ResolveLocale(env, argv[0]) : "en-US";
  if (argc > 1 && argv[1] != nullptr) {
    options->hour = GetStringOption(env, argv[1], "hour");
    options->minute = GetStringOption(env, argv[1], "minute");
    options->second = GetStringOption(env, argv[1], "second");
    options->hour12 = GetBoolOption(env, argv[1], "hour12");
  }

  if (napi_wrap(env, this_arg, options, DateTimeFormatOptionsFinalize, nullptr, nullptr) != napi_ok) {
    delete options;
    return nullptr;
  }
  return this_arg;
}

napi_value DateTimeFormatFormat(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_value this_arg = nullptr;
  if (napi_get_cb_info(env, info, &argc, argv, &this_arg, nullptr) != napi_ok) return nullptr;

  DateTimeFormatOptions* options = GetWrappedOptions(env, this_arg);
  napi_value date = NewDate(env, argc > 0 ? argv[0] : nullptr);
  if (date == nullptr) return Undefined(env);

  double time = 0;
  if (!CallNumberMethod(env, date, "getTime", &time) || std::isnan(time)) {
    napi_value out = nullptr;
    napi_create_string_utf8(env, "Invalid Date", NAPI_AUTO_LENGTH, &out);
    return out;
  }

  const bool wants_time = options != nullptr &&
                          (!options->hour.empty() || !options->minute.empty() || !options->second.empty());
  if (!wants_time) {
    const std::string text = CallStringMethod(env, date, "toString", "Invalid Date");
    napi_value out = nullptr;
    napi_create_string_utf8(env, text.c_str(), text.size(), &out);
    return out;
  }

  double hour_d = 0;
  double minute_d = 0;
  double second_d = 0;
  (void)CallNumberMethod(env, date, "getHours", &hour_d);
  (void)CallNumberMethod(env, date, "getMinutes", &minute_d);
  (void)CallNumberMethod(env, date, "getSeconds", &second_d);

  int hour = static_cast<int>(hour_d);
  const int minute = static_cast<int>(minute_d);
  const int second = static_cast<int>(second_d);

  std::string text;
  if (options != nullptr && options->hour12) {
    const char* suffix = hour >= 12 ? " PM" : " AM";
    hour %= 12;
    if (hour == 0) hour = 12;
    text = std::to_string(hour) + ":" + Pad2(minute) + ":" + Pad2(second) + suffix;
  } else {
    text = Pad2(hour) + ":" + Pad2(minute) + ":" + Pad2(second);
  }

  napi_value out = nullptr;
  napi_create_string_utf8(env, text.c_str(), text.size(), &out);
  return out;
}

bool SetString(napi_env env, napi_value object, const char* name, const std::string& value) {
  napi_value out = nullptr;
  return napi_create_string_utf8(env, value.c_str(), value.size(), &out) == napi_ok &&
         napi_set_named_property(env, object, name, out) == napi_ok;
}

bool SetBool(napi_env env, napi_value object, const char* name, bool value) {
  napi_value out = nullptr;
  return napi_get_boolean(env, value, &out) == napi_ok &&
         napi_set_named_property(env, object, name, out) == napi_ok;
}

napi_value DateTimeFormatResolvedOptions(napi_env env, napi_callback_info info) {
  napi_value this_arg = nullptr;
  size_t argc = 0;
  if (napi_get_cb_info(env, info, &argc, nullptr, &this_arg, nullptr) != napi_ok) return nullptr;
  DateTimeFormatOptions* options = GetWrappedOptions(env, this_arg);

  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok || out == nullptr) return Undefined(env);
  const bool hour12 = options != nullptr && options->hour12;
  SetString(env, out, "locale", options != nullptr ? options->locale : "en-US");
  SetString(env, out, "calendar", "gregory");
  SetString(env, out, "numberingSystem", "latn");
  SetString(env, out, "hourCycle", hour12 ? "h12" : "h23");
  SetBool(env, out, "hour12", hour12);
  SetString(env, out, "hour", options != nullptr && !options->hour.empty() ? options->hour : "2-digit");
  SetString(env, out, "minute", options != nullptr && !options->minute.empty() ? options->minute : "2-digit");
  SetString(env, out, "second", options != nullptr && !options->second.empty() ? options->second : "2-digit");
  return out;
}

napi_value DateTimeFormatSupportedLocalesOf(napi_env env, napi_callback_info /*info*/) {
  napi_value out = nullptr;
  napi_create_array_with_length(env, 0, &out);
  return out != nullptr ? out : Undefined(env);
}

bool DefineMethod(napi_env env, napi_value object, const char* name, napi_callback cb) {
  napi_value fn = nullptr;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn) == napi_ok &&
         napi_set_named_property(env, object, name, fn) == napi_ok;
}

bool InstallToStringTag(napi_env env, napi_value prototype) {
  napi_value global = nullptr;
  napi_value symbol = nullptr;
  napi_value tag = nullptr;
  napi_value key = nullptr;
  if (napi_get_global(env, &global) != napi_ok ||
      napi_get_named_property(env, global, "Symbol", &symbol) != napi_ok ||
      napi_get_named_property(env, symbol, "toStringTag", &key) != napi_ok ||
      napi_create_string_utf8(env, "Intl.DateTimeFormat", NAPI_AUTO_LENGTH, &tag) != napi_ok) {
    return false;
  }
  napi_property_descriptor desc = {};
  desc.name = key;
  desc.value = tag;
  desc.attributes = napi_configurable;
  return napi_define_properties(env, prototype, 1, &desc) == napi_ok;
}

bool InstallDateTimeFormat(napi_env env, napi_value intl, std::string* error_out) {
  napi_property_descriptor methods[] = {
      {"format", nullptr, DateTimeFormatFormat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resolvedOptions", nullptr, DateTimeFormatResolvedOptions, nullptr, nullptr, nullptr, napi_default, nullptr},
  };

  napi_value ctor = nullptr;
  napi_status status = napi_define_class(env,
                                         "DateTimeFormat",
                                         NAPI_AUTO_LENGTH,
                                         DateTimeFormatConstructor,
                                         nullptr,
                                         sizeof(methods) / sizeof(methods[0]),
                                         methods,
                                         &ctor);
  if (status != napi_ok || ctor == nullptr) {
    SetError(error_out, std::string("Failed to define Intl.DateTimeFormat fallback: ") + StatusToString(status));
    return false;
  }

  DefineMethod(env, ctor, "supportedLocalesOf", DateTimeFormatSupportedLocalesOf);

  napi_value prototype = nullptr;
  if (napi_get_named_property(env, ctor, "prototype", &prototype) == napi_ok && prototype != nullptr) {
    InstallToStringTag(env, prototype);
  }

  if (napi_set_named_property(env, intl, "DateTimeFormat", ctor) != napi_ok) {
    SetError(error_out, "Failed to install Intl.DateTimeFormat fallback");
    return false;
  }
  return true;
}

}  // namespace

bool EdgeInstallMinimalIntlFallback(napi_env env, std::string* error_out) {
  if (env == nullptr) return false;

  napi_value global = nullptr;
  if (napi_get_global(env, &global) != napi_ok || global == nullptr) {
    SetError(error_out, "Failed to fetch global object for Intl fallback");
    return false;
  }

  if (HasUsableDateTimeFormat(env, global)) return true;

  napi_value intl = nullptr;
  bool has_intl = false;
  if (napi_has_named_property(env, global, "Intl", &has_intl) == napi_ok && has_intl) {
    (void)napi_get_named_property(env, global, "Intl", &intl);
  }

  napi_valuetype intl_type = napi_undefined;
  if (intl == nullptr ||
      napi_typeof(env, intl, &intl_type) != napi_ok ||
      (intl_type != napi_object && intl_type != napi_function)) {
    if (napi_create_object(env, &intl) != napi_ok || intl == nullptr) {
      SetError(error_out, "Failed to create Intl fallback object");
      return false;
    }
    if (napi_set_named_property(env, global, "Intl", intl) != napi_ok) {
      SetError(error_out, "Failed to install Intl fallback object");
      return false;
    }
  }

  return InstallDateTimeFormat(env, intl, error_out);
}

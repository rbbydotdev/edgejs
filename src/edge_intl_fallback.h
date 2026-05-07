#ifndef EDGE_INTL_FALLBACK_H_
#define EDGE_INTL_FALLBACK_H_

#include <string>

#include "node_api.h"

bool EdgeInstallMinimalIntlFallback(napi_env env, std::string* error_out);

#endif  // EDGE_INTL_FALLBACK_H_

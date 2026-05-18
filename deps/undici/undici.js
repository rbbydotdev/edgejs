"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: !0 });
var __commonJS = (cb, mod) => function() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// lib/core/errors.js
var require_errors = __commonJS({
  "lib/core/errors.js"(exports2, module2) {
    "use strict";
    var kUndiciError = Symbol.for("undici.error.UND_ERR"), UndiciError = class extends Error {
      static {
        __name(this, "UndiciError");
      }
      constructor(message, options) {
        super(message, options), this.name = "UndiciError", this.code = "UND_ERR";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kUndiciError] === !0;
      }
      get [kUndiciError]() {
        return !0;
      }
    }, kConnectTimeoutError = Symbol.for("undici.error.UND_ERR_CONNECT_TIMEOUT"), ConnectTimeoutError = class extends UndiciError {
      static {
        __name(this, "ConnectTimeoutError");
      }
      constructor(message) {
        super(message), this.name = "ConnectTimeoutError", this.message = message || "Connect Timeout Error", this.code = "UND_ERR_CONNECT_TIMEOUT";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kConnectTimeoutError] === !0;
      }
      get [kConnectTimeoutError]() {
        return !0;
      }
    }, kHeadersTimeoutError = Symbol.for("undici.error.UND_ERR_HEADERS_TIMEOUT"), HeadersTimeoutError = class extends UndiciError {
      static {
        __name(this, "HeadersTimeoutError");
      }
      constructor(message) {
        super(message), this.name = "HeadersTimeoutError", this.message = message || "Headers Timeout Error", this.code = "UND_ERR_HEADERS_TIMEOUT";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kHeadersTimeoutError] === !0;
      }
      get [kHeadersTimeoutError]() {
        return !0;
      }
    }, kHeadersOverflowError = Symbol.for("undici.error.UND_ERR_HEADERS_OVERFLOW"), HeadersOverflowError = class extends UndiciError {
      static {
        __name(this, "HeadersOverflowError");
      }
      constructor(message) {
        super(message), this.name = "HeadersOverflowError", this.message = message || "Headers Overflow Error", this.code = "UND_ERR_HEADERS_OVERFLOW";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kHeadersOverflowError] === !0;
      }
      get [kHeadersOverflowError]() {
        return !0;
      }
    }, kBodyTimeoutError = Symbol.for("undici.error.UND_ERR_BODY_TIMEOUT"), BodyTimeoutError = class extends UndiciError {
      static {
        __name(this, "BodyTimeoutError");
      }
      constructor(message) {
        super(message), this.name = "BodyTimeoutError", this.message = message || "Body Timeout Error", this.code = "UND_ERR_BODY_TIMEOUT";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kBodyTimeoutError] === !0;
      }
      get [kBodyTimeoutError]() {
        return !0;
      }
    }, kInvalidArgumentError = Symbol.for("undici.error.UND_ERR_INVALID_ARG"), InvalidArgumentError = class extends UndiciError {
      static {
        __name(this, "InvalidArgumentError");
      }
      constructor(message) {
        super(message), this.name = "InvalidArgumentError", this.message = message || "Invalid Argument Error", this.code = "UND_ERR_INVALID_ARG";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kInvalidArgumentError] === !0;
      }
      get [kInvalidArgumentError]() {
        return !0;
      }
    }, kInvalidReturnValueError = Symbol.for("undici.error.UND_ERR_INVALID_RETURN_VALUE"), InvalidReturnValueError = class extends UndiciError {
      static {
        __name(this, "InvalidReturnValueError");
      }
      constructor(message) {
        super(message), this.name = "InvalidReturnValueError", this.message = message || "Invalid Return Value Error", this.code = "UND_ERR_INVALID_RETURN_VALUE";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kInvalidReturnValueError] === !0;
      }
      get [kInvalidReturnValueError]() {
        return !0;
      }
    }, kAbortError = Symbol.for("undici.error.UND_ERR_ABORT"), AbortError = class extends UndiciError {
      static {
        __name(this, "AbortError");
      }
      constructor(message) {
        super(message), this.name = "AbortError", this.message = message || "The operation was aborted", this.code = "UND_ERR_ABORT";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kAbortError] === !0;
      }
      get [kAbortError]() {
        return !0;
      }
    }, kRequestAbortedError = Symbol.for("undici.error.UND_ERR_ABORTED"), RequestAbortedError = class extends AbortError {
      static {
        __name(this, "RequestAbortedError");
      }
      constructor(message) {
        super(message), this.name = "AbortError", this.message = message || "Request aborted", this.code = "UND_ERR_ABORTED";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kRequestAbortedError] === !0;
      }
      get [kRequestAbortedError]() {
        return !0;
      }
    }, kInformationalError = Symbol.for("undici.error.UND_ERR_INFO"), InformationalError = class extends UndiciError {
      static {
        __name(this, "InformationalError");
      }
      constructor(message) {
        super(message), this.name = "InformationalError", this.message = message || "Request information", this.code = "UND_ERR_INFO";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kInformationalError] === !0;
      }
      get [kInformationalError]() {
        return !0;
      }
    }, kRequestContentLengthMismatchError = Symbol.for("undici.error.UND_ERR_REQ_CONTENT_LENGTH_MISMATCH"), RequestContentLengthMismatchError = class extends UndiciError {
      static {
        __name(this, "RequestContentLengthMismatchError");
      }
      constructor(message) {
        super(message), this.name = "RequestContentLengthMismatchError", this.message = message || "Request body length does not match content-length header", this.code = "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kRequestContentLengthMismatchError] === !0;
      }
      get [kRequestContentLengthMismatchError]() {
        return !0;
      }
    }, kResponseContentLengthMismatchError = Symbol.for("undici.error.UND_ERR_RES_CONTENT_LENGTH_MISMATCH"), ResponseContentLengthMismatchError = class extends UndiciError {
      static {
        __name(this, "ResponseContentLengthMismatchError");
      }
      constructor(message) {
        super(message), this.name = "ResponseContentLengthMismatchError", this.message = message || "Response body length does not match content-length header", this.code = "UND_ERR_RES_CONTENT_LENGTH_MISMATCH";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kResponseContentLengthMismatchError] === !0;
      }
      get [kResponseContentLengthMismatchError]() {
        return !0;
      }
    }, kClientDestroyedError = Symbol.for("undici.error.UND_ERR_DESTROYED"), ClientDestroyedError = class extends UndiciError {
      static {
        __name(this, "ClientDestroyedError");
      }
      constructor(message) {
        super(message), this.name = "ClientDestroyedError", this.message = message || "The client is destroyed", this.code = "UND_ERR_DESTROYED";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kClientDestroyedError] === !0;
      }
      get [kClientDestroyedError]() {
        return !0;
      }
    }, kClientClosedError = Symbol.for("undici.error.UND_ERR_CLOSED"), ClientClosedError = class extends UndiciError {
      static {
        __name(this, "ClientClosedError");
      }
      constructor(message) {
        super(message), this.name = "ClientClosedError", this.message = message || "The client is closed", this.code = "UND_ERR_CLOSED";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kClientClosedError] === !0;
      }
      get [kClientClosedError]() {
        return !0;
      }
    }, kSocketError = Symbol.for("undici.error.UND_ERR_SOCKET"), SocketError = class extends UndiciError {
      static {
        __name(this, "SocketError");
      }
      constructor(message, socket) {
        super(message), this.name = "SocketError", this.message = message || "Socket error", this.code = "UND_ERR_SOCKET", this.socket = socket;
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kSocketError] === !0;
      }
      get [kSocketError]() {
        return !0;
      }
    }, kNotSupportedError = Symbol.for("undici.error.UND_ERR_NOT_SUPPORTED"), NotSupportedError = class extends UndiciError {
      static {
        __name(this, "NotSupportedError");
      }
      constructor(message) {
        super(message), this.name = "NotSupportedError", this.message = message || "Not supported error", this.code = "UND_ERR_NOT_SUPPORTED";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kNotSupportedError] === !0;
      }
      get [kNotSupportedError]() {
        return !0;
      }
    }, kBalancedPoolMissingUpstreamError = Symbol.for("undici.error.UND_ERR_BPL_MISSING_UPSTREAM"), BalancedPoolMissingUpstreamError = class extends UndiciError {
      static {
        __name(this, "BalancedPoolMissingUpstreamError");
      }
      constructor(message) {
        super(message), this.name = "MissingUpstreamError", this.message = message || "No upstream has been added to the BalancedPool", this.code = "UND_ERR_BPL_MISSING_UPSTREAM";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kBalancedPoolMissingUpstreamError] === !0;
      }
      get [kBalancedPoolMissingUpstreamError]() {
        return !0;
      }
    }, kHTTPParserError = Symbol.for("undici.error.UND_ERR_HTTP_PARSER"), HTTPParserError = class extends Error {
      static {
        __name(this, "HTTPParserError");
      }
      constructor(message, code, data) {
        super(message), this.name = "HTTPParserError", this.code = code ? `HPE_${code}` : void 0, this.data = data ? data.toString() : void 0;
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kHTTPParserError] === !0;
      }
      get [kHTTPParserError]() {
        return !0;
      }
    }, kResponseExceededMaxSizeError = Symbol.for("undici.error.UND_ERR_RES_EXCEEDED_MAX_SIZE"), ResponseExceededMaxSizeError = class extends UndiciError {
      static {
        __name(this, "ResponseExceededMaxSizeError");
      }
      constructor(message) {
        super(message), this.name = "ResponseExceededMaxSizeError", this.message = message || "Response content exceeded max size", this.code = "UND_ERR_RES_EXCEEDED_MAX_SIZE";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kResponseExceededMaxSizeError] === !0;
      }
      get [kResponseExceededMaxSizeError]() {
        return !0;
      }
    }, kRequestRetryError = Symbol.for("undici.error.UND_ERR_REQ_RETRY"), RequestRetryError = class extends UndiciError {
      static {
        __name(this, "RequestRetryError");
      }
      constructor(message, code, { headers, data }) {
        super(message), this.name = "RequestRetryError", this.message = message || "Request retry error", this.code = "UND_ERR_REQ_RETRY", this.statusCode = code, this.data = data, this.headers = headers;
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kRequestRetryError] === !0;
      }
      get [kRequestRetryError]() {
        return !0;
      }
    }, kResponseError = Symbol.for("undici.error.UND_ERR_RESPONSE"), ResponseError = class extends UndiciError {
      static {
        __name(this, "ResponseError");
      }
      constructor(message, code, { headers, body }) {
        super(message), this.name = "ResponseError", this.message = message || "Response error", this.code = "UND_ERR_RESPONSE", this.statusCode = code, this.body = body, this.headers = headers;
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kResponseError] === !0;
      }
      get [kResponseError]() {
        return !0;
      }
    }, kSecureProxyConnectionError = Symbol.for("undici.error.UND_ERR_PRX_TLS"), SecureProxyConnectionError = class extends UndiciError {
      static {
        __name(this, "SecureProxyConnectionError");
      }
      constructor(cause, message, options = {}) {
        super(message, { cause, ...options }), this.name = "SecureProxyConnectionError", this.message = message || "Secure Proxy Connection failed", this.code = "UND_ERR_PRX_TLS", this.cause = cause;
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kSecureProxyConnectionError] === !0;
      }
      get [kSecureProxyConnectionError]() {
        return !0;
      }
    }, kMaxOriginsReachedError = Symbol.for("undici.error.UND_ERR_MAX_ORIGINS_REACHED"), MaxOriginsReachedError = class extends UndiciError {
      static {
        __name(this, "MaxOriginsReachedError");
      }
      constructor(message) {
        super(message), this.name = "MaxOriginsReachedError", this.message = message || "Maximum allowed origins reached", this.code = "UND_ERR_MAX_ORIGINS_REACHED";
      }
      static [Symbol.hasInstance](instance) {
        return instance && instance[kMaxOriginsReachedError] === !0;
      }
      get [kMaxOriginsReachedError]() {
        return !0;
      }
    };
    module2.exports = {
      AbortError,
      HTTPParserError,
      UndiciError,
      HeadersTimeoutError,
      HeadersOverflowError,
      BodyTimeoutError,
      RequestContentLengthMismatchError,
      ConnectTimeoutError,
      InvalidArgumentError,
      InvalidReturnValueError,
      RequestAbortedError,
      ClientDestroyedError,
      ClientClosedError,
      InformationalError,
      SocketError,
      NotSupportedError,
      ResponseContentLengthMismatchError,
      BalancedPoolMissingUpstreamError,
      ResponseExceededMaxSizeError,
      RequestRetryError,
      ResponseError,
      SecureProxyConnectionError,
      MaxOriginsReachedError
    };
  }
});

// lib/core/symbols.js
var require_symbols = __commonJS({
  "lib/core/symbols.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      kClose: Symbol("close"),
      kDestroy: Symbol("destroy"),
      kDispatch: Symbol("dispatch"),
      kUrl: Symbol("url"),
      kWriting: Symbol("writing"),
      kResuming: Symbol("resuming"),
      kQueue: Symbol("queue"),
      kConnect: Symbol("connect"),
      kConnecting: Symbol("connecting"),
      kKeepAliveDefaultTimeout: Symbol("default keep alive timeout"),
      kKeepAliveMaxTimeout: Symbol("max keep alive timeout"),
      kKeepAliveTimeoutThreshold: Symbol("keep alive timeout threshold"),
      kKeepAliveTimeoutValue: Symbol("keep alive timeout"),
      kKeepAlive: Symbol("keep alive"),
      kHeadersTimeout: Symbol("headers timeout"),
      kBodyTimeout: Symbol("body timeout"),
      kServerName: Symbol("server name"),
      kLocalAddress: Symbol("local address"),
      kHost: Symbol("host"),
      kNoRef: Symbol("no ref"),
      kBodyUsed: Symbol("used"),
      kBody: Symbol("abstracted request body"),
      kRunning: Symbol("running"),
      kBlocking: Symbol("blocking"),
      kPending: Symbol("pending"),
      kSize: Symbol("size"),
      kBusy: Symbol("busy"),
      kQueued: Symbol("queued"),
      kFree: Symbol("free"),
      kConnected: Symbol("connected"),
      kClosed: Symbol("closed"),
      kNeedDrain: Symbol("need drain"),
      kReset: Symbol("reset"),
      kDestroyed: Symbol.for("nodejs.stream.destroyed"),
      kResume: Symbol("resume"),
      kOnError: Symbol("on error"),
      kMaxHeadersSize: Symbol("max headers size"),
      kRunningIdx: Symbol("running index"),
      kPendingIdx: Symbol("pending index"),
      kError: Symbol("error"),
      kClients: Symbol("clients"),
      kClient: Symbol("client"),
      kParser: Symbol("parser"),
      kOnDestroyed: Symbol("destroy callbacks"),
      kPipelining: Symbol("pipelining"),
      kSocket: Symbol("socket"),
      kHostHeader: Symbol("host header"),
      kConnector: Symbol("connector"),
      kStrictContentLength: Symbol("strict content length"),
      kMaxRedirections: Symbol("maxRedirections"),
      kMaxRequests: Symbol("maxRequestsPerClient"),
      kProxy: Symbol("proxy agent options"),
      kCounter: Symbol("socket request counter"),
      kMaxResponseSize: Symbol("max response size"),
      kHTTP2Session: Symbol("http2Session"),
      kHTTP2SessionState: Symbol("http2Session state"),
      kRetryHandlerDefaultRetry: Symbol("retry agent default retry"),
      kConstruct: Symbol("constructable"),
      kListeners: Symbol("listeners"),
      kHTTPContext: Symbol("http context"),
      kMaxConcurrentStreams: Symbol("max concurrent streams"),
      kEnableConnectProtocol: Symbol("http2session connect protocol"),
      kRemoteSettings: Symbol("http2session remote settings"),
      kHTTP2Stream: Symbol("http2session client stream"),
      kNoProxyAgent: Symbol("no proxy agent"),
      kHttpProxyAgent: Symbol("http proxy agent"),
      kHttpsProxyAgent: Symbol("https proxy agent")
    };
  }
});

// lib/handler/wrap-handler.js
var require_wrap_handler = __commonJS({
  "lib/handler/wrap-handler.js"(exports2, module2) {
    "use strict";
    var { InvalidArgumentError } = require_errors();
    module2.exports = class WrapHandler {
      static {
        __name(this, "WrapHandler");
      }
      #handler;
      constructor(handler) {
        this.#handler = handler;
      }
      static wrap(handler) {
        return handler.onRequestStart ? handler : new WrapHandler(handler);
      }
      // Unwrap Interface
      onConnect(abort, context) {
        return this.#handler.onConnect?.(abort, context);
      }
      onHeaders(statusCode, rawHeaders, resume, statusMessage) {
        return this.#handler.onHeaders?.(statusCode, rawHeaders, resume, statusMessage);
      }
      onUpgrade(statusCode, rawHeaders, socket) {
        return this.#handler.onUpgrade?.(statusCode, rawHeaders, socket);
      }
      onData(data) {
        return this.#handler.onData?.(data);
      }
      onComplete(trailers) {
        return this.#handler.onComplete?.(trailers);
      }
      onError(err) {
        if (!this.#handler.onError)
          throw err;
        return this.#handler.onError?.(err);
      }
      // Wrap Interface
      onRequestStart(controller, context) {
        this.#handler.onConnect?.((reason) => controller.abort(reason), context);
      }
      onRequestUpgrade(controller, statusCode, headers, socket) {
        let rawHeaders = [];
        for (let [key, val] of Object.entries(headers))
          rawHeaders.push(Buffer.from(key), Array.isArray(val) ? val.map((v) => Buffer.from(v)) : Buffer.from(val));
        this.#handler.onUpgrade?.(statusCode, rawHeaders, socket);
      }
      onResponseStart(controller, statusCode, headers, statusMessage) {
        let rawHeaders = [];
        for (let [key, val] of Object.entries(headers))
          rawHeaders.push(Buffer.from(key), Array.isArray(val) ? val.map((v) => Buffer.from(v)) : Buffer.from(val));
        this.#handler.onHeaders?.(statusCode, rawHeaders, () => controller.resume(), statusMessage) === !1 && controller.pause();
      }
      onResponseData(controller, data) {
        this.#handler.onData?.(data) === !1 && controller.pause();
      }
      onResponseEnd(controller, trailers) {
        let rawTrailers = [];
        for (let [key, val] of Object.entries(trailers))
          rawTrailers.push(Buffer.from(key), Array.isArray(val) ? val.map((v) => Buffer.from(v)) : Buffer.from(val));
        this.#handler.onComplete?.(rawTrailers);
      }
      onResponseError(controller, err) {
        if (!this.#handler.onError)
          throw new InvalidArgumentError("invalid onError method");
        this.#handler.onError?.(err);
      }
    };
  }
});

// lib/dispatcher/dispatcher.js
var require_dispatcher = __commonJS({
  "lib/dispatcher/dispatcher.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("node:events"), WrapHandler = require_wrap_handler(), wrapInterceptor = /* @__PURE__ */ __name((dispatch) => (opts, handler) => dispatch(opts, WrapHandler.wrap(handler)), "wrapInterceptor"), Dispatcher2 = class extends EventEmitter {
      static {
        __name(this, "Dispatcher");
      }
      dispatch() {
        throw new Error("not implemented");
      }
      close() {
        throw new Error("not implemented");
      }
      destroy() {
        throw new Error("not implemented");
      }
      compose(...args) {
        let interceptors = Array.isArray(args[0]) ? args[0] : args, dispatch = this.dispatch.bind(this);
        for (let interceptor of interceptors)
          if (interceptor != null) {
            if (typeof interceptor != "function")
              throw new TypeError(`invalid interceptor, expected function received ${typeof interceptor}`);
            if (dispatch = interceptor(dispatch), dispatch = wrapInterceptor(dispatch), dispatch == null || typeof dispatch != "function" || dispatch.length !== 2)
              throw new TypeError("invalid interceptor");
          }
        return new Proxy(this, {
          get: /* @__PURE__ */ __name((target, key) => key === "dispatch" ? dispatch : target[key], "get")
        });
      }
    };
    module2.exports = Dispatcher2;
  }
});

// lib/util/timers.js
var require_timers = __commonJS({
  "lib/util/timers.js"(exports2, module2) {
    "use strict";
    var fastNow = 0, RESOLUTION_MS = 1e3, TICK_MS = (RESOLUTION_MS >> 1) - 1, fastNowTimeout, kFastTimer = Symbol("kFastTimer"), fastTimers = [], NOT_IN_LIST = -2, TO_BE_CLEARED = -1, PENDING = 0, ACTIVE = 1;
    function onTick() {
      fastNow += TICK_MS;
      let idx = 0, len = fastTimers.length;
      for (; idx < len; ) {
        let timer = fastTimers[idx];
        timer._state === PENDING ? (timer._idleStart = fastNow - TICK_MS, timer._state = ACTIVE) : timer._state === ACTIVE && fastNow >= timer._idleStart + timer._idleTimeout && (timer._state = TO_BE_CLEARED, timer._idleStart = -1, timer._onTimeout(timer._timerArg)), timer._state === TO_BE_CLEARED ? (timer._state = NOT_IN_LIST, --len !== 0 && (fastTimers[idx] = fastTimers[len])) : ++idx;
      }
      fastTimers.length = len, fastTimers.length !== 0 && refreshTimeout();
    }
    __name(onTick, "onTick");
    function refreshTimeout() {
      fastNowTimeout?.refresh ? fastNowTimeout.refresh() : (clearTimeout(fastNowTimeout), fastNowTimeout = setTimeout(onTick, TICK_MS), fastNowTimeout?.unref());
    }
    __name(refreshTimeout, "refreshTimeout");
    var FastTimer = class {
      static {
        __name(this, "FastTimer");
      }
      [kFastTimer] = !0;
      /**
       * The state of the timer, which can be one of the following:
       * - NOT_IN_LIST (-2)
       * - TO_BE_CLEARED (-1)
       * - PENDING (0)
       * - ACTIVE (1)
       *
       * @type {-2|-1|0|1}
       * @private
       */
      _state = NOT_IN_LIST;
      /**
       * The number of milliseconds to wait before calling the callback.
       *
       * @type {number}
       * @private
       */
      _idleTimeout = -1;
      /**
       * The time in milliseconds when the timer was started. This value is used to
       * calculate when the timer should expire.
       *
       * @type {number}
       * @default -1
       * @private
       */
      _idleStart = -1;
      /**
       * The function to be executed when the timer expires.
       * @type {Function}
       * @private
       */
      _onTimeout;
      /**
       * The argument to be passed to the callback when the timer expires.
       *
       * @type {*}
       * @private
       */
      _timerArg;
      /**
       * @constructor
       * @param {Function} callback A function to be executed after the timer
       * expires.
       * @param {number} delay The time, in milliseconds that the timer should wait
       * before the specified function or code is executed.
       * @param {*} arg
       */
      constructor(callback, delay, arg) {
        this._onTimeout = callback, this._idleTimeout = delay, this._timerArg = arg, this.refresh();
      }
      /**
       * Sets the timer's start time to the current time, and reschedules the timer
       * to call its callback at the previously specified duration adjusted to the
       * current time.
       * Using this on a timer that has already called its callback will reactivate
       * the timer.
       *
       * @returns {void}
       */
      refresh() {
        this._state === NOT_IN_LIST && fastTimers.push(this), (!fastNowTimeout || fastTimers.length === 1) && refreshTimeout(), this._state = PENDING;
      }
      /**
       * The `clear` method cancels the timer, preventing it from executing.
       *
       * @returns {void}
       * @private
       */
      clear() {
        this._state = TO_BE_CLEARED, this._idleStart = -1;
      }
    };
    module2.exports = {
      /**
       * The setTimeout() method sets a timer which executes a function once the
       * timer expires.
       * @param {Function} callback A function to be executed after the timer
       * expires.
       * @param {number} delay The time, in milliseconds that the timer should
       * wait before the specified function or code is executed.
       * @param {*} [arg] An optional argument to be passed to the callback function
       * when the timer expires.
       * @returns {NodeJS.Timeout|FastTimer}
       */
      setTimeout(callback, delay, arg) {
        return delay <= RESOLUTION_MS ? setTimeout(callback, delay, arg) : new FastTimer(callback, delay, arg);
      },
      /**
       * The clearTimeout method cancels an instantiated Timer previously created
       * by calling setTimeout.
       *
       * @param {NodeJS.Timeout|FastTimer} timeout
       */
      clearTimeout(timeout) {
        timeout[kFastTimer] ? timeout.clear() : clearTimeout(timeout);
      },
      /**
       * The setFastTimeout() method sets a fastTimer which executes a function once
       * the timer expires.
       * @param {Function} callback A function to be executed after the timer
       * expires.
       * @param {number} delay The time, in milliseconds that the timer should
       * wait before the specified function or code is executed.
       * @param {*} [arg] An optional argument to be passed to the callback function
       * when the timer expires.
       * @returns {FastTimer}
       */
      setFastTimeout(callback, delay, arg) {
        return new FastTimer(callback, delay, arg);
      },
      /**
       * The clearTimeout method cancels an instantiated FastTimer previously
       * created by calling setFastTimeout.
       *
       * @param {FastTimer} timeout
       */
      clearFastTimeout(timeout) {
        timeout.clear();
      },
      /**
       * The now method returns the value of the internal fast timer clock.
       *
       * @returns {number}
       */
      now() {
        return fastNow;
      },
      /**
       * Trigger the onTick function to process the fastTimers array.
       * Exported for testing purposes only.
       * Marking as deprecated to discourage any use outside of testing.
       * @deprecated
       * @param {number} [delay=0] The delay in milliseconds to add to the now value.
       */
      tick(delay = 0) {
        fastNow += delay - RESOLUTION_MS + 1, onTick(), onTick();
      },
      /**
       * Reset FastTimers.
       * Exported for testing purposes only.
       * Marking as deprecated to discourage any use outside of testing.
       * @deprecated
       */
      reset() {
        fastNow = 0, fastTimers.length = 0, clearTimeout(fastNowTimeout), fastNowTimeout = null;
      },
      /**
       * Exporting for testing purposes only.
       * Marking as deprecated to discourage any use outside of testing.
       * @deprecated
       */
      kFastTimer
    };
  }
});

// lib/core/constants.js
var require_constants = __commonJS({
  "lib/core/constants.js"(exports2, module2) {
    "use strict";
    var wellknownHeaderNames = (
      /** @type {const} */
      [
        "Accept",
        "Accept-Encoding",
        "Accept-Language",
        "Accept-Ranges",
        "Access-Control-Allow-Credentials",
        "Access-Control-Allow-Headers",
        "Access-Control-Allow-Methods",
        "Access-Control-Allow-Origin",
        "Access-Control-Expose-Headers",
        "Access-Control-Max-Age",
        "Access-Control-Request-Headers",
        "Access-Control-Request-Method",
        "Age",
        "Allow",
        "Alt-Svc",
        "Alt-Used",
        "Authorization",
        "Cache-Control",
        "Clear-Site-Data",
        "Connection",
        "Content-Disposition",
        "Content-Encoding",
        "Content-Language",
        "Content-Length",
        "Content-Location",
        "Content-Range",
        "Content-Security-Policy",
        "Content-Security-Policy-Report-Only",
        "Content-Type",
        "Cookie",
        "Cross-Origin-Embedder-Policy",
        "Cross-Origin-Opener-Policy",
        "Cross-Origin-Resource-Policy",
        "Date",
        "Device-Memory",
        "Downlink",
        "ECT",
        "ETag",
        "Expect",
        "Expect-CT",
        "Expires",
        "Forwarded",
        "From",
        "Host",
        "If-Match",
        "If-Modified-Since",
        "If-None-Match",
        "If-Range",
        "If-Unmodified-Since",
        "Keep-Alive",
        "Last-Modified",
        "Link",
        "Location",
        "Max-Forwards",
        "Origin",
        "Permissions-Policy",
        "Pragma",
        "Proxy-Authenticate",
        "Proxy-Authorization",
        "RTT",
        "Range",
        "Referer",
        "Referrer-Policy",
        "Refresh",
        "Retry-After",
        "Sec-WebSocket-Accept",
        "Sec-WebSocket-Extensions",
        "Sec-WebSocket-Key",
        "Sec-WebSocket-Protocol",
        "Sec-WebSocket-Version",
        "Server",
        "Server-Timing",
        "Service-Worker-Allowed",
        "Service-Worker-Navigation-Preload",
        "Set-Cookie",
        "SourceMap",
        "Strict-Transport-Security",
        "Supports-Loading-Mode",
        "TE",
        "Timing-Allow-Origin",
        "Trailer",
        "Transfer-Encoding",
        "Upgrade",
        "Upgrade-Insecure-Requests",
        "User-Agent",
        "Vary",
        "Via",
        "WWW-Authenticate",
        "X-Content-Type-Options",
        "X-DNS-Prefetch-Control",
        "X-Frame-Options",
        "X-Permitted-Cross-Domain-Policies",
        "X-Powered-By",
        "X-Requested-With",
        "X-XSS-Protection"
      ]
    ), headerNameLowerCasedRecord = {};
    Object.setPrototypeOf(headerNameLowerCasedRecord, null);
    var wellknownHeaderNameBuffers = {};
    Object.setPrototypeOf(wellknownHeaderNameBuffers, null);
    function getHeaderNameAsBuffer(header) {
      let buffer = wellknownHeaderNameBuffers[header];
      return buffer === void 0 && (buffer = Buffer.from(header)), buffer;
    }
    __name(getHeaderNameAsBuffer, "getHeaderNameAsBuffer");
    for (let i = 0; i < wellknownHeaderNames.length; ++i) {
      let key = wellknownHeaderNames[i], lowerCasedKey = key.toLowerCase();
      headerNameLowerCasedRecord[key] = headerNameLowerCasedRecord[lowerCasedKey] = lowerCasedKey;
    }
    module2.exports = {
      wellknownHeaderNames,
      headerNameLowerCasedRecord,
      getHeaderNameAsBuffer
    };
  }
});

// lib/core/tree.js
var require_tree = __commonJS({
  "lib/core/tree.js"(exports2, module2) {
    "use strict";
    var {
      wellknownHeaderNames,
      headerNameLowerCasedRecord
    } = require_constants(), TstNode = class _TstNode {
      static {
        __name(this, "TstNode");
      }
      /** @type {any} */
      value = null;
      /** @type {null | TstNode} */
      left = null;
      /** @type {null | TstNode} */
      middle = null;
      /** @type {null | TstNode} */
      right = null;
      /** @type {number} */
      code;
      /**
       * @param {string} key
       * @param {any} value
       * @param {number} index
       */
      constructor(key, value, index) {
        if (index === void 0 || index >= key.length)
          throw new TypeError("Unreachable");
        if ((this.code = key.charCodeAt(index)) > 127)
          throw new TypeError("key must be ascii string");
        key.length !== ++index ? this.middle = new _TstNode(key, value, index) : this.value = value;
      }
      /**
       * @param {string} key
       * @param {any} value
       * @returns {void}
       */
      add(key, value) {
        let length = key.length;
        if (length === 0)
          throw new TypeError("Unreachable");
        let index = 0, node = this;
        for (; ; ) {
          let code = key.charCodeAt(index);
          if (code > 127)
            throw new TypeError("key must be ascii string");
          if (node.code === code)
            if (length === ++index) {
              node.value = value;
              break;
            } else if (node.middle !== null)
              node = node.middle;
            else {
              node.middle = new _TstNode(key, value, index);
              break;
            }
          else if (node.code < code)
            if (node.left !== null)
              node = node.left;
            else {
              node.left = new _TstNode(key, value, index);
              break;
            }
          else if (node.right !== null)
            node = node.right;
          else {
            node.right = new _TstNode(key, value, index);
            break;
          }
        }
      }
      /**
       * @param {Uint8Array} key
       * @returns {TstNode | null}
       */
      search(key) {
        let keylength = key.length, index = 0, node = this;
        for (; node !== null && index < keylength; ) {
          let code = key[index];
          for (code <= 90 && code >= 65 && (code |= 32); node !== null; ) {
            if (code === node.code) {
              if (keylength === ++index)
                return node;
              node = node.middle;
              break;
            }
            node = node.code < code ? node.left : node.right;
          }
        }
        return null;
      }
    }, TernarySearchTree = class {
      static {
        __name(this, "TernarySearchTree");
      }
      /** @type {TstNode | null} */
      node = null;
      /**
       * @param {string} key
       * @param {any} value
       * @returns {void}
       * */
      insert(key, value) {
        this.node === null ? this.node = new TstNode(key, value, 0) : this.node.add(key, value);
      }
      /**
       * @param {Uint8Array} key
       * @returns {any}
       */
      lookup(key) {
        return this.node?.search(key)?.value ?? null;
      }
    }, tree = new TernarySearchTree();
    for (let i = 0; i < wellknownHeaderNames.length; ++i) {
      let key = headerNameLowerCasedRecord[wellknownHeaderNames[i]];
      tree.insert(key, key);
    }
    module2.exports = {
      TernarySearchTree,
      tree
    };
  }
});

// lib/core/util.js
var require_util = __commonJS({
  "lib/core/util.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { kDestroyed, kBodyUsed, kListeners, kBody } = require_symbols(), { IncomingMessage } = require("node:http"), stream = require("node:stream"), net = require("node:net"), { stringify } = require("node:querystring"), { EventEmitter: EE } = require("node:events"), timers = require_timers(), { InvalidArgumentError, ConnectTimeoutError } = require_errors(), { headerNameLowerCasedRecord } = require_constants(), { tree } = require_tree(), [nodeMajor, nodeMinor] = process.versions.node.split(".", 2).map((v) => Number(v)), BodyAsyncIterable = class {
      static {
        __name(this, "BodyAsyncIterable");
      }
      constructor(body) {
        this[kBody] = body, this[kBodyUsed] = !1;
      }
      async *[Symbol.asyncIterator]() {
        assert(!this[kBodyUsed], "disturbed"), this[kBodyUsed] = !0, yield* this[kBody];
      }
    };
    function noop() {
    }
    __name(noop, "noop");
    function wrapRequestBody(body) {
      return isStream(body) ? (bodyLength(body) === 0 && body.on("data", function() {
        assert(!1);
      }), typeof body.readableDidRead != "boolean" && (body[kBodyUsed] = !1, EE.prototype.on.call(body, "data", function() {
        this[kBodyUsed] = !0;
      })), body) : body && typeof body.pipeTo == "function" ? new BodyAsyncIterable(body) : body && typeof body != "string" && !ArrayBuffer.isView(body) && isIterable(body) ? new BodyAsyncIterable(body) : body;
    }
    __name(wrapRequestBody, "wrapRequestBody");
    function isStream(obj) {
      return obj && typeof obj == "object" && typeof obj.pipe == "function" && typeof obj.on == "function";
    }
    __name(isStream, "isStream");
    function isBlobLike(object) {
      if (object === null)
        return !1;
      if (object instanceof Blob)
        return !0;
      if (typeof object != "object")
        return !1;
      {
        let sTag = object[Symbol.toStringTag];
        return (sTag === "Blob" || sTag === "File") && ("stream" in object && typeof object.stream == "function" || "arrayBuffer" in object && typeof object.arrayBuffer == "function");
      }
    }
    __name(isBlobLike, "isBlobLike");
    function pathHasQueryOrFragment(url) {
      return url.includes("?") || url.includes("#");
    }
    __name(pathHasQueryOrFragment, "pathHasQueryOrFragment");
    function serializePathWithQuery(url, queryParams) {
      if (pathHasQueryOrFragment(url))
        throw new Error('Query params cannot be passed when url already contains "?" or "#".');
      let stringified = stringify(queryParams);
      return stringified && (url += "?" + stringified), url;
    }
    __name(serializePathWithQuery, "serializePathWithQuery");
    function isValidPort(port) {
      let value = parseInt(port, 10);
      return value === Number(port) && value >= 0 && value <= 65535;
    }
    __name(isValidPort, "isValidPort");
    function isHttpOrHttpsPrefixed(value) {
      return value != null && value[0] === "h" && value[1] === "t" && value[2] === "t" && value[3] === "p" && (value[4] === ":" || value[4] === "s" && value[5] === ":");
    }
    __name(isHttpOrHttpsPrefixed, "isHttpOrHttpsPrefixed");
    function parseURL(url) {
      if (typeof url == "string") {
        if (url = new URL(url), !isHttpOrHttpsPrefixed(url.origin || url.protocol))
          throw new InvalidArgumentError("Invalid URL protocol: the URL must start with `http:` or `https:`.");
        return url;
      }
      if (!url || typeof url != "object")
        throw new InvalidArgumentError("Invalid URL: The URL argument must be a non-null object.");
      if (!(url instanceof URL)) {
        if (url.port != null && url.port !== "" && isValidPort(url.port) === !1)
          throw new InvalidArgumentError("Invalid URL: port must be a valid integer or a string representation of an integer.");
        if (url.path != null && typeof url.path != "string")
          throw new InvalidArgumentError("Invalid URL path: the path must be a string or null/undefined.");
        if (url.pathname != null && typeof url.pathname != "string")
          throw new InvalidArgumentError("Invalid URL pathname: the pathname must be a string or null/undefined.");
        if (url.hostname != null && typeof url.hostname != "string")
          throw new InvalidArgumentError("Invalid URL hostname: the hostname must be a string or null/undefined.");
        if (url.origin != null && typeof url.origin != "string")
          throw new InvalidArgumentError("Invalid URL origin: the origin must be a string or null/undefined.");
        if (!isHttpOrHttpsPrefixed(url.origin || url.protocol))
          throw new InvalidArgumentError("Invalid URL protocol: the URL must start with `http:` or `https:`.");
        let port = url.port != null ? url.port : url.protocol === "https:" ? 443 : 80, origin = url.origin != null ? url.origin : `${url.protocol || ""}//${url.hostname || ""}:${port}`, path = url.path != null ? url.path : `${url.pathname || ""}${url.search || ""}`;
        return origin[origin.length - 1] === "/" && (origin = origin.slice(0, origin.length - 1)), path && path[0] !== "/" && (path = `/${path}`), new URL(`${origin}${path}`);
      }
      if (!isHttpOrHttpsPrefixed(url.origin || url.protocol))
        throw new InvalidArgumentError("Invalid URL protocol: the URL must start with `http:` or `https:`.");
      return url;
    }
    __name(parseURL, "parseURL");
    function parseOrigin(url) {
      if (url = parseURL(url), url.pathname !== "/" || url.search || url.hash)
        throw new InvalidArgumentError("invalid url");
      return url;
    }
    __name(parseOrigin, "parseOrigin");
    function getHostname(host) {
      if (host[0] === "[") {
        let idx2 = host.indexOf("]");
        return assert(idx2 !== -1), host.substring(1, idx2);
      }
      let idx = host.indexOf(":");
      return idx === -1 ? host : host.substring(0, idx);
    }
    __name(getHostname, "getHostname");
    function getServerName(host) {
      if (!host)
        return null;
      assert(typeof host == "string");
      let servername = getHostname(host);
      return net.isIP(servername) ? "" : servername;
    }
    __name(getServerName, "getServerName");
    function deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    }
    __name(deepClone, "deepClone");
    function isAsyncIterable(obj) {
      return obj != null && typeof obj[Symbol.asyncIterator] == "function";
    }
    __name(isAsyncIterable, "isAsyncIterable");
    function isIterable(obj) {
      return obj != null && (typeof obj[Symbol.iterator] == "function" || typeof obj[Symbol.asyncIterator] == "function");
    }
    __name(isIterable, "isIterable");
    function bodyLength(body) {
      if (body == null)
        return 0;
      if (isStream(body)) {
        let state = body._readableState;
        return state && state.objectMode === !1 && state.ended === !0 && Number.isFinite(state.length) ? state.length : null;
      } else {
        if (isBlobLike(body))
          return body.size != null ? body.size : null;
        if (isBuffer(body))
          return body.byteLength;
      }
      return null;
    }
    __name(bodyLength, "bodyLength");
    function isDestroyed(body) {
      return body && !!(body.destroyed || body[kDestroyed] || stream.isDestroyed?.(body));
    }
    __name(isDestroyed, "isDestroyed");
    function destroy(stream2, err) {
      stream2 == null || !isStream(stream2) || isDestroyed(stream2) || (typeof stream2.destroy == "function" ? (Object.getPrototypeOf(stream2).constructor === IncomingMessage && (stream2.socket = null), stream2.destroy(err)) : err && queueMicrotask(() => {
        stream2.emit("error", err);
      }), stream2.destroyed !== !0 && (stream2[kDestroyed] = !0));
    }
    __name(destroy, "destroy");
    var KEEPALIVE_TIMEOUT_EXPR = /timeout=(\d+)/;
    function parseKeepAliveTimeout(val) {
      let m = val.match(KEEPALIVE_TIMEOUT_EXPR);
      return m ? parseInt(m[1], 10) * 1e3 : null;
    }
    __name(parseKeepAliveTimeout, "parseKeepAliveTimeout");
    function headerNameToString(value) {
      return typeof value == "string" ? headerNameLowerCasedRecord[value] ?? value.toLowerCase() : tree.lookup(value) ?? value.toString("latin1").toLowerCase();
    }
    __name(headerNameToString, "headerNameToString");
    function bufferToLowerCasedHeaderName(value) {
      return tree.lookup(value) ?? value.toString("latin1").toLowerCase();
    }
    __name(bufferToLowerCasedHeaderName, "bufferToLowerCasedHeaderName");
    function parseHeaders(headers, obj) {
      obj === void 0 && (obj = {});
      for (let i = 0; i < headers.length; i += 2) {
        let key = headerNameToString(headers[i]), val = obj[key];
        if (val)
          typeof val == "string" && (val = [val], obj[key] = val), val.push(headers[i + 1].toString("utf8"));
        else {
          let headersValue = headers[i + 1];
          typeof headersValue == "string" ? obj[key] = headersValue : obj[key] = Array.isArray(headersValue) ? headersValue.map((x) => x.toString("utf8")) : headersValue.toString("utf8");
        }
      }
      return "content-length" in obj && "content-disposition" in obj && (obj["content-disposition"] = Buffer.from(obj["content-disposition"]).toString("latin1")), obj;
    }
    __name(parseHeaders, "parseHeaders");
    function parseRawHeaders(headers) {
      let headersLength = headers.length, ret = new Array(headersLength), hasContentLength = !1, contentDispositionIdx = -1, key, val, kLen = 0;
      for (let n = 0; n < headersLength; n += 2)
        key = headers[n], val = headers[n + 1], typeof key != "string" && (key = key.toString()), typeof val != "string" && (val = val.toString("utf8")), kLen = key.length, kLen === 14 && key[7] === "-" && (key === "content-length" || key.toLowerCase() === "content-length") ? hasContentLength = !0 : kLen === 19 && key[7] === "-" && (key === "content-disposition" || key.toLowerCase() === "content-disposition") && (contentDispositionIdx = n + 1), ret[n] = key, ret[n + 1] = val;
      return hasContentLength && contentDispositionIdx !== -1 && (ret[contentDispositionIdx] = Buffer.from(ret[contentDispositionIdx]).toString("latin1")), ret;
    }
    __name(parseRawHeaders, "parseRawHeaders");
    function encodeRawHeaders(headers) {
      if (!Array.isArray(headers))
        throw new TypeError("expected headers to be an array");
      return headers.map((x) => Buffer.from(x));
    }
    __name(encodeRawHeaders, "encodeRawHeaders");
    function isBuffer(buffer) {
      return buffer instanceof Uint8Array || Buffer.isBuffer(buffer);
    }
    __name(isBuffer, "isBuffer");
    function assertRequestHandler(handler, method, upgrade) {
      if (!handler || typeof handler != "object")
        throw new InvalidArgumentError("handler must be an object");
      if (typeof handler.onRequestStart != "function") {
        if (typeof handler.onConnect != "function")
          throw new InvalidArgumentError("invalid onConnect method");
        if (typeof handler.onError != "function")
          throw new InvalidArgumentError("invalid onError method");
        if (typeof handler.onBodySent != "function" && handler.onBodySent !== void 0)
          throw new InvalidArgumentError("invalid onBodySent method");
        if (upgrade || method === "CONNECT") {
          if (typeof handler.onUpgrade != "function")
            throw new InvalidArgumentError("invalid onUpgrade method");
        } else {
          if (typeof handler.onHeaders != "function")
            throw new InvalidArgumentError("invalid onHeaders method");
          if (typeof handler.onData != "function")
            throw new InvalidArgumentError("invalid onData method");
          if (typeof handler.onComplete != "function")
            throw new InvalidArgumentError("invalid onComplete method");
        }
      }
    }
    __name(assertRequestHandler, "assertRequestHandler");
    function isDisturbed(body) {
      return !!(body && (stream.isDisturbed(body) || body[kBodyUsed]));
    }
    __name(isDisturbed, "isDisturbed");
    function getSocketInfo(socket) {
      return {
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        remoteFamily: socket.remoteFamily,
        timeout: socket.timeout,
        bytesWritten: socket.bytesWritten,
        bytesRead: socket.bytesRead
      };
    }
    __name(getSocketInfo, "getSocketInfo");
    function ReadableStreamFrom(iterable) {
      let iterator;
      return new ReadableStream(
        {
          start() {
            iterator = iterable[Symbol.asyncIterator]();
          },
          pull(controller) {
            return iterator.next().then(({ done, value }) => {
              if (done)
                return queueMicrotask(() => {
                  controller.close(), controller.byobRequest?.respond(0);
                });
              {
                let buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
                return buf.byteLength ? controller.enqueue(new Uint8Array(buf)) : this.pull(controller);
              }
            });
          },
          cancel() {
            return iterator.return();
          },
          type: "bytes"
        }
      );
    }
    __name(ReadableStreamFrom, "ReadableStreamFrom");
    function isFormDataLike(object) {
      return object && typeof object == "object" && typeof object.append == "function" && typeof object.delete == "function" && typeof object.get == "function" && typeof object.getAll == "function" && typeof object.has == "function" && typeof object.set == "function" && object[Symbol.toStringTag] === "FormData";
    }
    __name(isFormDataLike, "isFormDataLike");
    function addAbortListener(signal, listener) {
      return "addEventListener" in signal ? (signal.addEventListener("abort", listener, { once: !0 }), () => signal.removeEventListener("abort", listener)) : (signal.once("abort", listener), () => signal.removeListener("abort", listener));
    }
    __name(addAbortListener, "addAbortListener");
    var validTokenChars = new Uint8Array([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0-15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16-31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32-47 (!"#$%&'()*+,-./)
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48-63 (0-9:;<=>?)
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64-79 (@A-O)
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80-95 (P-Z[\]^_)
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96-111 (`a-o)
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0,
      // 112-127 (p-z{|}~)
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 128-143
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 144-159
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 160-175
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 176-191
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 192-207
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 208-223
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 224-239
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0
      // 240-255
    ]);
    function isTokenCharCode(c) {
      return validTokenChars[c] === 1;
    }
    __name(isTokenCharCode, "isTokenCharCode");
    var tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
    function isValidHTTPToken(characters) {
      if (characters.length >= 12) return tokenRegExp.test(characters);
      if (characters.length === 0) return !1;
      for (let i = 0; i < characters.length; i++)
        if (validTokenChars[characters.charCodeAt(i)] !== 1)
          return !1;
      return !0;
    }
    __name(isValidHTTPToken, "isValidHTTPToken");
    var headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;
    function isValidHeaderValue(characters) {
      return !headerCharRegex.test(characters);
    }
    __name(isValidHeaderValue, "isValidHeaderValue");
    var rangeHeaderRegex = /^bytes (\d+)-(\d+)\/(\d+)?$/;
    function parseRangeHeader(range) {
      if (range == null || range === "") return { start: 0, end: null, size: null };
      let m = range ? range.match(rangeHeaderRegex) : null;
      return m ? {
        start: parseInt(m[1]),
        end: m[2] ? parseInt(m[2]) : null,
        size: m[3] ? parseInt(m[3]) : null
      } : null;
    }
    __name(parseRangeHeader, "parseRangeHeader");
    function addListener(obj, name, listener) {
      return (obj[kListeners] ??= []).push([name, listener]), obj.on(name, listener), obj;
    }
    __name(addListener, "addListener");
    function removeAllListeners(obj) {
      if (obj[kListeners] != null) {
        for (let [name, listener] of obj[kListeners])
          obj.removeListener(name, listener);
        obj[kListeners] = null;
      }
      return obj;
    }
    __name(removeAllListeners, "removeAllListeners");
    function errorRequest(client, request, err) {
      try {
        request.onError(err), assert(request.aborted);
      } catch (err2) {
        client.emit("error", err2);
      }
    }
    __name(errorRequest, "errorRequest");
    var setupConnectTimeout = process.platform === "win32" ? (socketWeakRef, opts) => {
      if (!opts.timeout)
        return noop;
      let s1 = null, s2 = null, fastTimer = timers.setFastTimeout(() => {
        s1 = setImmediate(() => {
          s2 = setImmediate(() => onConnectTimeout(socketWeakRef.deref(), opts));
        });
      }, opts.timeout);
      return () => {
        timers.clearFastTimeout(fastTimer), clearImmediate(s1), clearImmediate(s2);
      };
    } : (socketWeakRef, opts) => {
      if (!opts.timeout)
        return noop;
      let s1 = null, fastTimer = timers.setFastTimeout(() => {
        s1 = setImmediate(() => {
          onConnectTimeout(socketWeakRef.deref(), opts);
        });
      }, opts.timeout);
      return () => {
        timers.clearFastTimeout(fastTimer), clearImmediate(s1);
      };
    };
    function onConnectTimeout(socket, opts) {
      if (socket == null)
        return;
      let message = "Connect Timeout Error";
      Array.isArray(socket.autoSelectFamilyAttemptedAddresses) ? message += ` (attempted addresses: ${socket.autoSelectFamilyAttemptedAddresses.join(", ")},` : message += ` (attempted address: ${opts.hostname}:${opts.port},`, message += ` timeout: ${opts.timeout}ms)`, destroy(socket, new ConnectTimeoutError(message));
    }
    __name(onConnectTimeout, "onConnectTimeout");
    function getProtocolFromUrlString(urlString) {
      if (urlString[0] === "h" && urlString[1] === "t" && urlString[2] === "t" && urlString[3] === "p")
        switch (urlString[4]) {
          case ":":
            return "http:";
          case "s":
            if (urlString[5] === ":")
              return "https:";
        }
      return urlString.slice(0, urlString.indexOf(":") + 1);
    }
    __name(getProtocolFromUrlString, "getProtocolFromUrlString");
    var kEnumerableProperty = /* @__PURE__ */ Object.create(null);
    kEnumerableProperty.enumerable = !0;
    var normalizedMethodRecordsBase = {
      delete: "DELETE",
      DELETE: "DELETE",
      get: "GET",
      GET: "GET",
      head: "HEAD",
      HEAD: "HEAD",
      options: "OPTIONS",
      OPTIONS: "OPTIONS",
      post: "POST",
      POST: "POST",
      put: "PUT",
      PUT: "PUT"
    }, normalizedMethodRecords = {
      ...normalizedMethodRecordsBase,
      patch: "patch",
      PATCH: "PATCH"
    };
    Object.setPrototypeOf(normalizedMethodRecordsBase, null);
    Object.setPrototypeOf(normalizedMethodRecords, null);
    module2.exports = {
      kEnumerableProperty,
      isDisturbed,
      isBlobLike,
      parseOrigin,
      parseURL,
      getServerName,
      isStream,
      isIterable,
      isAsyncIterable,
      isDestroyed,
      headerNameToString,
      bufferToLowerCasedHeaderName,
      addListener,
      removeAllListeners,
      errorRequest,
      parseRawHeaders,
      encodeRawHeaders,
      parseHeaders,
      parseKeepAliveTimeout,
      destroy,
      bodyLength,
      deepClone,
      ReadableStreamFrom,
      isBuffer,
      assertRequestHandler,
      getSocketInfo,
      isFormDataLike,
      pathHasQueryOrFragment,
      serializePathWithQuery,
      addAbortListener,
      isValidHTTPToken,
      isValidHeaderValue,
      isTokenCharCode,
      parseRangeHeader,
      normalizedMethodRecordsBase,
      normalizedMethodRecords,
      isValidPort,
      isHttpOrHttpsPrefixed,
      nodeMajor,
      nodeMinor,
      safeHTTPMethods: Object.freeze(["GET", "HEAD", "OPTIONS", "TRACE"]),
      wrapRequestBody,
      setupConnectTimeout,
      getProtocolFromUrlString
    };
  }
});

// lib/handler/unwrap-handler.js
var require_unwrap_handler = __commonJS({
  "lib/handler/unwrap-handler.js"(exports2, module2) {
    "use strict";
    var { parseHeaders } = require_util(), { InvalidArgumentError } = require_errors(), kResume = Symbol("resume"), UnwrapController = class {
      static {
        __name(this, "UnwrapController");
      }
      #paused = !1;
      #reason = null;
      #aborted = !1;
      #abort;
      [kResume] = null;
      constructor(abort) {
        this.#abort = abort;
      }
      pause() {
        this.#paused = !0;
      }
      resume() {
        this.#paused && (this.#paused = !1, this[kResume]?.());
      }
      abort(reason) {
        this.#aborted || (this.#aborted = !0, this.#reason = reason, this.#abort(reason));
      }
      get aborted() {
        return this.#aborted;
      }
      get reason() {
        return this.#reason;
      }
      get paused() {
        return this.#paused;
      }
    };
    module2.exports = class UnwrapHandler {
      static {
        __name(this, "UnwrapHandler");
      }
      #handler;
      #controller;
      constructor(handler) {
        this.#handler = handler;
      }
      static unwrap(handler) {
        return handler.onRequestStart ? new UnwrapHandler(handler) : handler;
      }
      onConnect(abort, context) {
        this.#controller = new UnwrapController(abort), this.#handler.onRequestStart?.(this.#controller, context);
      }
      onUpgrade(statusCode, rawHeaders, socket) {
        this.#handler.onRequestUpgrade?.(this.#controller, statusCode, parseHeaders(rawHeaders), socket);
      }
      onHeaders(statusCode, rawHeaders, resume, statusMessage) {
        return this.#controller[kResume] = resume, this.#handler.onResponseStart?.(this.#controller, statusCode, parseHeaders(rawHeaders), statusMessage), !this.#controller.paused;
      }
      onData(data) {
        return this.#handler.onResponseData?.(this.#controller, data), !this.#controller.paused;
      }
      onComplete(rawTrailers) {
        this.#handler.onResponseEnd?.(this.#controller, parseHeaders(rawTrailers));
      }
      onError(err) {
        if (!this.#handler.onResponseError)
          throw new InvalidArgumentError("invalid onError method");
        this.#handler.onResponseError?.(this.#controller, err);
      }
    };
  }
});

// lib/dispatcher/dispatcher-base.js
var require_dispatcher_base = __commonJS({
  "lib/dispatcher/dispatcher-base.js"(exports2, module2) {
    "use strict";
    var Dispatcher2 = require_dispatcher(), UnwrapHandler = require_unwrap_handler(), {
      ClientDestroyedError,
      ClientClosedError,
      InvalidArgumentError
    } = require_errors(), { kDestroy, kClose, kClosed, kDestroyed, kDispatch } = require_symbols(), kOnDestroyed = Symbol("onDestroyed"), kOnClosed = Symbol("onClosed"), DispatcherBase = class extends Dispatcher2 {
      static {
        __name(this, "DispatcherBase");
      }
      /** @type {boolean} */
      [kDestroyed] = !1;
      /** @type {Array<Function|null} */
      [kOnDestroyed] = null;
      /** @type {boolean} */
      [kClosed] = !1;
      /** @type {Array<Function>|null} */
      [kOnClosed] = null;
      /** @returns {boolean} */
      get destroyed() {
        return this[kDestroyed];
      }
      /** @returns {boolean} */
      get closed() {
        return this[kClosed];
      }
      close(callback) {
        if (callback === void 0)
          return new Promise((resolve, reject) => {
            this.close((err, data) => err ? reject(err) : resolve(data));
          });
        if (typeof callback != "function")
          throw new InvalidArgumentError("invalid callback");
        if (this[kDestroyed]) {
          let err = new ClientDestroyedError();
          queueMicrotask(() => callback(err, null));
          return;
        }
        if (this[kClosed]) {
          this[kOnClosed] ? this[kOnClosed].push(callback) : queueMicrotask(() => callback(null, null));
          return;
        }
        this[kClosed] = !0, this[kOnClosed] ??= [], this[kOnClosed].push(callback);
        let onClosed = /* @__PURE__ */ __name(() => {
          let callbacks = this[kOnClosed];
          this[kOnClosed] = null;
          for (let i = 0; i < callbacks.length; i++)
            callbacks[i](null, null);
        }, "onClosed");
        this[kClose]().then(() => this.destroy()).then(() => queueMicrotask(onClosed));
      }
      destroy(err, callback) {
        if (typeof err == "function" && (callback = err, err = null), callback === void 0)
          return new Promise((resolve, reject) => {
            this.destroy(err, (err2, data) => err2 ? reject(err2) : resolve(data));
          });
        if (typeof callback != "function")
          throw new InvalidArgumentError("invalid callback");
        if (this[kDestroyed]) {
          this[kOnDestroyed] ? this[kOnDestroyed].push(callback) : queueMicrotask(() => callback(null, null));
          return;
        }
        err || (err = new ClientDestroyedError()), this[kDestroyed] = !0, this[kOnDestroyed] ??= [], this[kOnDestroyed].push(callback);
        let onDestroyed = /* @__PURE__ */ __name(() => {
          let callbacks = this[kOnDestroyed];
          this[kOnDestroyed] = null;
          for (let i = 0; i < callbacks.length; i++)
            callbacks[i](null, null);
        }, "onDestroyed");
        this[kDestroy](err).then(() => queueMicrotask(onDestroyed));
      }
      dispatch(opts, handler) {
        if (!handler || typeof handler != "object")
          throw new InvalidArgumentError("handler must be an object");
        handler = UnwrapHandler.unwrap(handler);
        try {
          if (!opts || typeof opts != "object")
            throw new InvalidArgumentError("opts must be an object.");
          if (this[kDestroyed] || this[kOnDestroyed])
            throw new ClientDestroyedError();
          if (this[kClosed])
            throw new ClientClosedError();
          return this[kDispatch](opts, handler);
        } catch (err) {
          if (typeof handler.onError != "function")
            throw err;
          return handler.onError(err), !1;
        }
      }
    };
    module2.exports = DispatcherBase;
  }
});

// lib/util/stats.js
var require_stats = __commonJS({
  "lib/util/stats.js"(exports2, module2) {
    "use strict";
    var {
      kConnected,
      kPending,
      kRunning,
      kSize,
      kFree,
      kQueued
    } = require_symbols(), ClientStats = class {
      static {
        __name(this, "ClientStats");
      }
      constructor(client) {
        this.connected = client[kConnected], this.pending = client[kPending], this.running = client[kRunning], this.size = client[kSize];
      }
    }, PoolStats = class {
      static {
        __name(this, "PoolStats");
      }
      constructor(pool) {
        this.connected = pool[kConnected], this.free = pool[kFree], this.pending = pool[kPending], this.queued = pool[kQueued], this.running = pool[kRunning], this.size = pool[kSize];
      }
    };
    module2.exports = { ClientStats, PoolStats };
  }
});

// lib/dispatcher/fixed-queue.js
var require_fixed_queue = __commonJS({
  "lib/dispatcher/fixed-queue.js"(exports2, module2) {
    "use strict";
    var FixedCircularBuffer = class {
      static {
        __name(this, "FixedCircularBuffer");
      }
      /** @type {number} */
      bottom = 0;
      /** @type {number} */
      top = 0;
      /** @type {Array<T|undefined>} */
      list = new Array(2048).fill(void 0);
      /** @type {T|null} */
      next = null;
      /** @returns {boolean} */
      isEmpty() {
        return this.top === this.bottom;
      }
      /** @returns {boolean} */
      isFull() {
        return (this.top + 1 & 2047) === this.bottom;
      }
      /**
       * @param {T} data
       * @returns {void}
       */
      push(data) {
        this.list[this.top] = data, this.top = this.top + 1 & 2047;
      }
      /** @returns {T|null} */
      shift() {
        let nextItem = this.list[this.bottom];
        return nextItem === void 0 ? null : (this.list[this.bottom] = void 0, this.bottom = this.bottom + 1 & 2047, nextItem);
      }
    };
    module2.exports = class {
      static {
        __name(this, "FixedQueue");
      }
      constructor() {
        this.head = this.tail = new FixedCircularBuffer();
      }
      /** @returns {boolean} */
      isEmpty() {
        return this.head.isEmpty();
      }
      /** @param {T} data */
      push(data) {
        this.head.isFull() && (this.head = this.head.next = new FixedCircularBuffer()), this.head.push(data);
      }
      /** @returns {T|null} */
      shift() {
        let tail = this.tail, next = tail.shift();
        return tail.isEmpty() && tail.next !== null && (this.tail = tail.next, tail.next = null), next;
      }
    };
  }
});

// lib/dispatcher/pool-base.js
var require_pool_base = __commonJS({
  "lib/dispatcher/pool-base.js"(exports2, module2) {
    "use strict";
    var { PoolStats } = require_stats(), DispatcherBase = require_dispatcher_base(), FixedQueue = require_fixed_queue(), { kConnected, kSize, kRunning, kPending, kQueued, kBusy, kFree, kUrl, kClose, kDestroy, kDispatch } = require_symbols(), kClients = Symbol("clients"), kNeedDrain = Symbol("needDrain"), kQueue = Symbol("queue"), kClosedResolve = Symbol("closed resolve"), kOnDrain = Symbol("onDrain"), kOnConnect = Symbol("onConnect"), kOnDisconnect = Symbol("onDisconnect"), kOnConnectionError = Symbol("onConnectionError"), kGetDispatcher = Symbol("get dispatcher"), kAddClient = Symbol("add client"), kRemoveClient = Symbol("remove client"), PoolBase = class extends DispatcherBase {
      static {
        __name(this, "PoolBase");
      }
      [kQueue] = new FixedQueue();
      [kQueued] = 0;
      [kClients] = [];
      [kNeedDrain] = !1;
      [kOnDrain](client, origin, targets) {
        let queue = this[kQueue], needDrain = !1;
        for (; !needDrain; ) {
          let item = queue.shift();
          if (!item)
            break;
          this[kQueued]--, needDrain = !client.dispatch(item.opts, item.handler);
        }
        if (client[kNeedDrain] = needDrain, !needDrain && this[kNeedDrain] && (this[kNeedDrain] = !1, this.emit("drain", origin, [this, ...targets])), this[kClosedResolve] && queue.isEmpty()) {
          let closeAll = new Array(this[kClients].length);
          for (let i = 0; i < this[kClients].length; i++)
            closeAll[i] = this[kClients][i].close();
          return Promise.all(closeAll).then(this[kClosedResolve]);
        }
      }
      [kOnConnect] = (origin, targets) => {
        this.emit("connect", origin, [this, ...targets]);
      };
      [kOnDisconnect] = (origin, targets, err) => {
        this.emit("disconnect", origin, [this, ...targets], err);
      };
      [kOnConnectionError] = (origin, targets, err) => {
        this.emit("connectionError", origin, [this, ...targets], err);
      };
      get [kBusy]() {
        return this[kNeedDrain];
      }
      get [kConnected]() {
        let ret = 0;
        for (let { [kConnected]: connected } of this[kClients])
          ret += connected;
        return ret;
      }
      get [kFree]() {
        let ret = 0;
        for (let { [kConnected]: connected, [kNeedDrain]: needDrain } of this[kClients])
          ret += connected && !needDrain;
        return ret;
      }
      get [kPending]() {
        let ret = this[kQueued];
        for (let { [kPending]: pending } of this[kClients])
          ret += pending;
        return ret;
      }
      get [kRunning]() {
        let ret = 0;
        for (let { [kRunning]: running } of this[kClients])
          ret += running;
        return ret;
      }
      get [kSize]() {
        let ret = this[kQueued];
        for (let { [kSize]: size } of this[kClients])
          ret += size;
        return ret;
      }
      get stats() {
        return new PoolStats(this);
      }
      [kClose]() {
        if (this[kQueue].isEmpty()) {
          let closeAll = new Array(this[kClients].length);
          for (let i = 0; i < this[kClients].length; i++)
            closeAll[i] = this[kClients][i].close();
          return Promise.all(closeAll);
        } else
          return new Promise((resolve) => {
            this[kClosedResolve] = resolve;
          });
      }
      [kDestroy](err) {
        for (; ; ) {
          let item = this[kQueue].shift();
          if (!item)
            break;
          item.handler.onError(err);
        }
        let destroyAll = new Array(this[kClients].length);
        for (let i = 0; i < this[kClients].length; i++)
          destroyAll[i] = this[kClients][i].destroy(err);
        return Promise.all(destroyAll);
      }
      [kDispatch](opts, handler) {
        let dispatcher = this[kGetDispatcher]();
        return dispatcher ? dispatcher.dispatch(opts, handler) || (dispatcher[kNeedDrain] = !0, this[kNeedDrain] = !this[kGetDispatcher]()) : (this[kNeedDrain] = !0, this[kQueue].push({ opts, handler }), this[kQueued]++), !this[kNeedDrain];
      }
      [kAddClient](client) {
        return client.on("drain", this[kOnDrain].bind(this, client)).on("connect", this[kOnConnect]).on("disconnect", this[kOnDisconnect]).on("connectionError", this[kOnConnectionError]), this[kClients].push(client), this[kNeedDrain] && queueMicrotask(() => {
          this[kNeedDrain] && this[kOnDrain](client, client[kUrl], [client, this]);
        }), this;
      }
      [kRemoveClient](client) {
        client.close(() => {
          let idx = this[kClients].indexOf(client);
          idx !== -1 && this[kClients].splice(idx, 1);
        }), this[kNeedDrain] = this[kClients].some((dispatcher) => !dispatcher[kNeedDrain] && dispatcher.closed !== !0 && dispatcher.destroyed !== !0);
      }
    };
    module2.exports = {
      PoolBase,
      kClients,
      kNeedDrain,
      kAddClient,
      kRemoveClient,
      kGetDispatcher
    };
  }
});

// lib/core/diagnostics.js
var require_diagnostics = __commonJS({
  "lib/core/diagnostics.js"(exports2, module2) {
    "use strict";
    var diagnosticsChannel = require("node:diagnostics_channel"), util = require("node:util"), undiciDebugLog = util.debuglog("undici"), fetchDebuglog = util.debuglog("fetch"), websocketDebuglog = util.debuglog("websocket"), channels = {
      // Client
      beforeConnect: diagnosticsChannel.channel("undici:client:beforeConnect"),
      connected: diagnosticsChannel.channel("undici:client:connected"),
      connectError: diagnosticsChannel.channel("undici:client:connectError"),
      sendHeaders: diagnosticsChannel.channel("undici:client:sendHeaders"),
      // Request
      create: diagnosticsChannel.channel("undici:request:create"),
      bodySent: diagnosticsChannel.channel("undici:request:bodySent"),
      bodyChunkSent: diagnosticsChannel.channel("undici:request:bodyChunkSent"),
      bodyChunkReceived: diagnosticsChannel.channel("undici:request:bodyChunkReceived"),
      headers: diagnosticsChannel.channel("undici:request:headers"),
      trailers: diagnosticsChannel.channel("undici:request:trailers"),
      error: diagnosticsChannel.channel("undici:request:error"),
      // WebSocket
      open: diagnosticsChannel.channel("undici:websocket:open"),
      close: diagnosticsChannel.channel("undici:websocket:close"),
      socketError: diagnosticsChannel.channel("undici:websocket:socket_error"),
      ping: diagnosticsChannel.channel("undici:websocket:ping"),
      pong: diagnosticsChannel.channel("undici:websocket:pong"),
      // ProxyAgent
      proxyConnected: diagnosticsChannel.channel("undici:proxy:connected")
    }, isTrackingClientEvents = !1;
    function trackClientEvents(debugLog = undiciDebugLog) {
      if (!isTrackingClientEvents) {
        if (channels.beforeConnect.hasSubscribers || channels.connected.hasSubscribers || channels.connectError.hasSubscribers || channels.sendHeaders.hasSubscribers) {
          isTrackingClientEvents = !0;
          return;
        }
        isTrackingClientEvents = !0, diagnosticsChannel.subscribe(
          "undici:client:beforeConnect",
          (evt) => {
            let {
              connectParams: { version, protocol, port, host }
            } = evt;
            debugLog(
              "connecting to %s%s using %s%s",
              host,
              port ? `:${port}` : "",
              protocol,
              version
            );
          }
        ), diagnosticsChannel.subscribe(
          "undici:client:connected",
          (evt) => {
            let {
              connectParams: { version, protocol, port, host }
            } = evt;
            debugLog(
              "connected to %s%s using %s%s",
              host,
              port ? `:${port}` : "",
              protocol,
              version
            );
          }
        ), diagnosticsChannel.subscribe(
          "undici:client:connectError",
          (evt) => {
            let {
              connectParams: { version, protocol, port, host },
              error
            } = evt;
            debugLog(
              "connection to %s%s using %s%s errored - %s",
              host,
              port ? `:${port}` : "",
              protocol,
              version,
              error.message
            );
          }
        ), diagnosticsChannel.subscribe(
          "undici:client:sendHeaders",
          (evt) => {
            let {
              request: { method, path, origin }
            } = evt;
            debugLog("sending request to %s %s%s", method, origin, path);
          }
        );
      }
    }
    __name(trackClientEvents, "trackClientEvents");
    var isTrackingRequestEvents = !1;
    function trackRequestEvents(debugLog = undiciDebugLog) {
      if (!isTrackingRequestEvents) {
        if (channels.headers.hasSubscribers || channels.trailers.hasSubscribers || channels.error.hasSubscribers) {
          isTrackingRequestEvents = !0;
          return;
        }
        isTrackingRequestEvents = !0, diagnosticsChannel.subscribe(
          "undici:request:headers",
          (evt) => {
            let {
              request: { method, path, origin },
              response: { statusCode }
            } = evt;
            debugLog(
              "received response to %s %s%s - HTTP %d",
              method,
              origin,
              path,
              statusCode
            );
          }
        ), diagnosticsChannel.subscribe(
          "undici:request:trailers",
          (evt) => {
            let {
              request: { method, path, origin }
            } = evt;
            debugLog("trailers received from %s %s%s", method, origin, path);
          }
        ), diagnosticsChannel.subscribe(
          "undici:request:error",
          (evt) => {
            let {
              request: { method, path, origin },
              error
            } = evt;
            debugLog(
              "request to %s %s%s errored - %s",
              method,
              origin,
              path,
              error.message
            );
          }
        );
      }
    }
    __name(trackRequestEvents, "trackRequestEvents");
    var isTrackingWebSocketEvents = !1;
    function trackWebSocketEvents(debugLog = websocketDebuglog) {
      if (!isTrackingWebSocketEvents) {
        if (channels.open.hasSubscribers || channels.close.hasSubscribers || channels.socketError.hasSubscribers || channels.ping.hasSubscribers || channels.pong.hasSubscribers) {
          isTrackingWebSocketEvents = !0;
          return;
        }
        isTrackingWebSocketEvents = !0, diagnosticsChannel.subscribe(
          "undici:websocket:open",
          (evt) => {
            let {
              address: { address, port }
            } = evt;
            debugLog("connection opened %s%s", address, port ? `:${port}` : "");
          }
        ), diagnosticsChannel.subscribe(
          "undici:websocket:close",
          (evt) => {
            let { websocket, code, reason } = evt;
            debugLog(
              "closed connection to %s - %s %s",
              websocket.url,
              code,
              reason
            );
          }
        ), diagnosticsChannel.subscribe(
          "undici:websocket:socket_error",
          (err) => {
            debugLog("connection errored - %s", err.message);
          }
        ), diagnosticsChannel.subscribe(
          "undici:websocket:ping",
          (evt) => {
            debugLog("ping received");
          }
        ), diagnosticsChannel.subscribe(
          "undici:websocket:pong",
          (evt) => {
            debugLog("pong received");
          }
        );
      }
    }
    __name(trackWebSocketEvents, "trackWebSocketEvents");
    (undiciDebugLog.enabled || fetchDebuglog.enabled) && (trackClientEvents(fetchDebuglog.enabled ? fetchDebuglog : undiciDebugLog), trackRequestEvents(fetchDebuglog.enabled ? fetchDebuglog : undiciDebugLog));
    websocketDebuglog.enabled && (trackClientEvents(undiciDebugLog.enabled ? undiciDebugLog : websocketDebuglog), trackWebSocketEvents(websocketDebuglog));
    module2.exports = {
      channels
    };
  }
});

// lib/core/request.js
var require_request = __commonJS({
  "lib/core/request.js"(exports2, module2) {
    "use strict";
    var {
      InvalidArgumentError,
      NotSupportedError
    } = require_errors(), assert = require("node:assert"), {
      isValidHTTPToken,
      isValidHeaderValue,
      isStream,
      destroy,
      isBuffer,
      isFormDataLike,
      isIterable,
      isBlobLike,
      serializePathWithQuery,
      assertRequestHandler,
      getServerName,
      normalizedMethodRecords,
      getProtocolFromUrlString
    } = require_util(), { channels } = require_diagnostics(), { headerNameLowerCasedRecord } = require_constants(), invalidPathRegex = /[^\u0021-\u00ff]/, kHandler = Symbol("handler"), Request = class {
      static {
        __name(this, "Request");
      }
      constructor(origin, {
        path,
        method,
        body,
        headers,
        query,
        idempotent,
        blocking,
        upgrade,
        headersTimeout,
        bodyTimeout,
        reset,
        expectContinue,
        servername,
        throwOnError,
        maxRedirections
      }, handler) {
        if (typeof path != "string")
          throw new InvalidArgumentError("path must be a string");
        if (path[0] !== "/" && !(path.startsWith("http://") || path.startsWith("https://")) && method !== "CONNECT")
          throw new InvalidArgumentError("path must be an absolute URL or start with a slash");
        if (invalidPathRegex.test(path))
          throw new InvalidArgumentError("invalid request path");
        if (typeof method != "string")
          throw new InvalidArgumentError("method must be a string");
        if (normalizedMethodRecords[method] === void 0 && !isValidHTTPToken(method))
          throw new InvalidArgumentError("invalid request method");
        if (upgrade && typeof upgrade != "string")
          throw new InvalidArgumentError("upgrade must be a string");
        if (headersTimeout != null && (!Number.isFinite(headersTimeout) || headersTimeout < 0))
          throw new InvalidArgumentError("invalid headersTimeout");
        if (bodyTimeout != null && (!Number.isFinite(bodyTimeout) || bodyTimeout < 0))
          throw new InvalidArgumentError("invalid bodyTimeout");
        if (reset != null && typeof reset != "boolean")
          throw new InvalidArgumentError("invalid reset");
        if (expectContinue != null && typeof expectContinue != "boolean")
          throw new InvalidArgumentError("invalid expectContinue");
        if (throwOnError != null)
          throw new InvalidArgumentError("invalid throwOnError");
        if (maxRedirections != null && maxRedirections !== 0)
          throw new InvalidArgumentError("maxRedirections is not supported, use the redirect interceptor");
        if (this.headersTimeout = headersTimeout, this.bodyTimeout = bodyTimeout, this.method = method, this.abort = null, body == null)
          this.body = null;
        else if (isStream(body)) {
          this.body = body;
          let rState = this.body._readableState;
          (!rState || !rState.autoDestroy) && (this.endHandler = /* @__PURE__ */ __name(function() {
            destroy(this);
          }, "autoDestroy"), this.body.on("end", this.endHandler)), this.errorHandler = (err) => {
            this.abort ? this.abort(err) : this.error = err;
          }, this.body.on("error", this.errorHandler);
        } else if (isBuffer(body))
          this.body = body.byteLength ? body : null;
        else if (ArrayBuffer.isView(body))
          this.body = body.buffer.byteLength ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : null;
        else if (body instanceof ArrayBuffer)
          this.body = body.byteLength ? Buffer.from(body) : null;
        else if (typeof body == "string")
          this.body = body.length ? Buffer.from(body) : null;
        else if (isFormDataLike(body) || isIterable(body) || isBlobLike(body))
          this.body = body;
        else
          throw new InvalidArgumentError("body must be a string, a Buffer, a Readable stream, an iterable, or an async iterable");
        if (this.completed = !1, this.aborted = !1, this.upgrade = upgrade || null, this.path = query ? serializePathWithQuery(path, query) : path, this.origin = origin, this.protocol = getProtocolFromUrlString(origin), this.idempotent = idempotent ?? (method === "HEAD" || method === "GET"), this.blocking = blocking ?? this.method !== "HEAD", this.reset = reset ?? null, this.host = null, this.contentLength = null, this.contentType = null, this.headers = [], this.expectContinue = expectContinue ?? !1, Array.isArray(headers)) {
          if (headers.length % 2 !== 0)
            throw new InvalidArgumentError("headers array must be even");
          for (let i = 0; i < headers.length; i += 2)
            processHeader(this, headers[i], headers[i + 1]);
        } else if (headers && typeof headers == "object")
          if (headers[Symbol.iterator])
            for (let header of headers) {
              if (!Array.isArray(header) || header.length !== 2)
                throw new InvalidArgumentError("headers must be in key-value pair format");
              processHeader(this, header[0], header[1]);
            }
          else {
            let keys = Object.keys(headers);
            for (let i = 0; i < keys.length; ++i)
              processHeader(this, keys[i], headers[keys[i]]);
          }
        else if (headers != null)
          throw new InvalidArgumentError("headers must be an object or an array");
        assertRequestHandler(handler, method, upgrade), this.servername = servername || getServerName(this.host) || null, this[kHandler] = handler, channels.create.hasSubscribers && channels.create.publish({ request: this });
      }
      onBodySent(chunk) {
        if (channels.bodyChunkSent.hasSubscribers && channels.bodyChunkSent.publish({ request: this, chunk }), this[kHandler].onBodySent)
          try {
            return this[kHandler].onBodySent(chunk);
          } catch (err) {
            this.abort(err);
          }
      }
      onRequestSent() {
        if (channels.bodySent.hasSubscribers && channels.bodySent.publish({ request: this }), this[kHandler].onRequestSent)
          try {
            return this[kHandler].onRequestSent();
          } catch (err) {
            this.abort(err);
          }
      }
      onConnect(abort) {
        if (assert(!this.aborted), assert(!this.completed), this.error)
          abort(this.error);
        else
          return this.abort = abort, this[kHandler].onConnect(abort);
      }
      onResponseStarted() {
        return this[kHandler].onResponseStarted?.();
      }
      onHeaders(statusCode, headers, resume, statusText) {
        assert(!this.aborted), assert(!this.completed), channels.headers.hasSubscribers && channels.headers.publish({ request: this, response: { statusCode, headers, statusText } });
        try {
          return this[kHandler].onHeaders(statusCode, headers, resume, statusText);
        } catch (err) {
          this.abort(err);
        }
      }
      onData(chunk) {
        assert(!this.aborted), assert(!this.completed), channels.bodyChunkReceived.hasSubscribers && channels.bodyChunkReceived.publish({ request: this, chunk });
        try {
          return this[kHandler].onData(chunk);
        } catch (err) {
          return this.abort(err), !1;
        }
      }
      onUpgrade(statusCode, headers, socket) {
        return assert(!this.aborted), assert(!this.completed), this[kHandler].onUpgrade(statusCode, headers, socket);
      }
      onComplete(trailers) {
        this.onFinally(), assert(!this.aborted), assert(!this.completed), this.completed = !0, channels.trailers.hasSubscribers && channels.trailers.publish({ request: this, trailers });
        try {
          return this[kHandler].onComplete(trailers);
        } catch (err) {
          this.onError(err);
        }
      }
      onError(error) {
        if (this.onFinally(), channels.error.hasSubscribers && channels.error.publish({ request: this, error }), !this.aborted)
          return this.aborted = !0, this[kHandler].onError(error);
      }
      onFinally() {
        this.errorHandler && (this.body.off("error", this.errorHandler), this.errorHandler = null), this.endHandler && (this.body.off("end", this.endHandler), this.endHandler = null);
      }
      addHeader(key, value) {
        return processHeader(this, key, value), this;
      }
    };
    function processHeader(request, key, val) {
      if (val && typeof val == "object" && !Array.isArray(val))
        throw new InvalidArgumentError(`invalid ${key} header`);
      if (val === void 0)
        return;
      let headerName = headerNameLowerCasedRecord[key];
      if (headerName === void 0 && (headerName = key.toLowerCase(), headerNameLowerCasedRecord[headerName] === void 0 && !isValidHTTPToken(headerName)))
        throw new InvalidArgumentError("invalid header key");
      if (Array.isArray(val)) {
        let arr = [];
        for (let i = 0; i < val.length; i++)
          if (typeof val[i] == "string") {
            if (!isValidHeaderValue(val[i]))
              throw new InvalidArgumentError(`invalid ${key} header`);
            arr.push(val[i]);
          } else if (val[i] === null)
            arr.push("");
          else {
            if (typeof val[i] == "object")
              throw new InvalidArgumentError(`invalid ${key} header`);
            arr.push(`${val[i]}`);
          }
        val = arr;
      } else if (typeof val == "string") {
        if (!isValidHeaderValue(val))
          throw new InvalidArgumentError(`invalid ${key} header`);
      } else val === null ? val = "" : val = `${val}`;
      if (request.host === null && headerName === "host") {
        if (typeof val != "string")
          throw new InvalidArgumentError("invalid host header");
        request.host = val;
      } else if (request.contentLength === null && headerName === "content-length") {
        if (request.contentLength = parseInt(val, 10), !Number.isFinite(request.contentLength))
          throw new InvalidArgumentError("invalid content-length header");
      } else if (request.contentType === null && headerName === "content-type")
        request.contentType = val, request.headers.push(key, val);
      else {
        if (headerName === "transfer-encoding" || headerName === "keep-alive" || headerName === "upgrade")
          throw new InvalidArgumentError(`invalid ${headerName} header`);
        if (headerName === "connection") {
          let value = typeof val == "string" ? val.toLowerCase() : null;
          if (value !== "close" && value !== "keep-alive")
            throw new InvalidArgumentError("invalid connection header");
          value === "close" && (request.reset = !0);
        } else {
          if (headerName === "expect")
            throw new NotSupportedError("expect header not supported");
          request.headers.push(key, val);
        }
      }
    }
    __name(processHeader, "processHeader");
    module2.exports = Request;
  }
});

// lib/core/connect.js
var require_connect = __commonJS({
  "lib/core/connect.js"(exports2, module2) {
    "use strict";
    var net = require("node:net"), assert = require("node:assert"), util = require_util(), { InvalidArgumentError } = require_errors(), tls, SessionCache = class {
      static {
        __name(this, "WeakSessionCache");
      }
      constructor(maxCachedSessions) {
        this._maxCachedSessions = maxCachedSessions, this._sessionCache = /* @__PURE__ */ new Map(), this._sessionRegistry = new FinalizationRegistry((key) => {
          if (this._sessionCache.size < this._maxCachedSessions)
            return;
          let ref = this._sessionCache.get(key);
          ref !== void 0 && ref.deref() === void 0 && this._sessionCache.delete(key);
        });
      }
      get(sessionKey) {
        let ref = this._sessionCache.get(sessionKey);
        return ref ? ref.deref() : null;
      }
      set(sessionKey, session) {
        this._maxCachedSessions !== 0 && (this._sessionCache.set(sessionKey, new WeakRef(session)), this._sessionRegistry.register(session, sessionKey));
      }
    };
    function buildConnector({ allowH2, useH2c, maxCachedSessions, socketPath, timeout, session: customSession, ...opts }) {
      if (maxCachedSessions != null && (!Number.isInteger(maxCachedSessions) || maxCachedSessions < 0))
        throw new InvalidArgumentError("maxCachedSessions must be a positive integer or zero");
      let options = { path: socketPath, ...opts }, sessionCache = new SessionCache(maxCachedSessions ?? 100);
      return timeout = timeout ?? 1e4, allowH2 = allowH2 ?? !1, /* @__PURE__ */ __name(function({ hostname, host, protocol, port, servername, localAddress, httpSocket }, callback) {
        let socket;
        if (protocol === "https:") {
          tls || (tls = require("node:tls")), servername = servername || options.servername || util.getServerName(host) || null;
          let sessionKey = servername || hostname;
          assert(sessionKey);
          let session = customSession || sessionCache.get(sessionKey) || null;
          port = port || 443, socket = tls.connect({
            highWaterMark: 16384,
            // TLS in node can't have bigger HWM anyway...
            ...options,
            servername,
            session,
            localAddress,
            ALPNProtocols: allowH2 ? ["http/1.1", "h2"] : ["http/1.1"],
            socket: httpSocket,
            // upgrade socket connection
            port,
            host: hostname
          }), socket.on("session", function(session2) {
            sessionCache.set(sessionKey, session2);
          });
        } else
          assert(!httpSocket, "httpSocket can only be sent on TLS update"), port = port || 80, socket = net.connect({
            highWaterMark: 64 * 1024,
            // Same as nodejs fs streams.
            ...options,
            localAddress,
            port,
            host: hostname
          }), useH2c === !0 && (socket.alpnProtocol = "h2");
        if (options.keepAlive == null || options.keepAlive) {
          let keepAliveInitialDelay = options.keepAliveInitialDelay === void 0 ? 6e4 : options.keepAliveInitialDelay;
          socket.setKeepAlive(!0, keepAliveInitialDelay);
        }
        let clearConnectTimeout = util.setupConnectTimeout(new WeakRef(socket), { timeout, hostname, port });
        return socket.setNoDelay(!0).once(protocol === "https:" ? "secureConnect" : "connect", function() {
          if (queueMicrotask(clearConnectTimeout), callback) {
            let cb = callback;
            callback = null, cb(null, this);
          }
        }).on("error", function(err) {
          if (queueMicrotask(clearConnectTimeout), callback) {
            let cb = callback;
            callback = null, cb(err);
          }
        }), socket;
      }, "connect");
    }
    __name(buildConnector, "buildConnector");
    module2.exports = buildConnector;
  }
});

// lib/llhttp/utils.js
var require_utils = __commonJS({
  "lib/llhttp/utils.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: !0 });
    exports2.enumToMap = enumToMap;
    function enumToMap(obj, filter = [], exceptions = []) {
      let emptyFilter = (filter?.length ?? 0) === 0, emptyExceptions = (exceptions?.length ?? 0) === 0;
      return Object.fromEntries(Object.entries(obj).filter(([, value]) => typeof value == "number" && (emptyFilter || filter.includes(value)) && (emptyExceptions || !exceptions.includes(value))));
    }
    __name(enumToMap, "enumToMap");
  }
});

// lib/llhttp/constants.js
var require_constants2 = __commonJS({
  "lib/llhttp/constants.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: !0 });
    exports2.SPECIAL_HEADERS = exports2.MINOR = exports2.MAJOR = exports2.HTAB_SP_VCHAR_OBS_TEXT = exports2.QUOTED_STRING = exports2.CONNECTION_TOKEN_CHARS = exports2.HEADER_CHARS = exports2.TOKEN = exports2.HEX = exports2.URL_CHAR = exports2.USERINFO_CHARS = exports2.MARK = exports2.ALPHANUM = exports2.NUM = exports2.HEX_MAP = exports2.NUM_MAP = exports2.ALPHA = exports2.STATUSES_HTTP = exports2.H_METHOD_MAP = exports2.METHOD_MAP = exports2.METHODS_RTSP = exports2.METHODS_ICE = exports2.METHODS_HTTP = exports2.HEADER_STATE = exports2.FINISH = exports2.STATUSES = exports2.METHODS = exports2.LENIENT_FLAGS = exports2.FLAGS = exports2.TYPE = exports2.ERROR = void 0;
    var utils_1 = require_utils();
    exports2.ERROR = {
      OK: 0,
      INTERNAL: 1,
      STRICT: 2,
      CR_EXPECTED: 25,
      LF_EXPECTED: 3,
      UNEXPECTED_CONTENT_LENGTH: 4,
      UNEXPECTED_SPACE: 30,
      CLOSED_CONNECTION: 5,
      INVALID_METHOD: 6,
      INVALID_URL: 7,
      INVALID_CONSTANT: 8,
      INVALID_VERSION: 9,
      INVALID_HEADER_TOKEN: 10,
      INVALID_CONTENT_LENGTH: 11,
      INVALID_CHUNK_SIZE: 12,
      INVALID_STATUS: 13,
      INVALID_EOF_STATE: 14,
      INVALID_TRANSFER_ENCODING: 15,
      CB_MESSAGE_BEGIN: 16,
      CB_HEADERS_COMPLETE: 17,
      CB_MESSAGE_COMPLETE: 18,
      CB_CHUNK_HEADER: 19,
      CB_CHUNK_COMPLETE: 20,
      PAUSED: 21,
      PAUSED_UPGRADE: 22,
      PAUSED_H2_UPGRADE: 23,
      USER: 24,
      CB_URL_COMPLETE: 26,
      CB_STATUS_COMPLETE: 27,
      CB_METHOD_COMPLETE: 32,
      CB_VERSION_COMPLETE: 33,
      CB_HEADER_FIELD_COMPLETE: 28,
      CB_HEADER_VALUE_COMPLETE: 29,
      CB_CHUNK_EXTENSION_NAME_COMPLETE: 34,
      CB_CHUNK_EXTENSION_VALUE_COMPLETE: 35,
      CB_RESET: 31,
      CB_PROTOCOL_COMPLETE: 38
    };
    exports2.TYPE = {
      BOTH: 0,
      // default
      REQUEST: 1,
      RESPONSE: 2
    };
    exports2.FLAGS = {
      CONNECTION_KEEP_ALIVE: 1,
      CONNECTION_CLOSE: 2,
      CONNECTION_UPGRADE: 4,
      CHUNKED: 8,
      UPGRADE: 16,
      CONTENT_LENGTH: 32,
      SKIPBODY: 64,
      TRAILING: 128,
      // 1 << 8 is unused
      TRANSFER_ENCODING: 512
    };
    exports2.LENIENT_FLAGS = {
      HEADERS: 1,
      CHUNKED_LENGTH: 2,
      KEEP_ALIVE: 4,
      TRANSFER_ENCODING: 8,
      VERSION: 16,
      DATA_AFTER_CLOSE: 32,
      OPTIONAL_LF_AFTER_CR: 64,
      OPTIONAL_CRLF_AFTER_CHUNK: 128,
      OPTIONAL_CR_BEFORE_LF: 256,
      SPACES_AFTER_CHUNK_SIZE: 512
    };
    exports2.METHODS = {
      DELETE: 0,
      GET: 1,
      HEAD: 2,
      POST: 3,
      PUT: 4,
      /* pathological */
      CONNECT: 5,
      OPTIONS: 6,
      TRACE: 7,
      /* WebDAV */
      COPY: 8,
      LOCK: 9,
      MKCOL: 10,
      MOVE: 11,
      PROPFIND: 12,
      PROPPATCH: 13,
      SEARCH: 14,
      UNLOCK: 15,
      BIND: 16,
      REBIND: 17,
      UNBIND: 18,
      ACL: 19,
      /* subversion */
      REPORT: 20,
      MKACTIVITY: 21,
      CHECKOUT: 22,
      MERGE: 23,
      /* upnp */
      "M-SEARCH": 24,
      NOTIFY: 25,
      SUBSCRIBE: 26,
      UNSUBSCRIBE: 27,
      /* RFC-5789 */
      PATCH: 28,
      PURGE: 29,
      /* CalDAV */
      MKCALENDAR: 30,
      /* RFC-2068, section 19.6.1.2 */
      LINK: 31,
      UNLINK: 32,
      /* icecast */
      SOURCE: 33,
      /* RFC-7540, section 11.6 */
      PRI: 34,
      /* RFC-2326 RTSP */
      DESCRIBE: 35,
      ANNOUNCE: 36,
      SETUP: 37,
      PLAY: 38,
      PAUSE: 39,
      TEARDOWN: 40,
      GET_PARAMETER: 41,
      SET_PARAMETER: 42,
      REDIRECT: 43,
      RECORD: 44,
      /* RAOP */
      FLUSH: 45,
      /* DRAFT https://www.ietf.org/archive/id/draft-ietf-httpbis-safe-method-w-body-02.html */
      QUERY: 46
    };
    exports2.STATUSES = {
      CONTINUE: 100,
      SWITCHING_PROTOCOLS: 101,
      PROCESSING: 102,
      EARLY_HINTS: 103,
      RESPONSE_IS_STALE: 110,
      // Unofficial
      REVALIDATION_FAILED: 111,
      // Unofficial
      DISCONNECTED_OPERATION: 112,
      // Unofficial
      HEURISTIC_EXPIRATION: 113,
      // Unofficial
      MISCELLANEOUS_WARNING: 199,
      // Unofficial
      OK: 200,
      CREATED: 201,
      ACCEPTED: 202,
      NON_AUTHORITATIVE_INFORMATION: 203,
      NO_CONTENT: 204,
      RESET_CONTENT: 205,
      PARTIAL_CONTENT: 206,
      MULTI_STATUS: 207,
      ALREADY_REPORTED: 208,
      TRANSFORMATION_APPLIED: 214,
      // Unofficial
      IM_USED: 226,
      MISCELLANEOUS_PERSISTENT_WARNING: 299,
      // Unofficial
      MULTIPLE_CHOICES: 300,
      MOVED_PERMANENTLY: 301,
      FOUND: 302,
      SEE_OTHER: 303,
      NOT_MODIFIED: 304,
      USE_PROXY: 305,
      SWITCH_PROXY: 306,
      // No longer used
      TEMPORARY_REDIRECT: 307,
      PERMANENT_REDIRECT: 308,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      PAYMENT_REQUIRED: 402,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      METHOD_NOT_ALLOWED: 405,
      NOT_ACCEPTABLE: 406,
      PROXY_AUTHENTICATION_REQUIRED: 407,
      REQUEST_TIMEOUT: 408,
      CONFLICT: 409,
      GONE: 410,
      LENGTH_REQUIRED: 411,
      PRECONDITION_FAILED: 412,
      PAYLOAD_TOO_LARGE: 413,
      URI_TOO_LONG: 414,
      UNSUPPORTED_MEDIA_TYPE: 415,
      RANGE_NOT_SATISFIABLE: 416,
      EXPECTATION_FAILED: 417,
      IM_A_TEAPOT: 418,
      PAGE_EXPIRED: 419,
      // Unofficial
      ENHANCE_YOUR_CALM: 420,
      // Unofficial
      MISDIRECTED_REQUEST: 421,
      UNPROCESSABLE_ENTITY: 422,
      LOCKED: 423,
      FAILED_DEPENDENCY: 424,
      TOO_EARLY: 425,
      UPGRADE_REQUIRED: 426,
      PRECONDITION_REQUIRED: 428,
      TOO_MANY_REQUESTS: 429,
      REQUEST_HEADER_FIELDS_TOO_LARGE_UNOFFICIAL: 430,
      // Unofficial
      REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
      LOGIN_TIMEOUT: 440,
      // Unofficial
      NO_RESPONSE: 444,
      // Unofficial
      RETRY_WITH: 449,
      // Unofficial
      BLOCKED_BY_PARENTAL_CONTROL: 450,
      // Unofficial
      UNAVAILABLE_FOR_LEGAL_REASONS: 451,
      CLIENT_CLOSED_LOAD_BALANCED_REQUEST: 460,
      // Unofficial
      INVALID_X_FORWARDED_FOR: 463,
      // Unofficial
      REQUEST_HEADER_TOO_LARGE: 494,
      // Unofficial
      SSL_CERTIFICATE_ERROR: 495,
      // Unofficial
      SSL_CERTIFICATE_REQUIRED: 496,
      // Unofficial
      HTTP_REQUEST_SENT_TO_HTTPS_PORT: 497,
      // Unofficial
      INVALID_TOKEN: 498,
      // Unofficial
      CLIENT_CLOSED_REQUEST: 499,
      // Unofficial
      INTERNAL_SERVER_ERROR: 500,
      NOT_IMPLEMENTED: 501,
      BAD_GATEWAY: 502,
      SERVICE_UNAVAILABLE: 503,
      GATEWAY_TIMEOUT: 504,
      HTTP_VERSION_NOT_SUPPORTED: 505,
      VARIANT_ALSO_NEGOTIATES: 506,
      INSUFFICIENT_STORAGE: 507,
      LOOP_DETECTED: 508,
      BANDWIDTH_LIMIT_EXCEEDED: 509,
      NOT_EXTENDED: 510,
      NETWORK_AUTHENTICATION_REQUIRED: 511,
      WEB_SERVER_UNKNOWN_ERROR: 520,
      // Unofficial
      WEB_SERVER_IS_DOWN: 521,
      // Unofficial
      CONNECTION_TIMEOUT: 522,
      // Unofficial
      ORIGIN_IS_UNREACHABLE: 523,
      // Unofficial
      TIMEOUT_OCCURED: 524,
      // Unofficial
      SSL_HANDSHAKE_FAILED: 525,
      // Unofficial
      INVALID_SSL_CERTIFICATE: 526,
      // Unofficial
      RAILGUN_ERROR: 527,
      // Unofficial
      SITE_IS_OVERLOADED: 529,
      // Unofficial
      SITE_IS_FROZEN: 530,
      // Unofficial
      IDENTITY_PROVIDER_AUTHENTICATION_ERROR: 561,
      // Unofficial
      NETWORK_READ_TIMEOUT: 598,
      // Unofficial
      NETWORK_CONNECT_TIMEOUT: 599
      // Unofficial
    };
    exports2.FINISH = {
      SAFE: 0,
      SAFE_WITH_CB: 1,
      UNSAFE: 2
    };
    exports2.HEADER_STATE = {
      GENERAL: 0,
      CONNECTION: 1,
      CONTENT_LENGTH: 2,
      TRANSFER_ENCODING: 3,
      UPGRADE: 4,
      CONNECTION_KEEP_ALIVE: 5,
      CONNECTION_CLOSE: 6,
      CONNECTION_UPGRADE: 7,
      TRANSFER_ENCODING_CHUNKED: 8
    };
    exports2.METHODS_HTTP = [
      exports2.METHODS.DELETE,
      exports2.METHODS.GET,
      exports2.METHODS.HEAD,
      exports2.METHODS.POST,
      exports2.METHODS.PUT,
      exports2.METHODS.CONNECT,
      exports2.METHODS.OPTIONS,
      exports2.METHODS.TRACE,
      exports2.METHODS.COPY,
      exports2.METHODS.LOCK,
      exports2.METHODS.MKCOL,
      exports2.METHODS.MOVE,
      exports2.METHODS.PROPFIND,
      exports2.METHODS.PROPPATCH,
      exports2.METHODS.SEARCH,
      exports2.METHODS.UNLOCK,
      exports2.METHODS.BIND,
      exports2.METHODS.REBIND,
      exports2.METHODS.UNBIND,
      exports2.METHODS.ACL,
      exports2.METHODS.REPORT,
      exports2.METHODS.MKACTIVITY,
      exports2.METHODS.CHECKOUT,
      exports2.METHODS.MERGE,
      exports2.METHODS["M-SEARCH"],
      exports2.METHODS.NOTIFY,
      exports2.METHODS.SUBSCRIBE,
      exports2.METHODS.UNSUBSCRIBE,
      exports2.METHODS.PATCH,
      exports2.METHODS.PURGE,
      exports2.METHODS.MKCALENDAR,
      exports2.METHODS.LINK,
      exports2.METHODS.UNLINK,
      exports2.METHODS.PRI,
      // TODO(indutny): should we allow it with HTTP?
      exports2.METHODS.SOURCE,
      exports2.METHODS.QUERY
    ];
    exports2.METHODS_ICE = [
      exports2.METHODS.SOURCE
    ];
    exports2.METHODS_RTSP = [
      exports2.METHODS.OPTIONS,
      exports2.METHODS.DESCRIBE,
      exports2.METHODS.ANNOUNCE,
      exports2.METHODS.SETUP,
      exports2.METHODS.PLAY,
      exports2.METHODS.PAUSE,
      exports2.METHODS.TEARDOWN,
      exports2.METHODS.GET_PARAMETER,
      exports2.METHODS.SET_PARAMETER,
      exports2.METHODS.REDIRECT,
      exports2.METHODS.RECORD,
      exports2.METHODS.FLUSH,
      // For AirPlay
      exports2.METHODS.GET,
      exports2.METHODS.POST
    ];
    exports2.METHOD_MAP = (0, utils_1.enumToMap)(exports2.METHODS);
    exports2.H_METHOD_MAP = Object.fromEntries(Object.entries(exports2.METHODS).filter(([k]) => k.startsWith("H")));
    exports2.STATUSES_HTTP = [
      exports2.STATUSES.CONTINUE,
      exports2.STATUSES.SWITCHING_PROTOCOLS,
      exports2.STATUSES.PROCESSING,
      exports2.STATUSES.EARLY_HINTS,
      exports2.STATUSES.RESPONSE_IS_STALE,
      exports2.STATUSES.REVALIDATION_FAILED,
      exports2.STATUSES.DISCONNECTED_OPERATION,
      exports2.STATUSES.HEURISTIC_EXPIRATION,
      exports2.STATUSES.MISCELLANEOUS_WARNING,
      exports2.STATUSES.OK,
      exports2.STATUSES.CREATED,
      exports2.STATUSES.ACCEPTED,
      exports2.STATUSES.NON_AUTHORITATIVE_INFORMATION,
      exports2.STATUSES.NO_CONTENT,
      exports2.STATUSES.RESET_CONTENT,
      exports2.STATUSES.PARTIAL_CONTENT,
      exports2.STATUSES.MULTI_STATUS,
      exports2.STATUSES.ALREADY_REPORTED,
      exports2.STATUSES.TRANSFORMATION_APPLIED,
      exports2.STATUSES.IM_USED,
      exports2.STATUSES.MISCELLANEOUS_PERSISTENT_WARNING,
      exports2.STATUSES.MULTIPLE_CHOICES,
      exports2.STATUSES.MOVED_PERMANENTLY,
      exports2.STATUSES.FOUND,
      exports2.STATUSES.SEE_OTHER,
      exports2.STATUSES.NOT_MODIFIED,
      exports2.STATUSES.USE_PROXY,
      exports2.STATUSES.SWITCH_PROXY,
      exports2.STATUSES.TEMPORARY_REDIRECT,
      exports2.STATUSES.PERMANENT_REDIRECT,
      exports2.STATUSES.BAD_REQUEST,
      exports2.STATUSES.UNAUTHORIZED,
      exports2.STATUSES.PAYMENT_REQUIRED,
      exports2.STATUSES.FORBIDDEN,
      exports2.STATUSES.NOT_FOUND,
      exports2.STATUSES.METHOD_NOT_ALLOWED,
      exports2.STATUSES.NOT_ACCEPTABLE,
      exports2.STATUSES.PROXY_AUTHENTICATION_REQUIRED,
      exports2.STATUSES.REQUEST_TIMEOUT,
      exports2.STATUSES.CONFLICT,
      exports2.STATUSES.GONE,
      exports2.STATUSES.LENGTH_REQUIRED,
      exports2.STATUSES.PRECONDITION_FAILED,
      exports2.STATUSES.PAYLOAD_TOO_LARGE,
      exports2.STATUSES.URI_TOO_LONG,
      exports2.STATUSES.UNSUPPORTED_MEDIA_TYPE,
      exports2.STATUSES.RANGE_NOT_SATISFIABLE,
      exports2.STATUSES.EXPECTATION_FAILED,
      exports2.STATUSES.IM_A_TEAPOT,
      exports2.STATUSES.PAGE_EXPIRED,
      exports2.STATUSES.ENHANCE_YOUR_CALM,
      exports2.STATUSES.MISDIRECTED_REQUEST,
      exports2.STATUSES.UNPROCESSABLE_ENTITY,
      exports2.STATUSES.LOCKED,
      exports2.STATUSES.FAILED_DEPENDENCY,
      exports2.STATUSES.TOO_EARLY,
      exports2.STATUSES.UPGRADE_REQUIRED,
      exports2.STATUSES.PRECONDITION_REQUIRED,
      exports2.STATUSES.TOO_MANY_REQUESTS,
      exports2.STATUSES.REQUEST_HEADER_FIELDS_TOO_LARGE_UNOFFICIAL,
      exports2.STATUSES.REQUEST_HEADER_FIELDS_TOO_LARGE,
      exports2.STATUSES.LOGIN_TIMEOUT,
      exports2.STATUSES.NO_RESPONSE,
      exports2.STATUSES.RETRY_WITH,
      exports2.STATUSES.BLOCKED_BY_PARENTAL_CONTROL,
      exports2.STATUSES.UNAVAILABLE_FOR_LEGAL_REASONS,
      exports2.STATUSES.CLIENT_CLOSED_LOAD_BALANCED_REQUEST,
      exports2.STATUSES.INVALID_X_FORWARDED_FOR,
      exports2.STATUSES.REQUEST_HEADER_TOO_LARGE,
      exports2.STATUSES.SSL_CERTIFICATE_ERROR,
      exports2.STATUSES.SSL_CERTIFICATE_REQUIRED,
      exports2.STATUSES.HTTP_REQUEST_SENT_TO_HTTPS_PORT,
      exports2.STATUSES.INVALID_TOKEN,
      exports2.STATUSES.CLIENT_CLOSED_REQUEST,
      exports2.STATUSES.INTERNAL_SERVER_ERROR,
      exports2.STATUSES.NOT_IMPLEMENTED,
      exports2.STATUSES.BAD_GATEWAY,
      exports2.STATUSES.SERVICE_UNAVAILABLE,
      exports2.STATUSES.GATEWAY_TIMEOUT,
      exports2.STATUSES.HTTP_VERSION_NOT_SUPPORTED,
      exports2.STATUSES.VARIANT_ALSO_NEGOTIATES,
      exports2.STATUSES.INSUFFICIENT_STORAGE,
      exports2.STATUSES.LOOP_DETECTED,
      exports2.STATUSES.BANDWIDTH_LIMIT_EXCEEDED,
      exports2.STATUSES.NOT_EXTENDED,
      exports2.STATUSES.NETWORK_AUTHENTICATION_REQUIRED,
      exports2.STATUSES.WEB_SERVER_UNKNOWN_ERROR,
      exports2.STATUSES.WEB_SERVER_IS_DOWN,
      exports2.STATUSES.CONNECTION_TIMEOUT,
      exports2.STATUSES.ORIGIN_IS_UNREACHABLE,
      exports2.STATUSES.TIMEOUT_OCCURED,
      exports2.STATUSES.SSL_HANDSHAKE_FAILED,
      exports2.STATUSES.INVALID_SSL_CERTIFICATE,
      exports2.STATUSES.RAILGUN_ERROR,
      exports2.STATUSES.SITE_IS_OVERLOADED,
      exports2.STATUSES.SITE_IS_FROZEN,
      exports2.STATUSES.IDENTITY_PROVIDER_AUTHENTICATION_ERROR,
      exports2.STATUSES.NETWORK_READ_TIMEOUT,
      exports2.STATUSES.NETWORK_CONNECT_TIMEOUT
    ];
    exports2.ALPHA = [];
    for (let i = 65; i <= 90; i++)
      exports2.ALPHA.push(String.fromCharCode(i)), exports2.ALPHA.push(String.fromCharCode(i + 32));
    exports2.NUM_MAP = {
      0: 0,
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 8,
      9: 9
    };
    exports2.HEX_MAP = {
      0: 0,
      1: 1,
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 8,
      9: 9,
      A: 10,
      B: 11,
      C: 12,
      D: 13,
      E: 14,
      F: 15,
      a: 10,
      b: 11,
      c: 12,
      d: 13,
      e: 14,
      f: 15
    };
    exports2.NUM = [
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9"
    ];
    exports2.ALPHANUM = exports2.ALPHA.concat(exports2.NUM);
    exports2.MARK = ["-", "_", ".", "!", "~", "*", "'", "(", ")"];
    exports2.USERINFO_CHARS = exports2.ALPHANUM.concat(exports2.MARK).concat(["%", ";", ":", "&", "=", "+", "$", ","]);
    exports2.URL_CHAR = [
      "!",
      '"',
      "$",
      "%",
      "&",
      "'",
      "(",
      ")",
      "*",
      "+",
      ",",
      "-",
      ".",
      "/",
      ":",
      ";",
      "<",
      "=",
      ">",
      "@",
      "[",
      "\\",
      "]",
      "^",
      "_",
      "`",
      "{",
      "|",
      "}",
      "~"
    ].concat(exports2.ALPHANUM);
    exports2.HEX = exports2.NUM.concat(["a", "b", "c", "d", "e", "f", "A", "B", "C", "D", "E", "F"]);
    exports2.TOKEN = [
      "!",
      "#",
      "$",
      "%",
      "&",
      "'",
      "*",
      "+",
      "-",
      ".",
      "^",
      "_",
      "`",
      "|",
      "~"
    ].concat(exports2.ALPHANUM);
    exports2.HEADER_CHARS = ["	"];
    for (let i = 32; i <= 255; i++)
      i !== 127 && exports2.HEADER_CHARS.push(i);
    exports2.CONNECTION_TOKEN_CHARS = exports2.HEADER_CHARS.filter((c) => c !== 44);
    exports2.QUOTED_STRING = ["	", " "];
    for (let i = 33; i <= 255; i++)
      i !== 34 && i !== 92 && exports2.QUOTED_STRING.push(i);
    exports2.HTAB_SP_VCHAR_OBS_TEXT = ["	", " "];
    for (let i = 33; i <= 126; i++)
      exports2.HTAB_SP_VCHAR_OBS_TEXT.push(i);
    for (let i = 128; i <= 255; i++)
      exports2.HTAB_SP_VCHAR_OBS_TEXT.push(i);
    exports2.MAJOR = exports2.NUM_MAP;
    exports2.MINOR = exports2.MAJOR;
    exports2.SPECIAL_HEADERS = {
      connection: exports2.HEADER_STATE.CONNECTION,
      "content-length": exports2.HEADER_STATE.CONTENT_LENGTH,
      "proxy-connection": exports2.HEADER_STATE.CONNECTION,
      "transfer-encoding": exports2.HEADER_STATE.TRANSFER_ENCODING,
      upgrade: exports2.HEADER_STATE.UPGRADE
    };
    exports2.default = {
      ERROR: exports2.ERROR,
      TYPE: exports2.TYPE,
      FLAGS: exports2.FLAGS,
      LENIENT_FLAGS: exports2.LENIENT_FLAGS,
      METHODS: exports2.METHODS,
      STATUSES: exports2.STATUSES,
      FINISH: exports2.FINISH,
      HEADER_STATE: exports2.HEADER_STATE,
      ALPHA: exports2.ALPHA,
      NUM_MAP: exports2.NUM_MAP,
      HEX_MAP: exports2.HEX_MAP,
      NUM: exports2.NUM,
      ALPHANUM: exports2.ALPHANUM,
      MARK: exports2.MARK,
      USERINFO_CHARS: exports2.USERINFO_CHARS,
      URL_CHAR: exports2.URL_CHAR,
      HEX: exports2.HEX,
      TOKEN: exports2.TOKEN,
      HEADER_CHARS: exports2.HEADER_CHARS,
      CONNECTION_TOKEN_CHARS: exports2.CONNECTION_TOKEN_CHARS,
      QUOTED_STRING: exports2.QUOTED_STRING,
      HTAB_SP_VCHAR_OBS_TEXT: exports2.HTAB_SP_VCHAR_OBS_TEXT,
      MAJOR: exports2.MAJOR,
      MINOR: exports2.MINOR,
      SPECIAL_HEADERS: exports2.SPECIAL_HEADERS,
      METHODS_HTTP: exports2.METHODS_HTTP,
      METHODS_ICE: exports2.METHODS_ICE,
      METHODS_RTSP: exports2.METHODS_RTSP,
      METHOD_MAP: exports2.METHOD_MAP,
      H_METHOD_MAP: exports2.H_METHOD_MAP,
      STATUSES_HTTP: exports2.STATUSES_HTTP
    };
  }
});

// lib/llhttp/native.js
var require_native = __commonJS({
  "lib/llhttp/native.js"(exports2, module2) {
    "use strict";
    module2.exports = /* @__PURE__ */ __name(function() {
      let binding = internalBinding("undici");
      if (!binding || !binding.llhttp || binding.llhttp.native !== !0)
        throw new Error("internalBinding('undici').llhttp native parser is unavailable");
      return { exports: binding.llhttp };
    }, "nativeLlhttp");
  }
});

// lib/web/fetch/constants.js
var require_constants3 = __commonJS({
  "lib/web/fetch/constants.js"(exports2, module2) {
    "use strict";
    var corsSafeListedMethods = (
      /** @type {const} */
      ["GET", "HEAD", "POST"]
    ), corsSafeListedMethodsSet = new Set(corsSafeListedMethods), nullBodyStatus = (
      /** @type {const} */
      [101, 204, 205, 304]
    ), redirectStatus = (
      /** @type {const} */
      [301, 302, 303, 307, 308]
    ), redirectStatusSet = new Set(redirectStatus), badPorts = (
      /** @type {const} */
      [
        "1",
        "7",
        "9",
        "11",
        "13",
        "15",
        "17",
        "19",
        "20",
        "21",
        "22",
        "23",
        "25",
        "37",
        "42",
        "43",
        "53",
        "69",
        "77",
        "79",
        "87",
        "95",
        "101",
        "102",
        "103",
        "104",
        "109",
        "110",
        "111",
        "113",
        "115",
        "117",
        "119",
        "123",
        "135",
        "137",
        "139",
        "143",
        "161",
        "179",
        "389",
        "427",
        "465",
        "512",
        "513",
        "514",
        "515",
        "526",
        "530",
        "531",
        "532",
        "540",
        "548",
        "554",
        "556",
        "563",
        "587",
        "601",
        "636",
        "989",
        "990",
        "993",
        "995",
        "1719",
        "1720",
        "1723",
        "2049",
        "3659",
        "4045",
        "4190",
        "5060",
        "5061",
        "6000",
        "6566",
        "6665",
        "6666",
        "6667",
        "6668",
        "6669",
        "6679",
        "6697",
        "10080"
      ]
    ), badPortsSet = new Set(badPorts), referrerPolicyTokens = (
      /** @type {const} */
      [
        "no-referrer",
        "no-referrer-when-downgrade",
        "same-origin",
        "origin",
        "strict-origin",
        "origin-when-cross-origin",
        "strict-origin-when-cross-origin",
        "unsafe-url"
      ]
    ), referrerPolicy = (
      /** @type {const} */
      [
        "",
        ...referrerPolicyTokens
      ]
    ), referrerPolicyTokensSet = new Set(referrerPolicyTokens), requestRedirect = (
      /** @type {const} */
      ["follow", "manual", "error"]
    ), safeMethods = (
      /** @type {const} */
      ["GET", "HEAD", "OPTIONS", "TRACE"]
    ), safeMethodsSet = new Set(safeMethods), requestMode = (
      /** @type {const} */
      ["navigate", "same-origin", "no-cors", "cors"]
    ), requestCredentials = (
      /** @type {const} */
      ["omit", "same-origin", "include"]
    ), requestCache = (
      /** @type {const} */
      [
        "default",
        "no-store",
        "reload",
        "no-cache",
        "force-cache",
        "only-if-cached"
      ]
    ), requestBodyHeader = (
      /** @type {const} */
      [
        "content-encoding",
        "content-language",
        "content-location",
        "content-type",
        // See https://github.com/nodejs/undici/issues/2021
        // 'Content-Length' is a forbidden header name, which is typically
        // removed in the Headers implementation. However, undici doesn't
        // filter out headers, so we add it here.
        "content-length"
      ]
    ), requestDuplex = (
      /** @type {const} */
      [
        "half"
      ]
    ), forbiddenMethods = (
      /** @type {const} */
      ["CONNECT", "TRACE", "TRACK"]
    ), forbiddenMethodsSet = new Set(forbiddenMethods), subresource = (
      /** @type {const} */
      [
        "audio",
        "audioworklet",
        "font",
        "image",
        "manifest",
        "paintworklet",
        "script",
        "style",
        "track",
        "video",
        "xslt",
        ""
      ]
    ), subresourceSet = new Set(subresource);
    module2.exports = {
      subresource,
      forbiddenMethods,
      requestBodyHeader,
      referrerPolicy,
      requestRedirect,
      requestMode,
      requestCredentials,
      requestCache,
      redirectStatus,
      corsSafeListedMethods,
      nullBodyStatus,
      safeMethods,
      badPorts,
      requestDuplex,
      subresourceSet,
      badPortsSet,
      redirectStatusSet,
      corsSafeListedMethodsSet,
      safeMethodsSet,
      forbiddenMethodsSet,
      referrerPolicyTokens: referrerPolicyTokensSet
    };
  }
});

// lib/web/fetch/global.js
var require_global = __commonJS({
  "lib/web/fetch/global.js"(exports2, module2) {
    "use strict";
    var globalOrigin = Symbol.for("undici.globalOrigin.1");
    function getGlobalOrigin() {
      return globalThis[globalOrigin];
    }
    __name(getGlobalOrigin, "getGlobalOrigin");
    function setGlobalOrigin(newOrigin) {
      if (newOrigin === void 0) {
        Object.defineProperty(globalThis, globalOrigin, {
          value: void 0,
          writable: !0,
          enumerable: !1,
          configurable: !1
        });
        return;
      }
      let parsedURL = new URL(newOrigin);
      if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:")
        throw new TypeError(`Only http & https urls are allowed, received ${parsedURL.protocol}`);
      Object.defineProperty(globalThis, globalOrigin, {
        value: parsedURL,
        writable: !0,
        enumerable: !1,
        configurable: !1
      });
    }
    __name(setGlobalOrigin, "setGlobalOrigin");
    module2.exports = {
      getGlobalOrigin,
      setGlobalOrigin
    };
  }
});

// lib/encoding/index.js
var require_encoding = __commonJS({
  "lib/encoding/index.js"(exports2, module2) {
    "use strict";
    var textDecoder = new TextDecoder();
    function utf8DecodeBytes(buffer) {
      return buffer.length === 0 ? "" : (buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 && (buffer = buffer.subarray(3)), textDecoder.decode(buffer));
    }
    __name(utf8DecodeBytes, "utf8DecodeBytes");
    module2.exports = {
      utf8DecodeBytes
    };
  }
});

// lib/web/infra/index.js
var require_infra = __commonJS({
  "lib/web/infra/index.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { utf8DecodeBytes } = require_encoding();
    function collectASequenceOfCodePoints(condition, input, position) {
      let result = "";
      for (; position.position < input.length && condition(input[position.position]); )
        result += input[position.position], position.position++;
      return result;
    }
    __name(collectASequenceOfCodePoints, "collectASequenceOfCodePoints");
    function collectASequenceOfCodePointsFast(char, input, position) {
      let idx = input.indexOf(char, position.position), start = position.position;
      return idx === -1 ? (position.position = input.length, input.slice(start)) : (position.position = idx, input.slice(start, position.position));
    }
    __name(collectASequenceOfCodePointsFast, "collectASequenceOfCodePointsFast");
    var ASCII_WHITESPACE_REPLACE_REGEX = /[\u0009\u000A\u000C\u000D\u0020]/g;
    function forgivingBase64(data) {
      data = data.replace(ASCII_WHITESPACE_REPLACE_REGEX, "");
      let dataLength = data.length;
      if (dataLength % 4 === 0 && data.charCodeAt(dataLength - 1) === 61 && (--dataLength, data.charCodeAt(dataLength - 1) === 61 && --dataLength), dataLength % 4 === 1 || /[^+/0-9A-Za-z]/.test(data.length === dataLength ? data : data.substring(0, dataLength)))
        return "failure";
      let buffer = Buffer.from(data, "base64");
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    __name(forgivingBase64, "forgivingBase64");
    function isASCIIWhitespace(char) {
      return char === 9 || // \t
      char === 10 || // \n
      char === 12 || // \f
      char === 13 || // \r
      char === 32;
    }
    __name(isASCIIWhitespace, "isASCIIWhitespace");
    function isomorphicDecode(input) {
      let length = input.length;
      if (65535 > length)
        return String.fromCharCode.apply(null, input);
      let result = "", i = 0, addition = 65535;
      for (; i < length; )
        i + addition > length && (addition = length - i), result += String.fromCharCode.apply(null, input.subarray(i, i += addition));
      return result;
    }
    __name(isomorphicDecode, "isomorphicDecode");
    var invalidIsomorphicEncodeValueRegex = /[^\x00-\xFF]/;
    function isomorphicEncode(input) {
      return assert(!invalidIsomorphicEncodeValueRegex.test(input)), input;
    }
    __name(isomorphicEncode, "isomorphicEncode");
    function parseJSONFromBytes(bytes) {
      return JSON.parse(utf8DecodeBytes(bytes));
    }
    __name(parseJSONFromBytes, "parseJSONFromBytes");
    function removeASCIIWhitespace(str, leading = !0, trailing = !0) {
      return removeChars(str, leading, trailing, isASCIIWhitespace);
    }
    __name(removeASCIIWhitespace, "removeASCIIWhitespace");
    function removeChars(str, leading, trailing, predicate) {
      let lead = 0, trail = str.length - 1;
      if (leading)
        for (; lead < str.length && predicate(str.charCodeAt(lead)); ) lead++;
      if (trailing)
        for (; trail > 0 && predicate(str.charCodeAt(trail)); ) trail--;
      return lead === 0 && trail === str.length - 1 ? str : str.slice(lead, trail + 1);
    }
    __name(removeChars, "removeChars");
    function serializeJavascriptValueToJSONString(value) {
      let result = JSON.stringify(value);
      if (result === void 0)
        throw new TypeError("Value is not JSON serializable");
      return assert(typeof result == "string"), result;
    }
    __name(serializeJavascriptValueToJSONString, "serializeJavascriptValueToJSONString");
    module2.exports = {
      collectASequenceOfCodePoints,
      collectASequenceOfCodePointsFast,
      forgivingBase64,
      isASCIIWhitespace,
      isomorphicDecode,
      isomorphicEncode,
      parseJSONFromBytes,
      removeASCIIWhitespace,
      removeChars,
      serializeJavascriptValueToJSONString
    };
  }
});

// lib/web/fetch/data-url.js
var require_data_url = __commonJS({
  "lib/web/fetch/data-url.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { forgivingBase64, collectASequenceOfCodePoints, collectASequenceOfCodePointsFast, isomorphicDecode, removeASCIIWhitespace, removeChars } = require_infra(), encoder = new TextEncoder(), HTTP_TOKEN_CODEPOINTS = /^[-!#$%&'*+.^_|~A-Za-z0-9]+$/u, HTTP_WHITESPACE_REGEX = /[\u000A\u000D\u0009\u0020]/u, HTTP_QUOTED_STRING_TOKENS = /^[\u0009\u0020-\u007E\u0080-\u00FF]+$/u;
    function dataURLProcessor(dataURL) {
      assert(dataURL.protocol === "data:");
      let input = URLSerializer(dataURL, !0);
      input = input.slice(5);
      let position = { position: 0 }, mimeType = collectASequenceOfCodePointsFast(
        ",",
        input,
        position
      ), mimeTypeLength = mimeType.length;
      if (mimeType = removeASCIIWhitespace(mimeType, !0, !0), position.position >= input.length)
        return "failure";
      position.position++;
      let encodedBody = input.slice(mimeTypeLength + 1), body = stringPercentDecode(encodedBody);
      if (/;(?:\u0020*)base64$/ui.test(mimeType)) {
        let stringBody = isomorphicDecode(body);
        if (body = forgivingBase64(stringBody), body === "failure")
          return "failure";
        mimeType = mimeType.slice(0, -6), mimeType = mimeType.replace(/(\u0020+)$/u, ""), mimeType = mimeType.slice(0, -1);
      }
      mimeType.startsWith(";") && (mimeType = "text/plain" + mimeType);
      let mimeTypeRecord = parseMIMEType(mimeType);
      return mimeTypeRecord === "failure" && (mimeTypeRecord = parseMIMEType("text/plain;charset=US-ASCII")), { mimeType: mimeTypeRecord, body };
    }
    __name(dataURLProcessor, "dataURLProcessor");
    function URLSerializer(url, excludeFragment = !1) {
      if (!excludeFragment)
        return url.href;
      let href = url.href, hashLength = url.hash.length, serialized = hashLength === 0 ? href : href.substring(0, href.length - hashLength);
      return !hashLength && href.endsWith("#") ? serialized.slice(0, -1) : serialized;
    }
    __name(URLSerializer, "URLSerializer");
    function stringPercentDecode(input) {
      let bytes = encoder.encode(input);
      return percentDecode(bytes);
    }
    __name(stringPercentDecode, "stringPercentDecode");
    function isHexCharByte(byte) {
      return byte >= 48 && byte <= 57 || byte >= 65 && byte <= 70 || byte >= 97 && byte <= 102;
    }
    __name(isHexCharByte, "isHexCharByte");
    function hexByteToNumber(byte) {
      return (
        // 0-9
        byte >= 48 && byte <= 57 ? byte - 48 : (byte & 223) - 55
      );
    }
    __name(hexByteToNumber, "hexByteToNumber");
    function percentDecode(input) {
      let length = input.length, output = new Uint8Array(length), j = 0, i = 0;
      for (; i < length; ) {
        let byte = input[i];
        byte !== 37 ? output[j++] = byte : byte === 37 && !(isHexCharByte(input[i + 1]) && isHexCharByte(input[i + 2])) ? output[j++] = 37 : (output[j++] = hexByteToNumber(input[i + 1]) << 4 | hexByteToNumber(input[i + 2]), i += 2), ++i;
      }
      return length === j ? output : output.subarray(0, j);
    }
    __name(percentDecode, "percentDecode");
    function parseMIMEType(input) {
      input = removeHTTPWhitespace(input, !0, !0);
      let position = { position: 0 }, type = collectASequenceOfCodePointsFast(
        "/",
        input,
        position
      );
      if (type.length === 0 || !HTTP_TOKEN_CODEPOINTS.test(type) || position.position >= input.length)
        return "failure";
      position.position++;
      let subtype = collectASequenceOfCodePointsFast(
        ";",
        input,
        position
      );
      if (subtype = removeHTTPWhitespace(subtype, !1, !0), subtype.length === 0 || !HTTP_TOKEN_CODEPOINTS.test(subtype))
        return "failure";
      let typeLowercase = type.toLowerCase(), subtypeLowercase = subtype.toLowerCase(), mimeType = {
        type: typeLowercase,
        subtype: subtypeLowercase,
        /** @type {Map<string, string>} */
        parameters: /* @__PURE__ */ new Map(),
        // https://mimesniff.spec.whatwg.org/#mime-type-essence
        essence: `${typeLowercase}/${subtypeLowercase}`
      };
      for (; position.position < input.length; ) {
        position.position++, collectASequenceOfCodePoints(
          // https://fetch.spec.whatwg.org/#http-whitespace
          (char) => HTTP_WHITESPACE_REGEX.test(char),
          input,
          position
        );
        let parameterName = collectASequenceOfCodePoints(
          (char) => char !== ";" && char !== "=",
          input,
          position
        );
        if (parameterName = parameterName.toLowerCase(), position.position < input.length) {
          if (input[position.position] === ";")
            continue;
          position.position++;
        }
        if (position.position >= input.length)
          break;
        let parameterValue = null;
        if (input[position.position] === '"')
          parameterValue = collectAnHTTPQuotedString(input, position, !0), collectASequenceOfCodePointsFast(
            ";",
            input,
            position
          );
        else if (parameterValue = collectASequenceOfCodePointsFast(
          ";",
          input,
          position
        ), parameterValue = removeHTTPWhitespace(parameterValue, !1, !0), parameterValue.length === 0)
          continue;
        parameterName.length !== 0 && HTTP_TOKEN_CODEPOINTS.test(parameterName) && (parameterValue.length === 0 || HTTP_QUOTED_STRING_TOKENS.test(parameterValue)) && !mimeType.parameters.has(parameterName) && mimeType.parameters.set(parameterName, parameterValue);
      }
      return mimeType;
    }
    __name(parseMIMEType, "parseMIMEType");
    function collectAnHTTPQuotedString(input, position, extractValue = !1) {
      let positionStart = position.position, value = "";
      for (assert(input[position.position] === '"'), position.position++; value += collectASequenceOfCodePoints(
        (char) => char !== '"' && char !== "\\",
        input,
        position
      ), !(position.position >= input.length); ) {
        let quoteOrBackslash = input[position.position];
        if (position.position++, quoteOrBackslash === "\\") {
          if (position.position >= input.length) {
            value += "\\";
            break;
          }
          value += input[position.position], position.position++;
        } else {
          assert(quoteOrBackslash === '"');
          break;
        }
      }
      return extractValue ? value : input.slice(positionStart, position.position);
    }
    __name(collectAnHTTPQuotedString, "collectAnHTTPQuotedString");
    function serializeAMimeType(mimeType) {
      assert(mimeType !== "failure");
      let { parameters, essence } = mimeType, serialization = essence;
      for (let [name, value] of parameters.entries())
        serialization += ";", serialization += name, serialization += "=", HTTP_TOKEN_CODEPOINTS.test(value) || (value = value.replace(/[\\"]/ug, "\\$&"), value = '"' + value, value += '"'), serialization += value;
      return serialization;
    }
    __name(serializeAMimeType, "serializeAMimeType");
    function isHTTPWhiteSpace(char) {
      return char === 13 || char === 10 || char === 9 || char === 32;
    }
    __name(isHTTPWhiteSpace, "isHTTPWhiteSpace");
    function removeHTTPWhitespace(str, leading = !0, trailing = !0) {
      return removeChars(str, leading, trailing, isHTTPWhiteSpace);
    }
    __name(removeHTTPWhitespace, "removeHTTPWhitespace");
    function minimizeSupportedMimeType(mimeType) {
      switch (mimeType.essence) {
        case "application/ecmascript":
        case "application/javascript":
        case "application/x-ecmascript":
        case "application/x-javascript":
        case "text/ecmascript":
        case "text/javascript":
        case "text/javascript1.0":
        case "text/javascript1.1":
        case "text/javascript1.2":
        case "text/javascript1.3":
        case "text/javascript1.4":
        case "text/javascript1.5":
        case "text/jscript":
        case "text/livescript":
        case "text/x-ecmascript":
        case "text/x-javascript":
          return "text/javascript";
        case "application/json":
        case "text/json":
          return "application/json";
        case "image/svg+xml":
          return "image/svg+xml";
        case "text/xml":
        case "application/xml":
          return "application/xml";
      }
      return mimeType.subtype.endsWith("+json") ? "application/json" : mimeType.subtype.endsWith("+xml") ? "application/xml" : "";
    }
    __name(minimizeSupportedMimeType, "minimizeSupportedMimeType");
    module2.exports = {
      dataURLProcessor,
      URLSerializer,
      stringPercentDecode,
      parseMIMEType,
      collectAnHTTPQuotedString,
      serializeAMimeType,
      removeHTTPWhitespace,
      minimizeSupportedMimeType,
      HTTP_TOKEN_CODEPOINTS
    };
  }
});

// lib/util/runtime-features.js
var require_runtime_features = __commonJS({
  "lib/util/runtime-features.js"(exports2, module2) {
    "use strict";
    var lazyLoaders = {
      __proto__: null,
      "node:crypto": /* @__PURE__ */ __name(() => require("node:crypto"), "node:crypto"),
      "node:sqlite": /* @__PURE__ */ __name(() => require("node:sqlite"), "node:sqlite"),
      "node:worker_threads": /* @__PURE__ */ __name(() => require("node:worker_threads"), "node:worker_threads"),
      "node:zlib": /* @__PURE__ */ __name(() => require("node:zlib"), "node:zlib")
    };
    function detectRuntimeFeatureByNodeModule(moduleName) {
      try {
        return lazyLoaders[moduleName](), !0;
      } catch (err) {
        if (err.code !== "ERR_UNKNOWN_BUILTIN_MODULE" && err.code !== "ERR_NO_CRYPTO")
          throw err;
        return !1;
      }
    }
    __name(detectRuntimeFeatureByNodeModule, "detectRuntimeFeatureByNodeModule");
    function detectRuntimeFeatureByExportedProperty(moduleName, property) {
      return typeof lazyLoaders[moduleName]()[property] < "u";
    }
    __name(detectRuntimeFeatureByExportedProperty, "detectRuntimeFeatureByExportedProperty");
    var runtimeFeaturesByExportedProperty = (
      /** @type {const} */
      ["markAsUncloneable", "zstd"]
    ), exportedPropertyLookup = {
      markAsUncloneable: ["node:worker_threads", "markAsUncloneable"],
      zstd: ["node:zlib", "createZstdDecompress"]
    }, runtimeFeaturesAsNodeModule = (
      /** @type {const} */
      ["crypto", "sqlite"]
    ), features = (
      /** @type {const} */
      [
        ...runtimeFeaturesAsNodeModule,
        ...runtimeFeaturesByExportedProperty
      ]
    );
    function detectRuntimeFeature(feature) {
      if (runtimeFeaturesAsNodeModule.includes(
        /** @type {RuntimeFeatureByNodeModule} */
        feature
      ))
        return detectRuntimeFeatureByNodeModule(`node:${feature}`);
      if (runtimeFeaturesByExportedProperty.includes(
        /** @type {RuntimeFeatureByExportedProperty} */
        feature
      )) {
        let [moduleName, property] = exportedPropertyLookup[feature];
        return detectRuntimeFeatureByExportedProperty(moduleName, property);
      }
      throw new TypeError(`unknown feature: ${feature}`);
    }
    __name(detectRuntimeFeature, "detectRuntimeFeature");
    var RuntimeFeatures = class {
      static {
        __name(this, "RuntimeFeatures");
      }
      /** @type {Map<Feature, boolean>} */
      #map = /* @__PURE__ */ new Map();
      /**
       * Clears all cached feature detections.
       */
      clear() {
        this.#map.clear();
      }
      /**
       * @param {Feature} feature
       * @returns {boolean}
       */
      has(feature) {
        return this.#map.get(feature) ?? this.#detectRuntimeFeature(feature);
      }
      /**
       * @param {Feature} feature
       * @param {boolean} value
       */
      set(feature, value) {
        if (features.includes(feature) === !1)
          throw new TypeError(`unknown feature: ${feature}`);
        this.#map.set(feature, value);
      }
      /**
       * @param {Feature} feature
       * @returns {boolean}
       */
      #detectRuntimeFeature(feature) {
        let result = detectRuntimeFeature(feature);
        return this.#map.set(feature, result), result;
      }
    }, instance = new RuntimeFeatures();
    module2.exports.runtimeFeatures = instance;
    module2.exports.default = instance;
  }
});

// lib/web/webidl/index.js
var require_webidl = __commonJS({
  "lib/web/webidl/index.js"(exports2, module2) {
    "use strict";
    var { types, inspect } = require("node:util"), { runtimeFeatures } = require_runtime_features(), UNDEFINED = 1, BOOLEAN = 2, STRING = 3, SYMBOL = 4, NUMBER = 5, BIGINT = 6, NULL = 7, OBJECT = 8, FunctionPrototypeSymbolHasInstance = Function.call.bind(Function.prototype[Symbol.hasInstance]), webidl = {
      converters: {},
      util: {},
      errors: {},
      is: {}
    };
    webidl.errors.exception = function(message) {
      return new TypeError(`${message.header}: ${message.message}`);
    };
    webidl.errors.conversionFailed = function(opts) {
      let plural = opts.types.length === 1 ? "" : " one of", message = `${opts.argument} could not be converted to${plural}: ${opts.types.join(", ")}.`;
      return webidl.errors.exception({
        header: opts.prefix,
        message
      });
    };
    webidl.errors.invalidArgument = function(context) {
      return webidl.errors.exception({
        header: context.prefix,
        message: `"${context.value}" is an invalid ${context.type}.`
      });
    };
    webidl.brandCheck = function(V, I) {
      if (!FunctionPrototypeSymbolHasInstance(I, V)) {
        let err = new TypeError("Illegal invocation");
        throw err.code = "ERR_INVALID_THIS", err;
      }
    };
    webidl.brandCheckMultiple = function(List) {
      let prototypes = List.map((c) => webidl.util.MakeTypeAssertion(c));
      return (V) => {
        if (prototypes.every((typeCheck) => !typeCheck(V))) {
          let err = new TypeError("Illegal invocation");
          throw err.code = "ERR_INVALID_THIS", err;
        }
      };
    };
    webidl.argumentLengthCheck = function({ length }, min, ctx) {
      if (length < min)
        throw webidl.errors.exception({
          message: `${min} argument${min !== 1 ? "s" : ""} required, but${length ? " only" : ""} ${length} found.`,
          header: ctx
        });
    };
    webidl.illegalConstructor = function() {
      throw webidl.errors.exception({
        header: "TypeError",
        message: "Illegal constructor"
      });
    };
    webidl.util.MakeTypeAssertion = function(I) {
      return (O) => FunctionPrototypeSymbolHasInstance(I, O);
    };
    webidl.util.Type = function(V) {
      switch (typeof V) {
        case "undefined":
          return UNDEFINED;
        case "boolean":
          return BOOLEAN;
        case "string":
          return STRING;
        case "symbol":
          return SYMBOL;
        case "number":
          return NUMBER;
        case "bigint":
          return BIGINT;
        case "function":
        case "object":
          return V === null ? NULL : OBJECT;
      }
    };
    webidl.util.Types = {
      UNDEFINED,
      BOOLEAN,
      STRING,
      SYMBOL,
      NUMBER,
      BIGINT,
      NULL,
      OBJECT
    };
    webidl.util.TypeValueToString = function(o) {
      switch (webidl.util.Type(o)) {
        case UNDEFINED:
          return "Undefined";
        case BOOLEAN:
          return "Boolean";
        case STRING:
          return "String";
        case SYMBOL:
          return "Symbol";
        case NUMBER:
          return "Number";
        case BIGINT:
          return "BigInt";
        case NULL:
          return "Null";
        case OBJECT:
          return "Object";
      }
    };
    webidl.util.markAsUncloneable = runtimeFeatures.has("markAsUncloneable") ? require("node:worker_threads").markAsUncloneable : () => {
    };
    webidl.util.ConvertToInt = function(V, bitLength, signedness, flags) {
      let upperBound, lowerBound;
      bitLength === 64 ? (upperBound = Math.pow(2, 53) - 1, signedness === "unsigned" ? lowerBound = 0 : lowerBound = Math.pow(-2, 53) + 1) : signedness === "unsigned" ? (lowerBound = 0, upperBound = Math.pow(2, bitLength) - 1) : (lowerBound = Math.pow(-2, bitLength) - 1, upperBound = Math.pow(2, bitLength - 1) - 1);
      let x = Number(V);
      if (x === 0 && (x = 0), webidl.util.HasFlag(flags, webidl.attributes.EnforceRange)) {
        if (Number.isNaN(x) || x === Number.POSITIVE_INFINITY || x === Number.NEGATIVE_INFINITY)
          throw webidl.errors.exception({
            header: "Integer conversion",
            message: `Could not convert ${webidl.util.Stringify(V)} to an integer.`
          });
        if (x = webidl.util.IntegerPart(x), x < lowerBound || x > upperBound)
          throw webidl.errors.exception({
            header: "Integer conversion",
            message: `Value must be between ${lowerBound}-${upperBound}, got ${x}.`
          });
        return x;
      }
      return !Number.isNaN(x) && webidl.util.HasFlag(flags, webidl.attributes.Clamp) ? (x = Math.min(Math.max(x, lowerBound), upperBound), Math.floor(x) % 2 === 0 ? x = Math.floor(x) : x = Math.ceil(x), x) : Number.isNaN(x) || x === 0 && Object.is(0, x) || x === Number.POSITIVE_INFINITY || x === Number.NEGATIVE_INFINITY ? 0 : (x = webidl.util.IntegerPart(x), x = x % Math.pow(2, bitLength), signedness === "signed" && x >= Math.pow(2, bitLength) - 1 ? x - Math.pow(2, bitLength) : x);
    };
    webidl.util.IntegerPart = function(n) {
      let r = Math.floor(Math.abs(n));
      return n < 0 ? -1 * r : r;
    };
    webidl.util.Stringify = function(V) {
      switch (webidl.util.Type(V)) {
        case SYMBOL:
          return `Symbol(${V.description})`;
        case OBJECT:
          return inspect(V);
        case STRING:
          return `"${V}"`;
        case BIGINT:
          return `${V}n`;
        default:
          return `${V}`;
      }
    };
    webidl.util.IsResizableArrayBuffer = function(V) {
      if (types.isArrayBuffer(V))
        return V.resizable;
      if (types.isSharedArrayBuffer(V))
        return V.growable;
      throw webidl.errors.exception({
        header: "IsResizableArrayBuffer",
        message: `"${webidl.util.Stringify(V)}" is not an array buffer.`
      });
    };
    webidl.util.HasFlag = function(flags, attributes) {
      return typeof flags == "number" && (flags & attributes) === attributes;
    };
    webidl.sequenceConverter = function(converter) {
      return (V, prefix, argument, Iterable) => {
        if (webidl.util.Type(V) !== OBJECT)
          throw webidl.errors.exception({
            header: prefix,
            message: `${argument} (${webidl.util.Stringify(V)}) is not iterable.`
          });
        let method = typeof Iterable == "function" ? Iterable() : V?.[Symbol.iterator]?.(), seq = [], index = 0;
        if (method === void 0 || typeof method.next != "function")
          throw webidl.errors.exception({
            header: prefix,
            message: `${argument} is not iterable.`
          });
        for (; ; ) {
          let { done, value } = method.next();
          if (done)
            break;
          seq.push(converter(value, prefix, `${argument}[${index++}]`));
        }
        return seq;
      };
    };
    webidl.recordConverter = function(keyConverter, valueConverter) {
      return (O, prefix, argument) => {
        if (webidl.util.Type(O) !== OBJECT)
          throw webidl.errors.exception({
            header: prefix,
            message: `${argument} ("${webidl.util.TypeValueToString(O)}") is not an Object.`
          });
        let result = {};
        if (!types.isProxy(O)) {
          let keys2 = [...Object.getOwnPropertyNames(O), ...Object.getOwnPropertySymbols(O)];
          for (let key of keys2) {
            let keyName = webidl.util.Stringify(key), typedKey = keyConverter(key, prefix, `Key ${keyName} in ${argument}`), typedValue = valueConverter(O[key], prefix, `${argument}[${keyName}]`);
            result[typedKey] = typedValue;
          }
          return result;
        }
        let keys = Reflect.ownKeys(O);
        for (let key of keys)
          if (Reflect.getOwnPropertyDescriptor(O, key)?.enumerable) {
            let typedKey = keyConverter(key, prefix, argument), typedValue = valueConverter(O[key], prefix, argument);
            result[typedKey] = typedValue;
          }
        return result;
      };
    };
    webidl.interfaceConverter = function(TypeCheck, name) {
      return (V, prefix, argument) => {
        if (!TypeCheck(V))
          throw webidl.errors.exception({
            header: prefix,
            message: `Expected ${argument} ("${webidl.util.Stringify(V)}") to be an instance of ${name}.`
          });
        return V;
      };
    };
    webidl.dictionaryConverter = function(converters) {
      return (dictionary, prefix, argument) => {
        let dict = {};
        if (dictionary != null && webidl.util.Type(dictionary) !== OBJECT)
          throw webidl.errors.exception({
            header: prefix,
            message: `Expected ${dictionary} to be one of: Null, Undefined, Object.`
          });
        for (let options of converters) {
          let { key, defaultValue, required, converter } = options;
          if (required === !0 && (dictionary == null || !Object.hasOwn(dictionary, key)))
            throw webidl.errors.exception({
              header: prefix,
              message: `Missing required key "${key}".`
            });
          let value = dictionary?.[key], hasDefault = defaultValue !== void 0;
          if (hasDefault && value === void 0 && (value = defaultValue()), required || hasDefault || value !== void 0) {
            if (value = converter(value, prefix, `${argument}.${key}`), options.allowedValues && !options.allowedValues.includes(value))
              throw webidl.errors.exception({
                header: prefix,
                message: `${value} is not an accepted type. Expected one of ${options.allowedValues.join(", ")}.`
              });
            dict[key] = value;
          }
        }
        return dict;
      };
    };
    webidl.nullableConverter = function(converter) {
      return (V, prefix, argument) => V === null ? V : converter(V, prefix, argument);
    };
    webidl.is.USVString = function(value) {
      return typeof value == "string" && value.isWellFormed();
    };
    webidl.is.ReadableStream = webidl.util.MakeTypeAssertion(ReadableStream);
    webidl.is.Blob = webidl.util.MakeTypeAssertion(Blob);
    webidl.is.URLSearchParams = webidl.util.MakeTypeAssertion(URLSearchParams);
    webidl.is.File = webidl.util.MakeTypeAssertion(File);
    webidl.is.URL = webidl.util.MakeTypeAssertion(URL);
    webidl.is.AbortSignal = webidl.util.MakeTypeAssertion(AbortSignal);
    webidl.is.MessagePort = webidl.util.MakeTypeAssertion(MessagePort);
    webidl.is.BufferSource = function(V) {
      return types.isArrayBuffer(V) || ArrayBuffer.isView(V) && types.isArrayBuffer(V.buffer);
    };
    webidl.converters.DOMString = function(V, prefix, argument, flags) {
      if (V === null && webidl.util.HasFlag(flags, webidl.attributes.LegacyNullToEmptyString))
        return "";
      if (typeof V == "symbol")
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} is a symbol, which cannot be converted to a DOMString.`
        });
      return String(V);
    };
    webidl.converters.ByteString = function(V, prefix, argument) {
      if (typeof V == "symbol")
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} is a symbol, which cannot be converted to a ByteString.`
        });
      let x = String(V);
      for (let index = 0; index < x.length; index++)
        if (x.charCodeAt(index) > 255)
          throw new TypeError(
            `Cannot convert argument to a ByteString because the character at index ${index} has a value of ${x.charCodeAt(index)} which is greater than 255.`
          );
      return x;
    };
    webidl.converters.USVString = function(value) {
      return typeof value == "string" ? value.toWellFormed() : `${value}`.toWellFormed();
    };
    webidl.converters.boolean = function(V) {
      return !!V;
    };
    webidl.converters.any = function(V) {
      return V;
    };
    webidl.converters["long long"] = function(V, prefix, argument) {
      return webidl.util.ConvertToInt(V, 64, "signed", 0, prefix, argument);
    };
    webidl.converters["unsigned long long"] = function(V, prefix, argument) {
      return webidl.util.ConvertToInt(V, 64, "unsigned", 0, prefix, argument);
    };
    webidl.converters["unsigned long"] = function(V, prefix, argument) {
      return webidl.util.ConvertToInt(V, 32, "unsigned", 0, prefix, argument);
    };
    webidl.converters["unsigned short"] = function(V, prefix, argument, flags) {
      return webidl.util.ConvertToInt(V, 16, "unsigned", flags, prefix, argument);
    };
    webidl.converters.ArrayBuffer = function(V, prefix, argument, flags) {
      if (webidl.util.Type(V) !== OBJECT || !types.isArrayBuffer(V))
        throw webidl.errors.conversionFailed({
          prefix,
          argument: `${argument} ("${webidl.util.Stringify(V)}")`,
          types: ["ArrayBuffer"]
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowResizable) && webidl.util.IsResizableArrayBuffer(V))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a resizable ArrayBuffer.`
        });
      return V;
    };
    webidl.converters.SharedArrayBuffer = function(V, prefix, argument, flags) {
      if (webidl.util.Type(V) !== OBJECT || !types.isSharedArrayBuffer(V))
        throw webidl.errors.conversionFailed({
          prefix,
          argument: `${argument} ("${webidl.util.Stringify(V)}")`,
          types: ["SharedArrayBuffer"]
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowResizable) && webidl.util.IsResizableArrayBuffer(V))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a resizable SharedArrayBuffer.`
        });
      return V;
    };
    webidl.converters.TypedArray = function(V, T, prefix, argument, flags) {
      if (webidl.util.Type(V) !== OBJECT || !types.isTypedArray(V) || V.constructor.name !== T.name)
        throw webidl.errors.conversionFailed({
          prefix,
          argument: `${argument} ("${webidl.util.Stringify(V)}")`,
          types: [T.name]
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowShared) && types.isSharedArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a shared array buffer.`
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowResizable) && webidl.util.IsResizableArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a resizable array buffer.`
        });
      return V;
    };
    webidl.converters.DataView = function(V, prefix, argument, flags) {
      if (webidl.util.Type(V) !== OBJECT || !types.isDataView(V))
        throw webidl.errors.conversionFailed({
          prefix,
          argument: `${argument} ("${webidl.util.Stringify(V)}")`,
          types: ["DataView"]
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowShared) && types.isSharedArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a shared array buffer.`
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowResizable) && webidl.util.IsResizableArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a resizable array buffer.`
        });
      return V;
    };
    webidl.converters.ArrayBufferView = function(V, prefix, argument, flags) {
      if (webidl.util.Type(V) !== OBJECT || !types.isArrayBufferView(V))
        throw webidl.errors.conversionFailed({
          prefix,
          argument: `${argument} ("${webidl.util.Stringify(V)}")`,
          types: ["ArrayBufferView"]
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowShared) && types.isSharedArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a shared array buffer.`
        });
      if (!webidl.util.HasFlag(flags, webidl.attributes.AllowResizable) && webidl.util.IsResizableArrayBuffer(V.buffer))
        throw webidl.errors.exception({
          header: prefix,
          message: `${argument} cannot be a view on a resizable array buffer.`
        });
      return V;
    };
    webidl.converters.BufferSource = function(V, prefix, argument, flags) {
      if (types.isArrayBuffer(V))
        return webidl.converters.ArrayBuffer(V, prefix, argument, flags);
      if (types.isArrayBufferView(V))
        return flags &= ~webidl.attributes.AllowShared, webidl.converters.ArrayBufferView(V, prefix, argument, flags);
      throw types.isSharedArrayBuffer(V) ? webidl.errors.exception({
        header: prefix,
        message: `${argument} cannot be a SharedArrayBuffer.`
      }) : webidl.errors.conversionFailed({
        prefix,
        argument: `${argument} ("${webidl.util.Stringify(V)}")`,
        types: ["ArrayBuffer", "ArrayBufferView"]
      });
    };
    webidl.converters.AllowSharedBufferSource = function(V, prefix, argument, flags) {
      if (types.isArrayBuffer(V))
        return webidl.converters.ArrayBuffer(V, prefix, argument, flags);
      if (types.isSharedArrayBuffer(V))
        return webidl.converters.SharedArrayBuffer(V, prefix, argument, flags);
      if (types.isArrayBufferView(V))
        return flags |= webidl.attributes.AllowShared, webidl.converters.ArrayBufferView(V, prefix, argument, flags);
      throw webidl.errors.conversionFailed({
        prefix,
        argument: `${argument} ("${webidl.util.Stringify(V)}")`,
        types: ["ArrayBuffer", "SharedArrayBuffer", "ArrayBufferView"]
      });
    };
    webidl.converters["sequence<ByteString>"] = webidl.sequenceConverter(
      webidl.converters.ByteString
    );
    webidl.converters["sequence<sequence<ByteString>>"] = webidl.sequenceConverter(
      webidl.converters["sequence<ByteString>"]
    );
    webidl.converters["record<ByteString, ByteString>"] = webidl.recordConverter(
      webidl.converters.ByteString,
      webidl.converters.ByteString
    );
    webidl.converters.Blob = webidl.interfaceConverter(webidl.is.Blob, "Blob");
    webidl.converters.AbortSignal = webidl.interfaceConverter(
      webidl.is.AbortSignal,
      "AbortSignal"
    );
    webidl.converters.EventHandlerNonNull = function(V) {
      return webidl.util.Type(V) !== OBJECT ? null : typeof V == "function" ? V : () => {
      };
    };
    webidl.attributes = {
      Clamp: 1,
      EnforceRange: 2,
      AllowShared: 4,
      AllowResizable: 8,
      LegacyNullToEmptyString: 16
    };
    module2.exports = {
      webidl
    };
  }
});

// lib/web/fetch/util.js
var require_util2 = __commonJS({
  "lib/web/fetch/util.js"(exports2, module2) {
    "use strict";
    var { Transform } = require("node:stream"), zlib = require("node:zlib"), { redirectStatusSet, referrerPolicyTokens, badPortsSet } = require_constants3(), { getGlobalOrigin } = require_global(), { collectAnHTTPQuotedString, parseMIMEType } = require_data_url(), { performance: performance2 } = require("node:perf_hooks"), { ReadableStreamFrom, isValidHTTPToken, normalizedMethodRecordsBase } = require_util(), assert = require("node:assert"), { isUint8Array } = require("node:util/types"), { webidl } = require_webidl(), { isomorphicEncode, collectASequenceOfCodePoints, removeChars } = require_infra();
    function responseURL(response) {
      let urlList = response.urlList, length = urlList.length;
      return length === 0 ? null : urlList[length - 1].toString();
    }
    __name(responseURL, "responseURL");
    function responseLocationURL(response, requestFragment) {
      if (!redirectStatusSet.has(response.status))
        return null;
      let location = response.headersList.get("location", !0);
      return location !== null && isValidHeaderValue(location) && (isValidEncodedURL(location) || (location = normalizeBinaryStringToUtf8(location)), location = new URL(location, responseURL(response))), location && !location.hash && (location.hash = requestFragment), location;
    }
    __name(responseLocationURL, "responseLocationURL");
    function isValidEncodedURL(url) {
      for (let i = 0; i < url.length; ++i) {
        let code = url.charCodeAt(i);
        if (code > 126 || // Non-US-ASCII + DEL
        code < 32)
          return !1;
      }
      return !0;
    }
    __name(isValidEncodedURL, "isValidEncodedURL");
    function normalizeBinaryStringToUtf8(value) {
      return Buffer.from(value, "binary").toString("utf8");
    }
    __name(normalizeBinaryStringToUtf8, "normalizeBinaryStringToUtf8");
    function requestCurrentURL(request) {
      return request.urlList[request.urlList.length - 1];
    }
    __name(requestCurrentURL, "requestCurrentURL");
    function requestBadPort(request) {
      let url = requestCurrentURL(request);
      return urlIsHttpHttpsScheme(url) && badPortsSet.has(url.port) ? "blocked" : "allowed";
    }
    __name(requestBadPort, "requestBadPort");
    function isErrorLike(object) {
      return object instanceof Error || object?.constructor?.name === "Error" || object?.constructor?.name === "DOMException";
    }
    __name(isErrorLike, "isErrorLike");
    function isValidReasonPhrase(statusText) {
      for (let i = 0; i < statusText.length; ++i) {
        let c = statusText.charCodeAt(i);
        if (!(c === 9 || // HTAB
        c >= 32 && c <= 126 || // SP / VCHAR
        c >= 128 && c <= 255))
          return !1;
      }
      return !0;
    }
    __name(isValidReasonPhrase, "isValidReasonPhrase");
    var isValidHeaderName = isValidHTTPToken;
    function isValidHeaderValue(potentialValue) {
      return (potentialValue[0] === "	" || potentialValue[0] === " " || potentialValue[potentialValue.length - 1] === "	" || potentialValue[potentialValue.length - 1] === " " || potentialValue.includes(`
`) || potentialValue.includes("\r") || potentialValue.includes("\0")) === !1;
    }
    __name(isValidHeaderValue, "isValidHeaderValue");
    function parseReferrerPolicy(actualResponse) {
      let policyHeader = (actualResponse.headersList.get("referrer-policy", !0) ?? "").split(","), policy = "";
      if (policyHeader.length)
        for (let i = policyHeader.length; i !== 0; i--) {
          let token = policyHeader[i - 1].trim();
          if (referrerPolicyTokens.has(token)) {
            policy = token;
            break;
          }
        }
      return policy;
    }
    __name(parseReferrerPolicy, "parseReferrerPolicy");
    function setRequestReferrerPolicyOnRedirect(request, actualResponse) {
      let policy = parseReferrerPolicy(actualResponse);
      policy !== "" && (request.referrerPolicy = policy);
    }
    __name(setRequestReferrerPolicyOnRedirect, "setRequestReferrerPolicyOnRedirect");
    function crossOriginResourcePolicyCheck() {
      return "allowed";
    }
    __name(crossOriginResourcePolicyCheck, "crossOriginResourcePolicyCheck");
    function corsCheck() {
      return "success";
    }
    __name(corsCheck, "corsCheck");
    function TAOCheck() {
      return "success";
    }
    __name(TAOCheck, "TAOCheck");
    function appendFetchMetadata(httpRequest) {
      let header = null;
      header = httpRequest.mode, httpRequest.headersList.set("sec-fetch-mode", header, !0);
    }
    __name(appendFetchMetadata, "appendFetchMetadata");
    function appendRequestOriginHeader(request) {
      let serializedOrigin = request.origin;
      if (!(serializedOrigin === "client" || serializedOrigin === void 0)) {
        if (request.responseTainting === "cors" || request.mode === "websocket")
          request.headersList.append("origin", serializedOrigin, !0);
        else if (request.method !== "GET" && request.method !== "HEAD") {
          switch (request.referrerPolicy) {
            case "no-referrer":
              serializedOrigin = null;
              break;
            case "no-referrer-when-downgrade":
            case "strict-origin":
            case "strict-origin-when-cross-origin":
              request.origin && urlHasHttpsScheme(request.origin) && !urlHasHttpsScheme(requestCurrentURL(request)) && (serializedOrigin = null);
              break;
            case "same-origin":
              sameOrigin(request, requestCurrentURL(request)) || (serializedOrigin = null);
              break;
            default:
          }
          request.headersList.append("origin", serializedOrigin, !0);
        }
      }
    }
    __name(appendRequestOriginHeader, "appendRequestOriginHeader");
    function coarsenTime(timestamp, crossOriginIsolatedCapability) {
      return timestamp;
    }
    __name(coarsenTime, "coarsenTime");
    function clampAndCoarsenConnectionTimingInfo(connectionTimingInfo, defaultStartTime, crossOriginIsolatedCapability) {
      return !connectionTimingInfo?.startTime || connectionTimingInfo.startTime < defaultStartTime ? {
        domainLookupStartTime: defaultStartTime,
        domainLookupEndTime: defaultStartTime,
        connectionStartTime: defaultStartTime,
        connectionEndTime: defaultStartTime,
        secureConnectionStartTime: defaultStartTime,
        ALPNNegotiatedProtocol: connectionTimingInfo?.ALPNNegotiatedProtocol
      } : {
        domainLookupStartTime: coarsenTime(connectionTimingInfo.domainLookupStartTime, crossOriginIsolatedCapability),
        domainLookupEndTime: coarsenTime(connectionTimingInfo.domainLookupEndTime, crossOriginIsolatedCapability),
        connectionStartTime: coarsenTime(connectionTimingInfo.connectionStartTime, crossOriginIsolatedCapability),
        connectionEndTime: coarsenTime(connectionTimingInfo.connectionEndTime, crossOriginIsolatedCapability),
        secureConnectionStartTime: coarsenTime(connectionTimingInfo.secureConnectionStartTime, crossOriginIsolatedCapability),
        ALPNNegotiatedProtocol: connectionTimingInfo.ALPNNegotiatedProtocol
      };
    }
    __name(clampAndCoarsenConnectionTimingInfo, "clampAndCoarsenConnectionTimingInfo");
    function coarsenedSharedCurrentTime(crossOriginIsolatedCapability) {
      return coarsenTime(performance2.now(), crossOriginIsolatedCapability);
    }
    __name(coarsenedSharedCurrentTime, "coarsenedSharedCurrentTime");
    function createOpaqueTimingInfo(timingInfo) {
      return {
        startTime: timingInfo.startTime ?? 0,
        redirectStartTime: 0,
        redirectEndTime: 0,
        postRedirectStartTime: timingInfo.startTime ?? 0,
        finalServiceWorkerStartTime: 0,
        finalNetworkResponseStartTime: 0,
        finalNetworkRequestStartTime: 0,
        endTime: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        finalConnectionTimingInfo: null
      };
    }
    __name(createOpaqueTimingInfo, "createOpaqueTimingInfo");
    function makePolicyContainer() {
      return {
        referrerPolicy: "strict-origin-when-cross-origin"
      };
    }
    __name(makePolicyContainer, "makePolicyContainer");
    function clonePolicyContainer(policyContainer) {
      return {
        referrerPolicy: policyContainer.referrerPolicy
      };
    }
    __name(clonePolicyContainer, "clonePolicyContainer");
    function determineRequestsReferrer(request) {
      let policy = request.referrerPolicy;
      assert(policy);
      let referrerSource = null;
      if (request.referrer === "client") {
        let globalOrigin = getGlobalOrigin();
        if (!globalOrigin || globalOrigin.origin === "null")
          return "no-referrer";
        referrerSource = new URL(globalOrigin);
      } else webidl.is.URL(request.referrer) && (referrerSource = request.referrer);
      let referrerURL = stripURLForReferrer(referrerSource), referrerOrigin = stripURLForReferrer(referrerSource, !0);
      switch (referrerURL.toString().length > 4096 && (referrerURL = referrerOrigin), policy) {
        case "no-referrer":
          return "no-referrer";
        case "origin":
          return referrerOrigin ?? stripURLForReferrer(referrerSource, !0);
        case "unsafe-url":
          return referrerURL;
        case "strict-origin": {
          let currentURL = requestCurrentURL(request);
          return isURLPotentiallyTrustworthy(referrerURL) && !isURLPotentiallyTrustworthy(currentURL) ? "no-referrer" : referrerOrigin;
        }
        case "strict-origin-when-cross-origin": {
          let currentURL = requestCurrentURL(request);
          return sameOrigin(referrerURL, currentURL) ? referrerURL : isURLPotentiallyTrustworthy(referrerURL) && !isURLPotentiallyTrustworthy(currentURL) ? "no-referrer" : referrerOrigin;
        }
        case "same-origin":
          return sameOrigin(request, referrerURL) ? referrerURL : "no-referrer";
        case "origin-when-cross-origin":
          return sameOrigin(request, referrerURL) ? referrerURL : referrerOrigin;
        case "no-referrer-when-downgrade": {
          let currentURL = requestCurrentURL(request);
          return isURLPotentiallyTrustworthy(referrerURL) && !isURLPotentiallyTrustworthy(currentURL) ? "no-referrer" : referrerURL;
        }
      }
    }
    __name(determineRequestsReferrer, "determineRequestsReferrer");
    function stripURLForReferrer(url, originOnly = !1) {
      return assert(webidl.is.URL(url)), url = new URL(url), urlIsLocal(url) ? "no-referrer" : (url.username = "", url.password = "", url.hash = "", originOnly === !0 && (url.pathname = "", url.search = ""), url);
    }
    __name(stripURLForReferrer, "stripURLForReferrer");
    var isPotentialleTrustworthyIPv4 = RegExp.prototype.test.bind(/^127\.(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)\.){2}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)$/), isPotentiallyTrustworthyIPv6 = RegExp.prototype.test.bind(/^(?:(?:0{1,4}:){7}|(?:0{1,4}:){1,6}:|::)0{0,3}1$/);
    function isOriginIPPotentiallyTrustworthy(origin) {
      return origin.includes(":") ? (origin[0] === "[" && origin[origin.length - 1] === "]" && (origin = origin.slice(1, -1)), isPotentiallyTrustworthyIPv6(origin)) : isPotentialleTrustworthyIPv4(origin);
    }
    __name(isOriginIPPotentiallyTrustworthy, "isOriginIPPotentiallyTrustworthy");
    function isOriginPotentiallyTrustworthy(origin) {
      return origin == null || origin === "null" ? !1 : (origin = new URL(origin), !!(origin.protocol === "https:" || origin.protocol === "wss:" || isOriginIPPotentiallyTrustworthy(origin.hostname) || origin.hostname === "localhost" || origin.hostname === "localhost." || origin.hostname.endsWith(".localhost") || origin.hostname.endsWith(".localhost.") || origin.protocol === "file:"));
    }
    __name(isOriginPotentiallyTrustworthy, "isOriginPotentiallyTrustworthy");
    function isURLPotentiallyTrustworthy(url) {
      return webidl.is.URL(url) ? url.href === "about:blank" || url.href === "about:srcdoc" || url.protocol === "data:" || url.protocol === "blob:" ? !0 : isOriginPotentiallyTrustworthy(url.origin) : !1;
    }
    __name(isURLPotentiallyTrustworthy, "isURLPotentiallyTrustworthy");
    function tryUpgradeRequestToAPotentiallyTrustworthyURL(request) {
    }
    __name(tryUpgradeRequestToAPotentiallyTrustworthyURL, "tryUpgradeRequestToAPotentiallyTrustworthyURL");
    function sameOrigin(A, B) {
      return A.origin === B.origin && A.origin === "null" || A.protocol === B.protocol && A.hostname === B.hostname && A.port === B.port;
    }
    __name(sameOrigin, "sameOrigin");
    function isAborted(fetchParams) {
      return fetchParams.controller.state === "aborted";
    }
    __name(isAborted, "isAborted");
    function isCancelled(fetchParams) {
      return fetchParams.controller.state === "aborted" || fetchParams.controller.state === "terminated";
    }
    __name(isCancelled, "isCancelled");
    function normalizeMethod(method) {
      return normalizedMethodRecordsBase[method.toLowerCase()] ?? method;
    }
    __name(normalizeMethod, "normalizeMethod");
    var esIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    function createIterator(name, kInternalIterator, keyIndex = 0, valueIndex = 1) {
      class FastIterableIterator {
        static {
          __name(this, "FastIterableIterator");
        }
        /** @type {any} */
        #target;
        /** @type {'key' | 'value' | 'key+value'} */
        #kind;
        /** @type {number} */
        #index;
        /**
         * @see https://webidl.spec.whatwg.org/#dfn-default-iterator-object
         * @param {unknown} target
         * @param {'key' | 'value' | 'key+value'} kind
         */
        constructor(target, kind) {
          this.#target = target, this.#kind = kind, this.#index = 0;
        }
        next() {
          if (typeof this != "object" || this === null || !(#target in this))
            throw new TypeError(
              `'next' called on an object that does not implement interface ${name} Iterator.`
            );
          let index = this.#index, values = kInternalIterator(this.#target), len = values.length;
          if (index >= len)
            return {
              value: void 0,
              done: !0
            };
          let { [keyIndex]: key, [valueIndex]: value } = values[index];
          this.#index = index + 1;
          let result;
          switch (this.#kind) {
            case "key":
              result = key;
              break;
            case "value":
              result = value;
              break;
            case "key+value":
              result = [key, value];
              break;
          }
          return {
            value: result,
            done: !1
          };
        }
      }
      return delete FastIterableIterator.prototype.constructor, Object.setPrototypeOf(FastIterableIterator.prototype, esIteratorPrototype), Object.defineProperties(FastIterableIterator.prototype, {
        [Symbol.toStringTag]: {
          writable: !1,
          enumerable: !1,
          configurable: !0,
          value: `${name} Iterator`
        },
        next: { writable: !0, enumerable: !0, configurable: !0 }
      }), function(target, kind) {
        return new FastIterableIterator(target, kind);
      };
    }
    __name(createIterator, "createIterator");
    function iteratorMixin(name, object, kInternalIterator, keyIndex = 0, valueIndex = 1) {
      let makeIterator = createIterator(name, kInternalIterator, keyIndex, valueIndex), properties = {
        keys: {
          writable: !0,
          enumerable: !0,
          configurable: !0,
          value: /* @__PURE__ */ __name(function() {
            return webidl.brandCheck(this, object), makeIterator(this, "key");
          }, "keys")
        },
        values: {
          writable: !0,
          enumerable: !0,
          configurable: !0,
          value: /* @__PURE__ */ __name(function() {
            return webidl.brandCheck(this, object), makeIterator(this, "value");
          }, "values")
        },
        entries: {
          writable: !0,
          enumerable: !0,
          configurable: !0,
          value: /* @__PURE__ */ __name(function() {
            return webidl.brandCheck(this, object), makeIterator(this, "key+value");
          }, "entries")
        },
        forEach: {
          writable: !0,
          enumerable: !0,
          configurable: !0,
          value: /* @__PURE__ */ __name(function(callbackfn, thisArg = globalThis) {
            if (webidl.brandCheck(this, object), webidl.argumentLengthCheck(arguments, 1, `${name}.forEach`), typeof callbackfn != "function")
              throw new TypeError(
                `Failed to execute 'forEach' on '${name}': parameter 1 is not of type 'Function'.`
              );
            for (let { 0: key, 1: value } of makeIterator(this, "key+value"))
              callbackfn.call(thisArg, value, key, this);
          }, "forEach")
        }
      };
      return Object.defineProperties(object.prototype, {
        ...properties,
        [Symbol.iterator]: {
          writable: !0,
          enumerable: !1,
          configurable: !0,
          value: properties.entries.value
        }
      });
    }
    __name(iteratorMixin, "iteratorMixin");
    function fullyReadBody(body, processBody, processBodyError) {
      let successSteps = processBody, errorSteps = processBodyError;
      try {
        let reader = body.stream.getReader();
        readAllBytes(reader, successSteps, errorSteps);
      } catch (e) {
        errorSteps(e);
      }
    }
    __name(fullyReadBody, "fullyReadBody");
    function readableStreamClose(controller) {
      try {
        controller.close(), controller.byobRequest?.respond(0);
      } catch (err) {
        if (!err.message.includes("Controller is already closed") && !err.message.includes("ReadableStream is already closed"))
          throw err;
      }
    }
    __name(readableStreamClose, "readableStreamClose");
    async function readAllBytes(reader, successSteps, failureSteps) {
      try {
        let bytes = [], byteLength = 0;
        do {
          let { done, value: chunk } = await reader.read();
          if (done) {
            successSteps(Buffer.concat(bytes, byteLength));
            return;
          }
          if (!isUint8Array(chunk)) {
            failureSteps(new TypeError("Received non-Uint8Array chunk"));
            return;
          }
          bytes.push(chunk), byteLength += chunk.length;
        } while (!0);
      } catch (e) {
        failureSteps(e);
      }
    }
    __name(readAllBytes, "readAllBytes");
    function urlIsLocal(url) {
      assert("protocol" in url);
      let protocol = url.protocol;
      return protocol === "about:" || protocol === "blob:" || protocol === "data:";
    }
    __name(urlIsLocal, "urlIsLocal");
    function urlHasHttpsScheme(url) {
      return typeof url == "string" && url[5] === ":" && url[0] === "h" && url[1] === "t" && url[2] === "t" && url[3] === "p" && url[4] === "s" || url.protocol === "https:";
    }
    __name(urlHasHttpsScheme, "urlHasHttpsScheme");
    function urlIsHttpHttpsScheme(url) {
      assert("protocol" in url);
      let protocol = url.protocol;
      return protocol === "http:" || protocol === "https:";
    }
    __name(urlIsHttpHttpsScheme, "urlIsHttpHttpsScheme");
    function simpleRangeHeaderValue(value, allowWhitespace) {
      let data = value;
      if (!data.startsWith("bytes"))
        return "failure";
      let position = { position: 5 };
      if (allowWhitespace && collectASequenceOfCodePoints(
        (char) => char === "	" || char === " ",
        data,
        position
      ), data.charCodeAt(position.position) !== 61)
        return "failure";
      position.position++, allowWhitespace && collectASequenceOfCodePoints(
        (char) => char === "	" || char === " ",
        data,
        position
      );
      let rangeStart = collectASequenceOfCodePoints(
        (char) => {
          let code = char.charCodeAt(0);
          return code >= 48 && code <= 57;
        },
        data,
        position
      ), rangeStartValue = rangeStart.length ? Number(rangeStart) : null;
      if (allowWhitespace && collectASequenceOfCodePoints(
        (char) => char === "	" || char === " ",
        data,
        position
      ), data.charCodeAt(position.position) !== 45)
        return "failure";
      position.position++, allowWhitespace && collectASequenceOfCodePoints(
        (char) => char === "	" || char === " ",
        data,
        position
      );
      let rangeEnd = collectASequenceOfCodePoints(
        (char) => {
          let code = char.charCodeAt(0);
          return code >= 48 && code <= 57;
        },
        data,
        position
      ), rangeEndValue = rangeEnd.length ? Number(rangeEnd) : null;
      return position.position < data.length || rangeEndValue === null && rangeStartValue === null || rangeStartValue > rangeEndValue ? "failure" : { rangeStartValue, rangeEndValue };
    }
    __name(simpleRangeHeaderValue, "simpleRangeHeaderValue");
    function buildContentRange(rangeStart, rangeEnd, fullLength) {
      let contentRange = "bytes ";
      return contentRange += isomorphicEncode(`${rangeStart}`), contentRange += "-", contentRange += isomorphicEncode(`${rangeEnd}`), contentRange += "/", contentRange += isomorphicEncode(`${fullLength}`), contentRange;
    }
    __name(buildContentRange, "buildContentRange");
    var InflateStream = class extends Transform {
      static {
        __name(this, "InflateStream");
      }
      #zlibOptions;
      /** @param {zlib.ZlibOptions} [zlibOptions] */
      constructor(zlibOptions) {
        super(), this.#zlibOptions = zlibOptions;
      }
      _transform(chunk, encoding, callback) {
        if (!this._inflateStream) {
          if (chunk.length === 0) {
            callback();
            return;
          }
          this._inflateStream = (chunk[0] & 15) === 8 ? zlib.createInflate(this.#zlibOptions) : zlib.createInflateRaw(this.#zlibOptions), this._inflateStream.on("data", this.push.bind(this)), this._inflateStream.on("end", () => this.push(null)), this._inflateStream.on("error", (err) => this.destroy(err));
        }
        this._inflateStream.write(chunk, encoding, callback);
      }
      _final(callback) {
        this._inflateStream && (this._inflateStream.end(), this._inflateStream = null), callback();
      }
    };
    function createInflate(zlibOptions) {
      return new InflateStream(zlibOptions);
    }
    __name(createInflate, "createInflate");
    function extractMimeType(headers) {
      let charset = null, essence = null, mimeType = null, values = getDecodeSplit("content-type", headers);
      if (values === null)
        return "failure";
      for (let value of values) {
        let temporaryMimeType = parseMIMEType(value);
        temporaryMimeType === "failure" || temporaryMimeType.essence === "*/*" || (mimeType = temporaryMimeType, mimeType.essence !== essence ? (charset = null, mimeType.parameters.has("charset") && (charset = mimeType.parameters.get("charset")), essence = mimeType.essence) : !mimeType.parameters.has("charset") && charset !== null && mimeType.parameters.set("charset", charset));
      }
      return mimeType ?? "failure";
    }
    __name(extractMimeType, "extractMimeType");
    function gettingDecodingSplitting(value) {
      let input = value, position = { position: 0 }, values = [], temporaryValue = "";
      for (; position.position < input.length; ) {
        if (temporaryValue += collectASequenceOfCodePoints(
          (char) => char !== '"' && char !== ",",
          input,
          position
        ), position.position < input.length)
          if (input.charCodeAt(position.position) === 34) {
            if (temporaryValue += collectAnHTTPQuotedString(
              input,
              position
            ), position.position < input.length)
              continue;
          } else
            assert(input.charCodeAt(position.position) === 44), position.position++;
        temporaryValue = removeChars(temporaryValue, !0, !0, (char) => char === 9 || char === 32), values.push(temporaryValue), temporaryValue = "";
      }
      return values;
    }
    __name(gettingDecodingSplitting, "gettingDecodingSplitting");
    function getDecodeSplit(name, list) {
      let value = list.get(name, !0);
      return value === null ? null : gettingDecodingSplitting(value);
    }
    __name(getDecodeSplit, "getDecodeSplit");
    var EnvironmentSettingsObjectBase = class {
      static {
        __name(this, "EnvironmentSettingsObjectBase");
      }
      get baseUrl() {
        return getGlobalOrigin();
      }
      get origin() {
        return this.baseUrl?.origin;
      }
      policyContainer = makePolicyContainer();
    }, EnvironmentSettingsObject = class {
      static {
        __name(this, "EnvironmentSettingsObject");
      }
      settingsObject = new EnvironmentSettingsObjectBase();
    }, environmentSettingsObject = new EnvironmentSettingsObject();
    module2.exports = {
      isAborted,
      isCancelled,
      isValidEncodedURL,
      ReadableStreamFrom,
      tryUpgradeRequestToAPotentiallyTrustworthyURL,
      clampAndCoarsenConnectionTimingInfo,
      coarsenedSharedCurrentTime,
      determineRequestsReferrer,
      makePolicyContainer,
      clonePolicyContainer,
      appendFetchMetadata,
      appendRequestOriginHeader,
      TAOCheck,
      corsCheck,
      crossOriginResourcePolicyCheck,
      createOpaqueTimingInfo,
      setRequestReferrerPolicyOnRedirect,
      isValidHTTPToken,
      requestBadPort,
      requestCurrentURL,
      responseURL,
      responseLocationURL,
      isURLPotentiallyTrustworthy,
      isValidReasonPhrase,
      sameOrigin,
      normalizeMethod,
      iteratorMixin,
      createIterator,
      isValidHeaderName,
      isValidHeaderValue,
      isErrorLike,
      fullyReadBody,
      readableStreamClose,
      urlIsLocal,
      urlHasHttpsScheme,
      urlIsHttpHttpsScheme,
      readAllBytes,
      simpleRangeHeaderValue,
      buildContentRange,
      createInflate,
      extractMimeType,
      getDecodeSplit,
      environmentSettingsObject,
      isOriginIPPotentiallyTrustworthy
    };
  }
});

// lib/web/fetch/formdata.js
var require_formdata = __commonJS({
  "lib/web/fetch/formdata.js"(exports2, module2) {
    "use strict";
    var { iteratorMixin } = require_util2(), { kEnumerableProperty } = require_util(), { webidl } = require_webidl(), nodeUtil = require("node:util"), FormData = class _FormData {
      static {
        __name(this, "FormData");
      }
      #state = [];
      constructor(form = void 0) {
        if (webidl.util.markAsUncloneable(this), form !== void 0)
          throw webidl.errors.conversionFailed({
            prefix: "FormData constructor",
            argument: "Argument 1",
            types: ["undefined"]
          });
      }
      append(name, value, filename = void 0) {
        webidl.brandCheck(this, _FormData);
        let prefix = "FormData.append";
        webidl.argumentLengthCheck(arguments, 2, prefix), name = webidl.converters.USVString(name), arguments.length === 3 || webidl.is.Blob(value) ? (value = webidl.converters.Blob(value, prefix, "value"), filename !== void 0 && (filename = webidl.converters.USVString(filename))) : value = webidl.converters.USVString(value);
        let entry = makeEntry(name, value, filename);
        this.#state.push(entry);
      }
      delete(name) {
        webidl.brandCheck(this, _FormData), webidl.argumentLengthCheck(arguments, 1, "FormData.delete"), name = webidl.converters.USVString(name), this.#state = this.#state.filter((entry) => entry.name !== name);
      }
      get(name) {
        webidl.brandCheck(this, _FormData), webidl.argumentLengthCheck(arguments, 1, "FormData.get"), name = webidl.converters.USVString(name);
        let idx = this.#state.findIndex((entry) => entry.name === name);
        return idx === -1 ? null : this.#state[idx].value;
      }
      getAll(name) {
        return webidl.brandCheck(this, _FormData), webidl.argumentLengthCheck(arguments, 1, "FormData.getAll"), name = webidl.converters.USVString(name), this.#state.filter((entry) => entry.name === name).map((entry) => entry.value);
      }
      has(name) {
        return webidl.brandCheck(this, _FormData), webidl.argumentLengthCheck(arguments, 1, "FormData.has"), name = webidl.converters.USVString(name), this.#state.findIndex((entry) => entry.name === name) !== -1;
      }
      set(name, value, filename = void 0) {
        webidl.brandCheck(this, _FormData);
        let prefix = "FormData.set";
        webidl.argumentLengthCheck(arguments, 2, prefix), name = webidl.converters.USVString(name), arguments.length === 3 || webidl.is.Blob(value) ? (value = webidl.converters.Blob(value, prefix, "value"), filename !== void 0 && (filename = webidl.converters.USVString(filename))) : value = webidl.converters.USVString(value);
        let entry = makeEntry(name, value, filename), idx = this.#state.findIndex((entry2) => entry2.name === name);
        idx !== -1 ? this.#state = [
          ...this.#state.slice(0, idx),
          entry,
          ...this.#state.slice(idx + 1).filter((entry2) => entry2.name !== name)
        ] : this.#state.push(entry);
      }
      [nodeUtil.inspect.custom](depth, options) {
        let state = this.#state.reduce((a, b) => (a[b.name] ? Array.isArray(a[b.name]) ? a[b.name].push(b.value) : a[b.name] = [a[b.name], b.value] : a[b.name] = b.value, a), { __proto__: null });
        options.depth ??= depth, options.colors ??= !0;
        let output = nodeUtil.formatWithOptions(options, state);
        return `FormData ${output.slice(output.indexOf("]") + 2)}`;
      }
      /**
       * @param {FormData} formData
       */
      static getFormDataState(formData) {
        return formData.#state;
      }
      /**
       * @param {FormData} formData
       * @param {any[]} newState
       */
      static setFormDataState(formData, newState) {
        formData.#state = newState;
      }
    }, { getFormDataState, setFormDataState } = FormData;
    Reflect.deleteProperty(FormData, "getFormDataState");
    Reflect.deleteProperty(FormData, "setFormDataState");
    iteratorMixin("FormData", FormData, getFormDataState, "name", "value");
    Object.defineProperties(FormData.prototype, {
      append: kEnumerableProperty,
      delete: kEnumerableProperty,
      get: kEnumerableProperty,
      getAll: kEnumerableProperty,
      has: kEnumerableProperty,
      set: kEnumerableProperty,
      [Symbol.toStringTag]: {
        value: "FormData",
        configurable: !0
      }
    });
    function makeEntry(name, value, filename) {
      if (typeof value != "string") {
        if (webidl.is.File(value) || (value = new File([value], "blob", { type: value.type })), filename !== void 0) {
          let options = {
            type: value.type,
            lastModified: value.lastModified
          };
          value = new File([value], filename, options);
        }
      }
      return { name, value };
    }
    __name(makeEntry, "makeEntry");
    webidl.is.FormData = webidl.util.MakeTypeAssertion(FormData);
    module2.exports = { FormData, makeEntry, setFormDataState };
  }
});

// lib/web/fetch/formdata-parser.js
var require_formdata_parser = __commonJS({
  "lib/web/fetch/formdata-parser.js"(exports2, module2) {
    "use strict";
    var { bufferToLowerCasedHeaderName } = require_util(), { HTTP_TOKEN_CODEPOINTS } = require_data_url(), { makeEntry } = require_formdata(), { webidl } = require_webidl(), assert = require("node:assert"), { isomorphicDecode } = require_infra(), { utf8DecodeBytes } = require_encoding(), dd = Buffer.from("--"), decoder = new TextDecoder();
    function isAsciiString(chars) {
      for (let i = 0; i < chars.length; ++i)
        if ((chars.charCodeAt(i) & -128) !== 0)
          return !1;
      return !0;
    }
    __name(isAsciiString, "isAsciiString");
    function validateBoundary(boundary) {
      let length = boundary.length;
      if (length < 27 || length > 70)
        return !1;
      for (let i = 0; i < length; ++i) {
        let cp = boundary.charCodeAt(i);
        if (!(cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp === 39 || cp === 45 || cp === 95))
          return !1;
      }
      return !0;
    }
    __name(validateBoundary, "validateBoundary");
    function multipartFormDataParser(input, mimeType) {
      assert(mimeType !== "failure" && mimeType.essence === "multipart/form-data");
      let boundaryString = mimeType.parameters.get("boundary");
      if (boundaryString === void 0)
        throw parsingError("missing boundary in content-type header");
      let boundary = Buffer.from(`--${boundaryString}`, "utf8"), entryList = [], position = { position: 0 }, firstBoundaryIndex = input.indexOf(boundary);
      if (firstBoundaryIndex === -1)
        throw parsingError("no boundary found in multipart body");
      for (position.position = firstBoundaryIndex; ; ) {
        if (input.subarray(position.position, position.position + boundary.length).equals(boundary))
          position.position += boundary.length;
        else
          throw parsingError("expected a value starting with -- and the boundary");
        if (bufferStartsWith(input, dd, position))
          return entryList;
        if (input[position.position] !== 13 || input[position.position + 1] !== 10)
          throw parsingError("expected CRLF");
        position.position += 2;
        let result = parseMultipartFormDataHeaders(input, position), { name, filename, contentType, encoding } = result;
        position.position += 2;
        let body;
        {
          let boundaryIndex = input.indexOf(boundary.subarray(2), position.position);
          if (boundaryIndex === -1)
            throw parsingError("expected boundary after body");
          body = input.subarray(position.position, boundaryIndex - 4), position.position += body.length, encoding === "base64" && (body = Buffer.from(body.toString(), "base64"));
        }
        if (input[position.position] !== 13 || input[position.position + 1] !== 10)
          throw parsingError("expected CRLF");
        position.position += 2;
        let value;
        filename !== null ? (contentType ??= "text/plain", isAsciiString(contentType) || (contentType = ""), value = new File([body], filename, { type: contentType })) : value = utf8DecodeBytes(Buffer.from(body)), assert(webidl.is.USVString(name)), assert(typeof value == "string" && webidl.is.USVString(value) || webidl.is.File(value)), entryList.push(makeEntry(name, value, filename));
      }
    }
    __name(multipartFormDataParser, "multipartFormDataParser");
    function parseContentDispositionAttribute(input, position) {
      input[position.position] === 59 && position.position++, collectASequenceOfBytes(
        (char) => char === 32 || char === 9,
        input,
        position
      );
      let attributeName = collectASequenceOfBytes(
        (char) => isToken(char) && char !== 61 && char !== 42,
        // not = or *
        input,
        position
      );
      if (attributeName.length === 0)
        return null;
      let attrNameStr = attributeName.toString("ascii").toLowerCase(), isExtended = input[position.position] === 42;
      if (isExtended && position.position++, input[position.position] !== 61)
        return null;
      position.position++, collectASequenceOfBytes(
        (char) => char === 32 || char === 9,
        input,
        position
      );
      let value;
      if (isExtended) {
        let headerValue = collectASequenceOfBytes(
          (char) => char !== 32 && char !== 13 && char !== 10 && char !== 59,
          // not space, CRLF, or ;
          input,
          position
        );
        if (headerValue[0] !== 117 && headerValue[0] !== 85 || // u or U
        headerValue[1] !== 116 && headerValue[1] !== 84 || // t or T
        headerValue[2] !== 102 && headerValue[2] !== 70 || // f or F
        headerValue[3] !== 45 || // -
        headerValue[4] !== 56)
          throw parsingError("unknown encoding, expected utf-8''");
        value = decodeURIComponent(decoder.decode(headerValue.subarray(7)));
      } else if (input[position.position] === 34) {
        position.position++;
        let quotedValue = collectASequenceOfBytes(
          (char) => char !== 10 && char !== 13 && char !== 34,
          // not LF, CR, or "
          input,
          position
        );
        if (input[position.position] !== 34)
          throw parsingError("Closing quote not found");
        position.position++, value = decoder.decode(quotedValue).replace(/%0A/ig, `
`).replace(/%0D/ig, "\r").replace(/%22/g, '"');
      } else {
        let tokenValue = collectASequenceOfBytes(
          (char) => isToken(char) && char !== 59,
          // not ;
          input,
          position
        );
        value = decoder.decode(tokenValue);
      }
      return { name: attrNameStr, value };
    }
    __name(parseContentDispositionAttribute, "parseContentDispositionAttribute");
    function parseMultipartFormDataHeaders(input, position) {
      let name = null, filename = null, contentType = null, encoding = null;
      for (; ; ) {
        if (input[position.position] === 13 && input[position.position + 1] === 10) {
          if (name === null)
            throw parsingError("header name is null");
          return { name, filename, contentType, encoding };
        }
        let headerName = collectASequenceOfBytes(
          (char) => char !== 10 && char !== 13 && char !== 58,
          input,
          position
        );
        if (headerName = removeChars(headerName, !0, !0, (char) => char === 9 || char === 32), !HTTP_TOKEN_CODEPOINTS.test(headerName.toString()))
          throw parsingError("header name does not match the field-name token production");
        if (input[position.position] !== 58)
          throw parsingError("expected :");
        switch (position.position++, collectASequenceOfBytes(
          (char) => char === 32 || char === 9,
          input,
          position
        ), bufferToLowerCasedHeaderName(headerName)) {
          case "content-disposition": {
            if (name = filename = null, collectASequenceOfBytes(
              (char) => isToken(char),
              input,
              position
            ).toString("ascii").toLowerCase() !== "form-data")
              throw parsingError("expected form-data for content-disposition header");
            for (; position.position < input.length && input[position.position] !== 13 && input[position.position + 1] !== 10; ) {
              let attribute = parseContentDispositionAttribute(input, position);
              if (!attribute)
                break;
              attribute.name === "name" ? name = attribute.value : attribute.name === "filename" && (filename = attribute.value);
            }
            if (name === null)
              throw parsingError("name attribute is required in content-disposition header");
            break;
          }
          case "content-type": {
            let headerValue = collectASequenceOfBytes(
              (char) => char !== 10 && char !== 13,
              input,
              position
            );
            headerValue = removeChars(headerValue, !1, !0, (char) => char === 9 || char === 32), contentType = isomorphicDecode(headerValue);
            break;
          }
          case "content-transfer-encoding": {
            let headerValue = collectASequenceOfBytes(
              (char) => char !== 10 && char !== 13,
              input,
              position
            );
            headerValue = removeChars(headerValue, !1, !0, (char) => char === 9 || char === 32), encoding = isomorphicDecode(headerValue);
            break;
          }
          default:
            collectASequenceOfBytes(
              (char) => char !== 10 && char !== 13,
              input,
              position
            );
        }
        if (input[position.position] !== 13 && input[position.position + 1] !== 10)
          throw parsingError("expected CRLF");
        position.position += 2;
      }
    }
    __name(parseMultipartFormDataHeaders, "parseMultipartFormDataHeaders");
    function collectASequenceOfBytes(condition, input, position) {
      let start = position.position;
      for (; start < input.length && condition(input[start]); )
        ++start;
      return input.subarray(position.position, position.position = start);
    }
    __name(collectASequenceOfBytes, "collectASequenceOfBytes");
    function removeChars(buf, leading, trailing, predicate) {
      let lead = 0, trail = buf.length - 1;
      if (leading)
        for (; lead < buf.length && predicate(buf[lead]); ) lead++;
      if (trailing)
        for (; trail > 0 && predicate(buf[trail]); ) trail--;
      return lead === 0 && trail === buf.length - 1 ? buf : buf.subarray(lead, trail + 1);
    }
    __name(removeChars, "removeChars");
    function bufferStartsWith(buffer, start, position) {
      if (buffer.length < start.length)
        return !1;
      for (let i = 0; i < start.length; i++)
        if (start[i] !== buffer[position.position + i])
          return !1;
      return !0;
    }
    __name(bufferStartsWith, "bufferStartsWith");
    function parsingError(cause) {
      return new TypeError("Failed to parse body as FormData.", { cause: new TypeError(cause) });
    }
    __name(parsingError, "parsingError");
    function isCTL(char) {
      return char <= 31 || char === 127;
    }
    __name(isCTL, "isCTL");
    function isTSpecial(char) {
      return char === 40 || // (
      char === 41 || // )
      char === 60 || // <
      char === 62 || // >
      char === 64 || // @
      char === 44 || // ,
      char === 59 || // ;
      char === 58 || // :
      char === 92 || // \
      char === 34 || // "
      char === 47 || // /
      char === 91 || // [
      char === 93 || // ]
      char === 63 || // ?
      char === 61;
    }
    __name(isTSpecial, "isTSpecial");
    function isToken(char) {
      return char <= 127 && // ascii
      char !== 32 && // space
      char !== 9 && !isCTL(char) && !isTSpecial(char);
    }
    __name(isToken, "isToken");
    module2.exports = {
      multipartFormDataParser,
      validateBoundary
    };
  }
});

// lib/util/promise.js
var require_promise = __commonJS({
  "lib/util/promise.js"(exports2, module2) {
    "use strict";
    function createDeferredPromise() {
      let res, rej;
      return { promise: new Promise((resolve, reject) => {
        res = resolve, rej = reject;
      }), resolve: res, reject: rej };
    }
    __name(createDeferredPromise, "createDeferredPromise");
    module2.exports = {
      createDeferredPromise
    };
  }
});

// lib/web/fetch/body.js
var require_body = __commonJS({
  "lib/web/fetch/body.js"(exports2, module2) {
    "use strict";
    var util = require_util(), {
      ReadableStreamFrom,
      readableStreamClose,
      fullyReadBody,
      extractMimeType
    } = require_util2(), { FormData, setFormDataState } = require_formdata(), { webidl } = require_webidl(), assert = require("node:assert"), { isErrored, isDisturbed } = require("node:stream"), { isArrayBuffer } = require("node:util/types"), { serializeAMimeType } = require_data_url(), { multipartFormDataParser } = require_formdata_parser(), { createDeferredPromise } = require_promise(), { parseJSONFromBytes } = require_infra(), { utf8DecodeBytes } = require_encoding(), { runtimeFeatures } = require_runtime_features(), random = runtimeFeatures.has("crypto") ? require("node:crypto").randomInt : (max) => Math.floor(Math.random() * max), textEncoder = new TextEncoder();
    function noop() {
    }
    __name(noop, "noop");
    var streamRegistry = new FinalizationRegistry((weakRef) => {
      let stream = weakRef.deref();
      stream && !stream.locked && !isDisturbed(stream) && !isErrored(stream) && stream.cancel("Response object has been garbage collected").catch(noop);
    });
    function extractBody(object, keepalive = !1) {
      let stream = null;
      webidl.is.ReadableStream(object) ? stream = object : webidl.is.Blob(object) ? stream = object.stream() : stream = new ReadableStream({
        pull(controller) {
          let buffer = typeof source == "string" ? textEncoder.encode(source) : source;
          buffer.byteLength && controller.enqueue(buffer), queueMicrotask(() => readableStreamClose(controller));
        },
        start() {
        },
        type: "bytes"
      }), assert(webidl.is.ReadableStream(stream));
      let action = null, source = null, length = null, type = null;
      if (typeof object == "string")
        source = object, type = "text/plain;charset=UTF-8";
      else if (webidl.is.URLSearchParams(object))
        source = object.toString(), type = "application/x-www-form-urlencoded;charset=UTF-8";
      else if (webidl.is.BufferSource(object))
        source = isArrayBuffer(object) ? new Uint8Array(object.slice()) : new Uint8Array(object.buffer.slice(object.byteOffset, object.byteOffset + object.byteLength));
      else if (webidl.is.FormData(object)) {
        let boundary = `----formdata-undici-0${`${random(1e11)}`.padStart(11, "0")}`, prefix = `--${boundary}\r
Content-Disposition: form-data`;
        let formdataEscape = /* @__PURE__ */ __name((str) => str.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22"), "formdataEscape"), normalizeLinefeeds = /* @__PURE__ */ __name((value) => value.replace(/\r?\n|\r/g, `\r
`), "normalizeLinefeeds"), blobParts = [], rn = new Uint8Array([13, 10]);
        length = 0;
        let hasUnknownSizeValue = !1;
        for (let [name, value] of object)
          if (typeof value == "string") {
            let chunk2 = textEncoder.encode(prefix + `; name="${formdataEscape(normalizeLinefeeds(name))}"\r
\r
${normalizeLinefeeds(value)}\r
`);
            blobParts.push(chunk2), length += chunk2.byteLength;
          } else {
            let chunk2 = textEncoder.encode(`${prefix}; name="${formdataEscape(normalizeLinefeeds(name))}"` + (value.name ? `; filename="${formdataEscape(value.name)}"` : "") + `\r
Content-Type: ${value.type || "application/octet-stream"}\r
\r
`);
            blobParts.push(chunk2, value, rn), typeof value.size == "number" ? length += chunk2.byteLength + value.size + rn.byteLength : hasUnknownSizeValue = !0;
          }
        let chunk = textEncoder.encode(`--${boundary}--\r
`);
        blobParts.push(chunk), length += chunk.byteLength, hasUnknownSizeValue && (length = null), source = object, action = /* @__PURE__ */ __name(async function* () {
          for (let part of blobParts)
            part.stream ? yield* part.stream() : yield part;
        }, "action"), type = `multipart/form-data; boundary=${boundary}`;
      } else if (webidl.is.Blob(object))
        source = object, length = object.size, object.type && (type = object.type);
      else if (typeof object[Symbol.asyncIterator] == "function") {
        if (keepalive)
          throw new TypeError("keepalive");
        if (util.isDisturbed(object) || object.locked)
          throw new TypeError(
            "Response body object should not be disturbed or locked"
          );
        stream = webidl.is.ReadableStream(object) ? object : ReadableStreamFrom(object);
      }
      if ((typeof source == "string" || util.isBuffer(source)) && (length = Buffer.byteLength(source)), action != null) {
        let iterator;
        stream = new ReadableStream({
          start() {
            iterator = action(object)[Symbol.asyncIterator]();
          },
          pull(controller) {
            return iterator.next().then(({ value, done }) => {
              if (done)
                queueMicrotask(() => {
                  controller.close(), controller.byobRequest?.respond(0);
                });
              else if (!isErrored(stream)) {
                let buffer = new Uint8Array(value);
                buffer.byteLength && controller.enqueue(buffer);
              }
              return controller.desiredSize > 0;
            });
          },
          cancel(reason) {
            return iterator.return();
          },
          type: "bytes"
        });
      }
      return [{ stream, source, length }, type];
    }
    __name(extractBody, "extractBody");
    function safelyExtractBody(object, keepalive = !1) {
      return webidl.is.ReadableStream(object) && (assert(!util.isDisturbed(object), "The body has already been consumed."), assert(!object.locked, "The stream is locked.")), extractBody(object, keepalive);
    }
    __name(safelyExtractBody, "safelyExtractBody");
    function cloneBody(body) {
      let { 0: out1, 1: out2 } = body.stream.tee();
      return body.stream = out1, {
        stream: out2,
        length: body.length,
        source: body.source
      };
    }
    __name(cloneBody, "cloneBody");
    function bodyMixinMethods(instance, getInternalState) {
      return {
        blob() {
          return consumeBody(this, (bytes) => {
            let mimeType = bodyMimeType(getInternalState(this));
            return mimeType === null ? mimeType = "" : mimeType && (mimeType = serializeAMimeType(mimeType)), new Blob([bytes], { type: mimeType });
          }, instance, getInternalState);
        },
        arrayBuffer() {
          return consumeBody(this, (bytes) => new Uint8Array(bytes).buffer, instance, getInternalState);
        },
        text() {
          return consumeBody(this, utf8DecodeBytes, instance, getInternalState);
        },
        json() {
          return consumeBody(this, parseJSONFromBytes, instance, getInternalState);
        },
        formData() {
          return consumeBody(this, (value) => {
            let mimeType = bodyMimeType(getInternalState(this));
            if (mimeType !== null)
              switch (mimeType.essence) {
                case "multipart/form-data": {
                  let parsed = multipartFormDataParser(value, mimeType), fd = new FormData();
                  return setFormDataState(fd, parsed), fd;
                }
                case "application/x-www-form-urlencoded": {
                  let entries = new URLSearchParams(value.toString()), fd = new FormData();
                  for (let [name, value2] of entries)
                    fd.append(name, value2);
                  return fd;
                }
              }
            throw new TypeError(
              'Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".'
            );
          }, instance, getInternalState);
        },
        bytes() {
          return consumeBody(this, (bytes) => new Uint8Array(bytes), instance, getInternalState);
        }
      };
    }
    __name(bodyMixinMethods, "bodyMixinMethods");
    function mixinBody(prototype, getInternalState) {
      Object.assign(prototype.prototype, bodyMixinMethods(prototype, getInternalState));
    }
    __name(mixinBody, "mixinBody");
    function consumeBody(object, convertBytesToJSValue, instance, getInternalState) {
      try {
        webidl.brandCheck(object, instance);
      } catch (e) {
        return Promise.reject(e);
      }
      let state = getInternalState(object);
      if (bodyUnusable(state))
        return Promise.reject(new TypeError("Body is unusable: Body has already been read"));
      if (state.aborted)
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      let promise = createDeferredPromise(), errorSteps = promise.reject, successSteps = /* @__PURE__ */ __name((data) => {
        try {
          promise.resolve(convertBytesToJSValue(data));
        } catch (e) {
          errorSteps(e);
        }
      }, "successSteps");
      return state.body == null ? (successSteps(Buffer.allocUnsafe(0)), promise.promise) : (fullyReadBody(state.body, successSteps, errorSteps), promise.promise);
    }
    __name(consumeBody, "consumeBody");
    function bodyUnusable(object) {
      let body = object.body;
      return body != null && (body.stream.locked || util.isDisturbed(body.stream));
    }
    __name(bodyUnusable, "bodyUnusable");
    function bodyMimeType(requestOrResponse) {
      let headers = requestOrResponse.headersList, mimeType = extractMimeType(headers);
      return mimeType === "failure" ? null : mimeType;
    }
    __name(bodyMimeType, "bodyMimeType");
    module2.exports = {
      extractBody,
      safelyExtractBody,
      cloneBody,
      mixinBody,
      streamRegistry,
      bodyUnusable
    };
  }
});

// lib/dispatcher/client-h1.js
var require_client_h1 = __commonJS({
  "lib/dispatcher/client-h1.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), util = require_util(), { channels } = require_diagnostics(), timers = require_timers(), {
      RequestContentLengthMismatchError,
      ResponseContentLengthMismatchError,
      RequestAbortedError,
      HeadersTimeoutError,
      HeadersOverflowError,
      SocketError,
      InformationalError,
      BodyTimeoutError,
      HTTPParserError,
      ResponseExceededMaxSizeError
    } = require_errors(), {
      kUrl,
      kReset,
      kClient,
      kParser,
      kBlocking,
      kRunning,
      kPending,
      kSize,
      kWriting,
      kQueue,
      kNoRef,
      kKeepAliveDefaultTimeout,
      kHostHeader,
      kPendingIdx,
      kRunningIdx,
      kError,
      kPipelining,
      kSocket,
      kKeepAliveTimeoutValue,
      kMaxHeadersSize,
      kKeepAliveMaxTimeout,
      kKeepAliveTimeoutThreshold,
      kHeadersTimeout,
      kBodyTimeout,
      kStrictContentLength,
      kMaxRequests,
      kCounter,
      kMaxResponseSize,
      kOnError,
      kResume,
      kHTTPContext,
      kClosed
    } = require_symbols(), constants = require_constants2(), nativeLlhttp = require_native(), EMPTY_BUF = Buffer.alloc(0), FastBuffer = Buffer[Symbol.species], removeAllListeners = util.removeAllListeners, extractBody;
    function lazyllhttp() {
      return nativeLlhttp();
    }
    __name(lazyllhttp, "lazyllhttp");
    var llhttpInstance = null, currentParser = null, currentBufferRef = null, currentBufferSize = 0, currentBufferPtr = null, USE_NATIVE_TIMER = 0, USE_FAST_TIMER = 1, TIMEOUT_HEADERS = 2 | USE_FAST_TIMER, TIMEOUT_BODY = 4 | USE_FAST_TIMER, TIMEOUT_KEEP_ALIVE = 8 | USE_NATIVE_TIMER, Parser = class {
      static {
        __name(this, "Parser");
      }
      /**
         * @param {import('./client.js')} client
         * @param {import('net').Socket} socket
         * @param {*} llhttp
         */
      constructor(client, socket, { exports: exports3 }) {
        this.llhttp = exports3, this.ptr = this.llhttp.native ? this.llhttp.llhttp_alloc(constants.TYPE.RESPONSE, this) : this.llhttp.llhttp_alloc(constants.TYPE.RESPONSE), this.client = client, this.socket = socket, this.timeout = null, this.timeoutValue = null, this.timeoutType = null, this.statusCode = 0, this.statusText = "", this.upgrade = !1, this.headers = [], this.headersSize = 0, this.headersMaxSize = client[kMaxHeadersSize], this.shouldKeepAlive = !1, this.paused = !1, this.resume = this.resume.bind(this), this.bytesRead = 0, this.keepAlive = "", this.contentLength = "", this.connection = "", this.maxResponseSize = client[kMaxResponseSize];
      }
      setTimeout(delay, type) {
        delay !== this.timeoutValue || type & USE_FAST_TIMER ^ this.timeoutType & USE_FAST_TIMER ? (this.timeout && (timers.clearTimeout(this.timeout), this.timeout = null), delay && (type & USE_FAST_TIMER ? this.timeout = timers.setFastTimeout(onParserTimeout, delay, new WeakRef(this)) : (this.timeout = setTimeout(onParserTimeout, delay, new WeakRef(this)), this.timeout?.unref())), this.timeoutValue = delay) : this.timeout && this.timeout.refresh && this.timeout.refresh(), this.timeoutType = type;
      }
      resume() {
        this.socket.destroyed || !this.paused || (assert(this.ptr != null), assert(currentParser === null), this.llhttp.llhttp_resume(this.ptr), assert(this.timeoutType === TIMEOUT_BODY), this.timeout && this.timeout.refresh && this.timeout.refresh(), this.paused = !1, this.execute(this.socket.read() || EMPTY_BUF), this.readMore());
      }
      readMore() {
        for (; !this.paused && this.ptr; ) {
          let chunk = this.socket.read();
          if (chunk === null)
            break;
          this.execute(chunk);
        }
      }
      /**
       * @param {Buffer} chunk
       */
      execute(chunk) {
        assert(currentParser === null), assert(this.ptr != null), assert(!this.paused);
        let { socket, llhttp } = this;
        try {
          let ret;
          try {
            currentParser = this, llhttp.native ? ret = llhttp.llhttp_execute(this.ptr, chunk) : (chunk.length > currentBufferSize && (currentBufferPtr && llhttp.free(currentBufferPtr), currentBufferSize = Math.ceil(chunk.length / 4096) * 4096, currentBufferPtr = llhttp.malloc(currentBufferSize)), new Uint8Array(llhttp.memory.buffer, currentBufferPtr, currentBufferSize).set(chunk), currentBufferRef = chunk, ret = llhttp.llhttp_execute(this.ptr, currentBufferPtr, chunk.length));
          } finally {
            currentParser = null, currentBufferRef = null;
          }
          if (ret !== constants.ERROR.OK) {
            let data = llhttp.native ? chunk.subarray(llhttp.llhttp_get_error_pos(this.ptr)) : chunk.subarray(llhttp.llhttp_get_error_pos(this.ptr) - currentBufferPtr);
            if (ret === constants.ERROR.PAUSED_UPGRADE)
              this.onUpgrade(data);
            else if (ret === constants.ERROR.PAUSED)
              this.paused = !0, socket.unshift(data);
            else {
              let ptr = llhttp.native ? 0 : llhttp.llhttp_get_error_reason(this.ptr), message = "";
              if (llhttp.native)
                message = llhttp.llhttp_get_error_reason_string(this.ptr) || "";
              else if (ptr) {
                let len = new Uint8Array(llhttp.memory.buffer, ptr).indexOf(0);
                message = "Response does not match the HTTP/1.1 protocol (" + Buffer.from(llhttp.memory.buffer, ptr, len).toString() + ")";
              }
              throw new HTTPParserError(message, constants.ERROR[ret], data);
            }
          }
        } catch (err) {
          util.destroy(socket, err);
        }
      }
      destroy() {
        assert(currentParser === null), assert(this.ptr != null), this.llhttp.llhttp_free(this.ptr), this.ptr = null, this.timeout && timers.clearTimeout(this.timeout), this.timeout = null, this.timeoutValue = null, this.timeoutType = null, this.paused = !1;
      }
      /**
       * @param {Buffer} buf
       * @returns {0}
       */
      onStatus(buf) {
        return this.statusText = buf.toString(), 0;
      }
      /**
       * @returns {0|-1}
       */
      onMessageBegin() {
        let { socket, client } = this;
        if (socket.destroyed)
          return -1;
        let request = client[kQueue][client[kRunningIdx]];
        return request ? (request.onResponseStarted(), 0) : -1;
      }
      /**
       * @param {Buffer} buf
       * @returns {number}
       */
      onHeaderField(buf) {
        let len = this.headers.length;
        return (len & 1) === 0 ? this.headers.push(buf) : this.headers[len - 1] = Buffer.concat([this.headers[len - 1], buf]), this.trackHeader(buf.length), 0;
      }
      /**
       * @param {Buffer} buf
       * @returns {number}
       */
      onHeaderValue(buf) {
        let len = this.headers.length;
        (len & 1) === 1 ? (this.headers.push(buf), len += 1) : this.headers[len - 1] = Buffer.concat([this.headers[len - 1], buf]);
        let key = this.headers[len - 2];
        if (key.length === 10) {
          let headerName = util.bufferToLowerCasedHeaderName(key);
          headerName === "keep-alive" ? this.keepAlive += buf.toString() : headerName === "connection" && (this.connection += buf.toString());
        } else key.length === 14 && util.bufferToLowerCasedHeaderName(key) === "content-length" && (this.contentLength += buf.toString());
        return this.trackHeader(buf.length), 0;
      }
      /**
       * @param {number} len
       */
      trackHeader(len) {
        this.headersSize += len, this.headersSize >= this.headersMaxSize && util.destroy(this.socket, new HeadersOverflowError());
      }
      /**
       * @param {Buffer} head
       */
      onUpgrade(head) {
        let { upgrade, client, socket, headers, statusCode } = this;
        assert(upgrade), assert(client[kSocket] === socket), assert(!socket.destroyed), assert(!this.paused), assert((headers.length & 1) === 0);
        let request = client[kQueue][client[kRunningIdx]];
        assert(request), assert(request.upgrade || request.method === "CONNECT"), this.statusCode = 0, this.statusText = "", this.shouldKeepAlive = !1, this.headers = [], this.headersSize = 0, socket.unshift(head), socket[kParser].destroy(), socket[kParser] = null, socket[kClient] = null, socket[kError] = null, removeAllListeners(socket), client[kSocket] = null, client[kHTTPContext] = null, client[kQueue][client[kRunningIdx]++] = null, client.emit("disconnect", client[kUrl], [client], new InformationalError("upgrade"));
        try {
          request.onUpgrade(statusCode, headers, socket);
        } catch (err) {
          util.destroy(socket, err);
        }
        client[kResume]();
      }
      /**
       * @param {number} statusCode
       * @param {boolean} upgrade
       * @param {boolean} shouldKeepAlive
       * @returns {number}
       */
      onHeadersComplete(statusCode, upgrade, shouldKeepAlive) {
        let { client, socket, headers, statusText } = this;
        if (socket.destroyed)
          return -1;
        let request = client[kQueue][client[kRunningIdx]];
        if (!request)
          return -1;
        if (assert(!this.upgrade), assert(this.statusCode < 200), statusCode === 100)
          return util.destroy(socket, new SocketError("bad response", util.getSocketInfo(socket))), -1;
        if (upgrade && !request.upgrade)
          return util.destroy(socket, new SocketError("bad upgrade", util.getSocketInfo(socket))), -1;
        if (assert(this.timeoutType === TIMEOUT_HEADERS), this.statusCode = statusCode, this.shouldKeepAlive = shouldKeepAlive || // Override llhttp value which does not allow keepAlive for HEAD.
        request.method === "HEAD" && !socket[kReset] && this.connection.toLowerCase() === "keep-alive", this.statusCode >= 200) {
          let bodyTimeout = request.bodyTimeout != null ? request.bodyTimeout : client[kBodyTimeout];
          this.setTimeout(bodyTimeout, TIMEOUT_BODY);
        } else this.timeout && this.timeout.refresh && this.timeout.refresh();
        if (request.method === "CONNECT")
          return assert(client[kRunning] === 1), this.upgrade = !0, 2;
        if (upgrade)
          return assert(client[kRunning] === 1), this.upgrade = !0, 2;
        if (assert((this.headers.length & 1) === 0), this.headers = [], this.headersSize = 0, this.shouldKeepAlive && client[kPipelining]) {
          let keepAliveTimeout = this.keepAlive ? util.parseKeepAliveTimeout(this.keepAlive) : null;
          if (keepAliveTimeout != null) {
            let timeout = Math.min(
              keepAliveTimeout - client[kKeepAliveTimeoutThreshold],
              client[kKeepAliveMaxTimeout]
            );
            timeout <= 0 ? socket[kReset] = !0 : client[kKeepAliveTimeoutValue] = timeout;
          } else
            client[kKeepAliveTimeoutValue] = client[kKeepAliveDefaultTimeout];
        } else
          socket[kReset] = !0;
        let pause = request.onHeaders(statusCode, headers, this.resume, statusText) === !1;
        return request.aborted ? -1 : request.method === "HEAD" || statusCode < 200 ? 1 : (socket[kBlocking] && (socket[kBlocking] = !1, client[kResume]()), pause ? constants.ERROR.PAUSED : 0);
      }
      /**
       * @param {Buffer} buf
       * @returns {number}
       */
      onBody(buf) {
        let { client, socket, statusCode, maxResponseSize } = this;
        if (socket.destroyed)
          return -1;
        let request = client[kQueue][client[kRunningIdx]];
        return assert(request), assert(this.timeoutType === TIMEOUT_BODY), this.timeout && this.timeout.refresh && this.timeout.refresh(), assert(statusCode >= 200), maxResponseSize > -1 && this.bytesRead + buf.length > maxResponseSize ? (util.destroy(socket, new ResponseExceededMaxSizeError()), -1) : (this.bytesRead += buf.length, request.onData(buf) === !1 ? constants.ERROR.PAUSED : 0);
      }
      /**
       * @returns {number}
       */
      onMessageComplete() {
        let { client, socket, statusCode, upgrade, headers, contentLength, bytesRead, shouldKeepAlive } = this;
        if (socket.destroyed && (!statusCode || shouldKeepAlive))
          return -1;
        if (upgrade)
          return 0;
        assert(statusCode >= 100), assert((this.headers.length & 1) === 0);
        let request = client[kQueue][client[kRunningIdx]];
        if (assert(request), this.statusCode = 0, this.statusText = "", this.bytesRead = 0, this.contentLength = "", this.keepAlive = "", this.connection = "", this.headers = [], this.headersSize = 0, statusCode < 200)
          return 0;
        if (request.method !== "HEAD" && contentLength && bytesRead !== parseInt(contentLength, 10))
          return util.destroy(socket, new ResponseContentLengthMismatchError()), -1;
        if (request.onComplete(headers), client[kQueue][client[kRunningIdx]++] = null, socket[kWriting])
          return assert(client[kRunning] === 0), util.destroy(socket, new InformationalError("reset")), constants.ERROR.PAUSED;
        if (shouldKeepAlive) {
          if (socket[kReset] && client[kRunning] === 0)
            return util.destroy(socket, new InformationalError("reset")), constants.ERROR.PAUSED;
          client[kPipelining] == null || client[kPipelining] === 1 ? setImmediate(client[kResume]) : client[kResume]();
        } else return util.destroy(socket, new InformationalError("reset")), constants.ERROR.PAUSED;
        return 0;
      }
    };
    function onParserTimeout(parser) {
      let { socket, timeoutType, client, paused } = parser.deref();
      timeoutType === TIMEOUT_HEADERS ? (!socket[kWriting] || socket.writableNeedDrain || client[kRunning] > 1) && (assert(!paused, "cannot be paused while waiting for headers"), util.destroy(socket, new HeadersTimeoutError())) : timeoutType === TIMEOUT_BODY ? paused || util.destroy(socket, new BodyTimeoutError()) : timeoutType === TIMEOUT_KEEP_ALIVE && (assert(client[kRunning] === 0 && client[kKeepAliveTimeoutValue]), util.destroy(socket, new InformationalError("socket idle timeout")));
    }
    __name(onParserTimeout, "onParserTimeout");
    function connectH1(client, socket) {
      if (client[kSocket] = socket, llhttpInstance || (llhttpInstance = lazyllhttp()), socket.errored)
        throw socket.errored;
      if (socket.destroyed)
        throw new SocketError("destroyed");
      return socket[kNoRef] = !1, socket[kWriting] = !1, socket[kReset] = !1, socket[kBlocking] = !1, socket[kParser] = new Parser(client, socket, llhttpInstance), util.addListener(socket, "error", onHttpSocketError), util.addListener(socket, "readable", onHttpSocketReadable), util.addListener(socket, "end", onHttpSocketEnd), util.addListener(socket, "close", onHttpSocketClose), socket[kClosed] = !1, socket.on("close", onSocketClose), {
        version: "h1",
        defaultPipelining: 1,
        write(request) {
          return writeH1(client, request);
        },
        resume() {
          resumeH1(client);
        },
        /**
         * @param {Error|undefined} err
         * @param {() => void} callback
         */
        destroy(err, callback) {
          socket[kClosed] ? queueMicrotask(callback) : (socket.on("close", callback), socket.destroy(err));
        },
        /**
         * @returns {boolean}
         */
        get destroyed() {
          return socket.destroyed;
        },
        /**
         * @param {import('../core/request.js')} request
         * @returns {boolean}
         */
        busy(request) {
          return !!(socket[kWriting] || socket[kReset] || socket[kBlocking] || request && (client[kRunning] > 0 && !request.idempotent || client[kRunning] > 0 && (request.upgrade || request.method === "CONNECT") || client[kRunning] > 0 && util.bodyLength(request.body) !== 0 && (util.isStream(request.body) || util.isAsyncIterable(request.body) || util.isFormDataLike(request.body))));
        }
      };
    }
    __name(connectH1, "connectH1");
    function onHttpSocketError(err) {
      assert(err.code !== "ERR_TLS_CERT_ALTNAME_INVALID");
      let parser = this[kParser];
      if (err.code === "ECONNRESET" && parser.statusCode && !parser.shouldKeepAlive) {
        parser.onMessageComplete();
        return;
      }
      this[kError] = err, this[kClient][kOnError](err);
    }
    __name(onHttpSocketError, "onHttpSocketError");
    function onHttpSocketReadable() {
      this[kParser]?.readMore();
    }
    __name(onHttpSocketReadable, "onHttpSocketReadable");
    function onHttpSocketEnd() {
      let parser = this[kParser];
      if (parser.statusCode && !parser.shouldKeepAlive) {
        parser.onMessageComplete();
        return;
      }
      util.destroy(this, new SocketError("other side closed", util.getSocketInfo(this)));
    }
    __name(onHttpSocketEnd, "onHttpSocketEnd");
    function onHttpSocketClose() {
      let parser = this[kParser];
      parser && (!this[kError] && parser.statusCode && !parser.shouldKeepAlive && parser.onMessageComplete(), this[kParser].destroy(), this[kParser] = null);
      let err = this[kError] || new SocketError("closed", util.getSocketInfo(this)), client = this[kClient];
      if (client[kSocket] = null, client[kHTTPContext] = null, client.destroyed) {
        assert(client[kPending] === 0);
        let requests = client[kQueue].splice(client[kRunningIdx]);
        for (let i = 0; i < requests.length; i++) {
          let request = requests[i];
          util.errorRequest(client, request, err);
        }
      } else if (client[kRunning] > 0 && err.code !== "UND_ERR_INFO") {
        let request = client[kQueue][client[kRunningIdx]];
        client[kQueue][client[kRunningIdx]++] = null, util.errorRequest(client, request, err);
      }
      client[kPendingIdx] = client[kRunningIdx], assert(client[kRunning] === 0), client.emit("disconnect", client[kUrl], [client], err), client[kResume]();
    }
    __name(onHttpSocketClose, "onHttpSocketClose");
    function onSocketClose() {
      this[kClosed] = !0;
    }
    __name(onSocketClose, "onSocketClose");
    function resumeH1(client) {
      let socket = client[kSocket];
      if (socket && !socket.destroyed) {
        if (client[kSize] === 0 ? !socket[kNoRef] && socket.unref && (socket.unref(), socket[kNoRef] = !0) : socket[kNoRef] && socket.ref && (socket.ref(), socket[kNoRef] = !1), client[kSize] === 0)
          socket[kParser].timeoutType !== TIMEOUT_KEEP_ALIVE && socket[kParser].setTimeout(client[kKeepAliveTimeoutValue], TIMEOUT_KEEP_ALIVE);
        else if (client[kRunning] > 0 && socket[kParser].statusCode < 200 && socket[kParser].timeoutType !== TIMEOUT_HEADERS) {
          let request = client[kQueue][client[kRunningIdx]], headersTimeout = request.headersTimeout != null ? request.headersTimeout : client[kHeadersTimeout];
          socket[kParser].setTimeout(headersTimeout, TIMEOUT_HEADERS);
        }
      }
    }
    __name(resumeH1, "resumeH1");
    function shouldSendContentLength(method) {
      return method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && method !== "TRACE" && method !== "CONNECT";
    }
    __name(shouldSendContentLength, "shouldSendContentLength");
    function writeH1(client, request) {
      let { method, path, host, upgrade, blocking, reset } = request, { body, headers, contentLength } = request, expectsPayload = method === "PUT" || method === "POST" || method === "PATCH" || method === "QUERY" || method === "PROPFIND" || method === "PROPPATCH";
      if (util.isFormDataLike(body)) {
        extractBody || (extractBody = require_body().extractBody);
        let [bodyStream, contentType] = extractBody(body);
        request.contentType == null && headers.push("content-type", contentType), body = bodyStream.stream, contentLength = bodyStream.length;
      } else util.isBlobLike(body) && request.contentType == null && body.type && headers.push("content-type", body.type);
      body && typeof body.read == "function" && body.read(0);
      let bodyLength = util.bodyLength(body);
      if (contentLength = bodyLength ?? contentLength, contentLength === null && (contentLength = request.contentLength), contentLength === 0 && !expectsPayload && (contentLength = null), shouldSendContentLength(method) && contentLength > 0 && request.contentLength !== null && request.contentLength !== contentLength) {
        if (client[kStrictContentLength])
          return util.errorRequest(client, request, new RequestContentLengthMismatchError()), !1;
        process.emitWarning(new RequestContentLengthMismatchError());
      }
      let socket = client[kSocket], abort = /* @__PURE__ */ __name((err) => {
        request.aborted || request.completed || (util.errorRequest(client, request, err || new RequestAbortedError()), util.destroy(body), util.destroy(socket, new InformationalError("aborted")));
      }, "abort");
      try {
        request.onConnect(abort);
      } catch (err) {
        util.errorRequest(client, request, err);
      }
      if (request.aborted)
        return !1;
      method === "HEAD" && (socket[kReset] = !0), (upgrade || method === "CONNECT") && (socket[kReset] = !0), reset != null && (socket[kReset] = reset), client[kMaxRequests] && socket[kCounter]++ >= client[kMaxRequests] && (socket[kReset] = !0), blocking && (socket[kBlocking] = !0);
      let header = `${method} ${path} HTTP/1.1\r
`;
      if (typeof host == "string" ? header += `host: ${host}\r
` : header += client[kHostHeader], upgrade ? header += `connection: upgrade\r
upgrade: ${upgrade}\r
` : client[kPipelining] && !socket[kReset] ? header += `connection: keep-alive\r
` : header += `connection: close\r
`, Array.isArray(headers))
        for (let n = 0; n < headers.length; n += 2) {
          let key = headers[n + 0], val = headers[n + 1];
          if (Array.isArray(val))
            for (let i = 0; i < val.length; i++)
              header += `${key}: ${val[i]}\r
`;
          else
            header += `${key}: ${val}\r
`;
        }
      return channels.sendHeaders.hasSubscribers && channels.sendHeaders.publish({ request, headers: header, socket }), !body || bodyLength === 0 ? writeBuffer(abort, null, client, request, socket, contentLength, header, expectsPayload) : util.isBuffer(body) ? writeBuffer(abort, body, client, request, socket, contentLength, header, expectsPayload) : util.isBlobLike(body) ? typeof body.stream == "function" ? writeIterable(abort, body.stream(), client, request, socket, contentLength, header, expectsPayload) : writeBlob(abort, body, client, request, socket, contentLength, header, expectsPayload) : util.isStream(body) ? writeStream(abort, body, client, request, socket, contentLength, header, expectsPayload) : util.isIterable(body) ? writeIterable(abort, body, client, request, socket, contentLength, header, expectsPayload) : assert(!1), !0;
    }
    __name(writeH1, "writeH1");
    function writeStream(abort, body, client, request, socket, contentLength, header, expectsPayload) {
      assert(contentLength !== 0 || client[kRunning] === 0, "stream body cannot be pipelined");
      let finished = !1, writer = new AsyncWriter({ abort, socket, request, contentLength, client, expectsPayload, header }), onData = /* @__PURE__ */ __name(function(chunk) {
        if (!finished)
          try {
            !writer.write(chunk) && this.pause && this.pause();
          } catch (err) {
            util.destroy(this, err);
          }
      }, "onData"), onDrain = /* @__PURE__ */ __name(function() {
        finished || body.resume && body.resume();
      }, "onDrain"), onClose = /* @__PURE__ */ __name(function() {
        if (queueMicrotask(() => {
          body.removeListener("error", onFinished);
        }), !finished) {
          let err = new RequestAbortedError();
          queueMicrotask(() => onFinished(err));
        }
      }, "onClose"), onFinished = /* @__PURE__ */ __name(function(err) {
        if (!finished) {
          if (finished = !0, assert(socket.destroyed || socket[kWriting] && client[kRunning] <= 1), socket.off("drain", onDrain).off("error", onFinished), body.removeListener("data", onData).removeListener("end", onFinished).removeListener("close", onClose), !err)
            try {
              writer.end();
            } catch (er) {
              err = er;
            }
          writer.destroy(err), err && (err.code !== "UND_ERR_INFO" || err.message !== "reset") ? util.destroy(body, err) : util.destroy(body);
        }
      }, "onFinished");
      body.on("data", onData).on("end", onFinished).on("error", onFinished).on("close", onClose), body.resume && body.resume(), socket.on("drain", onDrain).on("error", onFinished), body.errorEmitted ?? body.errored ? setImmediate(onFinished, body.errored) : (body.endEmitted ?? body.readableEnded) && setImmediate(onFinished, null), (body.closeEmitted ?? body.closed) && setImmediate(onClose);
    }
    __name(writeStream, "writeStream");
    function writeBuffer(abort, body, client, request, socket, contentLength, header, expectsPayload) {
      try {
        body ? util.isBuffer(body) && (assert(contentLength === body.byteLength, "buffer body must have content length"), socket.cork(), socket.write(`${header}content-length: ${contentLength}\r
\r
`, "latin1"), socket.write(body), socket.uncork(), request.onBodySent(body), !expectsPayload && request.reset !== !1 && (socket[kReset] = !0)) : contentLength === 0 ? socket.write(`${header}content-length: 0\r
\r
`, "latin1") : (assert(contentLength === null, "no body must not have content length"), socket.write(`${header}\r
`, "latin1")), request.onRequestSent(), client[kResume]();
      } catch (err) {
        abort(err);
      }
    }
    __name(writeBuffer, "writeBuffer");
    async function writeBlob(abort, body, client, request, socket, contentLength, header, expectsPayload) {
      assert(contentLength === body.size, "blob body must have content length");
      try {
        if (contentLength != null && contentLength !== body.size)
          throw new RequestContentLengthMismatchError();
        let buffer = Buffer.from(await body.arrayBuffer());
        socket.cork(), socket.write(`${header}content-length: ${contentLength}\r
\r
`, "latin1"), socket.write(buffer), socket.uncork(), request.onBodySent(buffer), request.onRequestSent(), !expectsPayload && request.reset !== !1 && (socket[kReset] = !0), client[kResume]();
      } catch (err) {
        abort(err);
      }
    }
    __name(writeBlob, "writeBlob");
    async function writeIterable(abort, body, client, request, socket, contentLength, header, expectsPayload) {
      assert(contentLength !== 0 || client[kRunning] === 0, "iterator body cannot be pipelined");
      let callback = null;
      function onDrain() {
        if (callback) {
          let cb = callback;
          callback = null, cb();
        }
      }
      __name(onDrain, "onDrain");
      let waitForDrain = /* @__PURE__ */ __name(() => new Promise((resolve, reject) => {
        assert(callback === null), socket[kError] ? reject(socket[kError]) : callback = resolve;
      }), "waitForDrain");
      socket.on("close", onDrain).on("drain", onDrain);
      let writer = new AsyncWriter({ abort, socket, request, contentLength, client, expectsPayload, header });
      try {
        for await (let chunk of body) {
          if (socket[kError])
            throw socket[kError];
          writer.write(chunk) || await waitForDrain();
        }
        writer.end();
      } catch (err) {
        writer.destroy(err);
      } finally {
        socket.off("close", onDrain).off("drain", onDrain);
      }
    }
    __name(writeIterable, "writeIterable");
    var AsyncWriter = class {
      static {
        __name(this, "AsyncWriter");
      }
      /**
       *
       * @param {object} arg
       * @param {AbortCallback} arg.abort
       * @param {import('net').Socket} arg.socket
       * @param {import('../core/request.js')} arg.request
       * @param {number} arg.contentLength
       * @param {import('./client.js')} arg.client
       * @param {boolean} arg.expectsPayload
       * @param {string} arg.header
       */
      constructor({ abort, socket, request, contentLength, client, expectsPayload, header }) {
        this.socket = socket, this.request = request, this.contentLength = contentLength, this.client = client, this.bytesWritten = 0, this.expectsPayload = expectsPayload, this.header = header, this.abort = abort, socket[kWriting] = !0;
      }
      /**
       * @param {Buffer} chunk
       * @returns
       */
      write(chunk) {
        let { socket, request, contentLength, client, bytesWritten, expectsPayload, header } = this;
        if (socket[kError])
          throw socket[kError];
        if (socket.destroyed)
          return !1;
        let len = Buffer.byteLength(chunk);
        if (!len)
          return !0;
        if (contentLength !== null && bytesWritten + len > contentLength) {
          if (client[kStrictContentLength])
            throw new RequestContentLengthMismatchError();
          process.emitWarning(new RequestContentLengthMismatchError());
        }
        socket.cork(), bytesWritten === 0 && (!expectsPayload && request.reset !== !1 && (socket[kReset] = !0), contentLength === null ? socket.write(`${header}transfer-encoding: chunked\r
`, "latin1") : socket.write(`${header}content-length: ${contentLength}\r
\r
`, "latin1")), contentLength === null && socket.write(`\r
${len.toString(16)}\r
`, "latin1"), this.bytesWritten += len;
        let ret = socket.write(chunk);
        return socket.uncork(), request.onBodySent(chunk), ret || socket[kParser].timeout && socket[kParser].timeoutType === TIMEOUT_HEADERS && socket[kParser].timeout.refresh && socket[kParser].timeout.refresh(), ret;
      }
      /**
       * @returns {void}
       */
      end() {
        let { socket, contentLength, client, bytesWritten, expectsPayload, header, request } = this;
        if (request.onRequestSent(), socket[kWriting] = !1, socket[kError])
          throw socket[kError];
        if (!socket.destroyed) {
          if (bytesWritten === 0 ? expectsPayload ? socket.write(`${header}content-length: 0\r
\r
`, "latin1") : socket.write(`${header}\r
`, "latin1") : contentLength === null && socket.write(`\r
0\r
\r
`, "latin1"), contentLength !== null && bytesWritten !== contentLength) {
            if (client[kStrictContentLength])
              throw new RequestContentLengthMismatchError();
            process.emitWarning(new RequestContentLengthMismatchError());
          }
          socket[kParser].timeout && socket[kParser].timeoutType === TIMEOUT_HEADERS && socket[kParser].timeout.refresh && socket[kParser].timeout.refresh(), client[kResume]();
        }
      }
      /**
       * @param {Error} [err]
       * @returns {void}
       */
      destroy(err) {
        let { socket, client, abort } = this;
        socket[kWriting] = !1, err && (assert(client[kRunning] <= 1, "pipeline should only contain this request"), abort(err));
      }
    };
    module2.exports = connectH1;
  }
});

// lib/dispatcher/client-h2.js
var require_client_h2 = __commonJS({
  "lib/dispatcher/client-h2.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { pipeline } = require("node:stream"), util = require_util(), {
      RequestContentLengthMismatchError,
      RequestAbortedError,
      SocketError,
      InformationalError,
      InvalidArgumentError
    } = require_errors(), {
      kUrl,
      kReset,
      kClient,
      kRunning,
      kPending,
      kQueue,
      kPendingIdx,
      kRunningIdx,
      kError,
      kSocket,
      kStrictContentLength,
      kOnError,
      kMaxConcurrentStreams,
      kHTTP2Session,
      kResume,
      kSize,
      kHTTPContext,
      kClosed,
      kBodyTimeout,
      kEnableConnectProtocol,
      kRemoteSettings,
      kHTTP2Stream
    } = require_symbols(), { channels } = require_diagnostics(), kOpenStreams = Symbol("open streams"), extractBody, http2;
    try {
      http2 = require("node:http2");
    } catch {
      http2 = { constants: {} };
    }
    var {
      constants: {
        HTTP2_HEADER_AUTHORITY,
        HTTP2_HEADER_METHOD,
        HTTP2_HEADER_PATH,
        HTTP2_HEADER_SCHEME,
        HTTP2_HEADER_CONTENT_LENGTH,
        HTTP2_HEADER_EXPECT,
        HTTP2_HEADER_STATUS,
        HTTP2_HEADER_PROTOCOL,
        NGHTTP2_REFUSED_STREAM,
        NGHTTP2_CANCEL
      }
    } = http2;
    function parseH2Headers(headers) {
      let result = [];
      for (let [name, value] of Object.entries(headers))
        if (Array.isArray(value))
          for (let subvalue of value)
            result.push(Buffer.from(name), Buffer.from(subvalue));
        else
          result.push(Buffer.from(name), Buffer.from(value));
      return result;
    }
    __name(parseH2Headers, "parseH2Headers");
    function connectH2(client, socket) {
      client[kSocket] = socket;
      let session = http2.connect(client[kUrl], {
        createConnection: /* @__PURE__ */ __name(() => socket, "createConnection"),
        peerMaxConcurrentStreams: client[kMaxConcurrentStreams],
        settings: {
          // TODO(metcoder95): add support for PUSH
          enablePush: !1
        }
      });
      return session[kOpenStreams] = 0, session[kClient] = client, session[kSocket] = socket, session[kHTTP2Session] = null, session[kEnableConnectProtocol] = !1, session[kRemoteSettings] = !1, util.addListener(session, "error", onHttp2SessionError), util.addListener(session, "frameError", onHttp2FrameError), util.addListener(session, "end", onHttp2SessionEnd), util.addListener(session, "goaway", onHttp2SessionGoAway), util.addListener(session, "close", onHttp2SessionClose), util.addListener(session, "remoteSettings", onHttp2RemoteSettings), session.unref(), client[kHTTP2Session] = session, socket[kHTTP2Session] = session, util.addListener(socket, "error", onHttp2SocketError), util.addListener(socket, "end", onHttp2SocketEnd), util.addListener(socket, "close", onHttp2SocketClose), socket[kClosed] = !1, socket.on("close", onSocketClose), {
        version: "h2",
        defaultPipelining: 1 / 0,
        /**
         * @param {import('../core/request.js')} request
         * @returns {boolean}
        */
        write(request) {
          return writeH2(client, request);
        },
        /**
         * @returns {void}
         */
        resume() {
          resumeH2(client);
        },
        /**
         * @param {Error | null} err
         * @param {() => void} callback
         */
        destroy(err, callback) {
          socket[kClosed] ? queueMicrotask(callback) : socket.destroy(err).on("close", callback);
        },
        /**
         * @type {boolean}
         */
        get destroyed() {
          return socket.destroyed;
        },
        /**
         * @param {import('../core/request.js')} request
         * @returns {boolean}
        */
        busy(request) {
          if (request != null)
            if (client[kRunning] > 0) {
              if (request.idempotent === !1 || (request.upgrade === "websocket" || request.method === "CONNECT") && session[kRemoteSettings] === !1 || util.bodyLength(request.body) !== 0 && (util.isStream(request.body) || util.isAsyncIterable(request.body) || util.isFormDataLike(request.body))) return !0;
            } else
              return (request.upgrade === "websocket" || request.method === "CONNECT") && session[kRemoteSettings] === !1;
          return !1;
        }
      };
    }
    __name(connectH2, "connectH2");
    function resumeH2(client) {
      let socket = client[kSocket];
      socket?.destroyed === !1 && (client[kSize] === 0 || client[kMaxConcurrentStreams] === 0 ? (socket.unref(), client[kHTTP2Session].unref()) : (socket.ref(), client[kHTTP2Session].ref()));
    }
    __name(resumeH2, "resumeH2");
    function onHttp2RemoteSettings(settings) {
      if (this[kClient][kMaxConcurrentStreams] = settings.maxConcurrentStreams ?? this[kClient][kMaxConcurrentStreams], this[kRemoteSettings] === !0 && this[kEnableConnectProtocol] === !0 && settings.enableConnectProtocol === !1) {
        let err = new InformationalError("HTTP/2: Server disabled extended CONNECT protocol against RFC-8441");
        this[kSocket][kError] = err, this[kClient][kOnError](err);
        return;
      }
      this[kEnableConnectProtocol] = settings.enableConnectProtocol ?? this[kEnableConnectProtocol], this[kRemoteSettings] = !0, this[kClient][kResume]();
    }
    __name(onHttp2RemoteSettings, "onHttp2RemoteSettings");
    function onHttp2SessionError(err) {
      assert(err.code !== "ERR_TLS_CERT_ALTNAME_INVALID"), this[kSocket][kError] = err, this[kClient][kOnError](err);
    }
    __name(onHttp2SessionError, "onHttp2SessionError");
    function onHttp2FrameError(type, code, id) {
      if (id === 0) {
        let err = new InformationalError(`HTTP/2: "frameError" received - type ${type}, code ${code}`);
        this[kSocket][kError] = err, this[kClient][kOnError](err);
      }
    }
    __name(onHttp2FrameError, "onHttp2FrameError");
    function onHttp2SessionEnd() {
      let err = new SocketError("other side closed", util.getSocketInfo(this[kSocket]));
      this.destroy(err), util.destroy(this[kSocket], err);
    }
    __name(onHttp2SessionEnd, "onHttp2SessionEnd");
    function onHttp2SessionGoAway(errorCode) {
      let err = this[kError] || new SocketError(`HTTP/2: "GOAWAY" frame received with code ${errorCode}`, util.getSocketInfo(this[kSocket])), client = this[kClient];
      if (client[kSocket] = null, client[kHTTPContext] = null, this.close(), this[kHTTP2Session] = null, util.destroy(this[kSocket], err), client[kRunningIdx] < client[kQueue].length) {
        let request = client[kQueue][client[kRunningIdx]];
        client[kQueue][client[kRunningIdx]++] = null, util.errorRequest(client, request, err), client[kPendingIdx] = client[kRunningIdx];
      }
      assert(client[kRunning] === 0), client.emit("disconnect", client[kUrl], [client], err), client.emit("connectionError", client[kUrl], [client], err), client[kResume]();
    }
    __name(onHttp2SessionGoAway, "onHttp2SessionGoAway");
    function onHttp2SessionClose() {
      let { [kClient]: client } = this, { [kSocket]: socket } = client, err = this[kSocket][kError] || this[kError] || new SocketError("closed", util.getSocketInfo(socket));
      if (client[kSocket] = null, client[kHTTPContext] = null, client.destroyed) {
        assert(client[kPending] === 0);
        let requests = client[kQueue].splice(client[kRunningIdx]);
        for (let i = 0; i < requests.length; i++) {
          let request = requests[i];
          util.errorRequest(client, request, err);
        }
      }
    }
    __name(onHttp2SessionClose, "onHttp2SessionClose");
    function onHttp2SocketClose() {
      let err = this[kError] || new SocketError("closed", util.getSocketInfo(this)), client = this[kHTTP2Session][kClient];
      client[kSocket] = null, client[kHTTPContext] = null, this[kHTTP2Session] !== null && this[kHTTP2Session].destroy(err), client[kPendingIdx] = client[kRunningIdx], assert(client[kRunning] === 0), client.emit("disconnect", client[kUrl], [client], err), client[kResume]();
    }
    __name(onHttp2SocketClose, "onHttp2SocketClose");
    function onHttp2SocketError(err) {
      assert(err.code !== "ERR_TLS_CERT_ALTNAME_INVALID"), this[kError] = err, this[kClient][kOnError](err);
    }
    __name(onHttp2SocketError, "onHttp2SocketError");
    function onHttp2SocketEnd() {
      util.destroy(this, new SocketError("other side closed", util.getSocketInfo(this)));
    }
    __name(onHttp2SocketEnd, "onHttp2SocketEnd");
    function onSocketClose() {
      this[kClosed] = !0;
    }
    __name(onSocketClose, "onSocketClose");
    function shouldSendContentLength(method) {
      return method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && method !== "TRACE" && method !== "CONNECT";
    }
    __name(shouldSendContentLength, "shouldSendContentLength");
    function writeH2(client, request) {
      let requestTimeout = request.bodyTimeout ?? client[kBodyTimeout], session = client[kHTTP2Session], { method, path, host, upgrade, expectContinue, signal, protocol, headers: reqHeaders } = request, { body } = request;
      if (upgrade != null && upgrade !== "websocket")
        return util.errorRequest(client, request, new InvalidArgumentError(`Custom upgrade "${upgrade}" not supported over HTTP/2`)), !1;
      let headers = {};
      for (let n = 0; n < reqHeaders.length; n += 2) {
        let key = reqHeaders[n + 0], val = reqHeaders[n + 1];
        if (key === "cookie") {
          headers[key] != null ? headers[key] = Array.isArray(headers[key]) ? (headers[key].push(val), headers[key]) : [headers[key], val] : headers[key] = val;
          continue;
        }
        if (Array.isArray(val))
          for (let i = 0; i < val.length; i++)
            headers[key] ? headers[key] += `, ${val[i]}` : headers[key] = val[i];
        else headers[key] ? headers[key] += `, ${val}` : headers[key] = val;
      }
      let stream = null, { hostname, port } = client[kUrl];
      headers[HTTP2_HEADER_AUTHORITY] = host || `${hostname}${port ? `:${port}` : ""}`, headers[HTTP2_HEADER_METHOD] = method;
      let abort = /* @__PURE__ */ __name((err) => {
        request.aborted || request.completed || (err = err || new RequestAbortedError(), util.errorRequest(client, request, err), stream != null && (stream.removeAllListeners("data"), stream.close(), client[kOnError](err), client[kResume]()), util.destroy(body, err));
      }, "abort");
      try {
        request.onConnect(abort);
      } catch (err) {
        util.errorRequest(client, request, err);
      }
      if (request.aborted)
        return !1;
      if (upgrade || method === "CONNECT")
        return session.ref(), upgrade === "websocket" ? session[kEnableConnectProtocol] === !1 ? (util.errorRequest(client, request, new InformationalError("HTTP/2: Extended CONNECT protocol not supported by server")), session.unref(), !1) : (headers[HTTP2_HEADER_METHOD] = "CONNECT", headers[HTTP2_HEADER_PROTOCOL] = "websocket", headers[HTTP2_HEADER_PATH] = path, protocol === "ws:" || protocol === "wss:" ? headers[HTTP2_HEADER_SCHEME] = protocol === "ws:" ? "http" : "https" : headers[HTTP2_HEADER_SCHEME] = protocol === "http:" ? "http" : "https", stream = session.request(headers, { endStream: !1, signal }), stream[kHTTP2Stream] = !0, stream.once("response", (headers2, _flags) => {
          let { [HTTP2_HEADER_STATUS]: statusCode, ...realHeaders } = headers2;
          request.onUpgrade(statusCode, parseH2Headers(realHeaders), stream), ++session[kOpenStreams], client[kQueue][client[kRunningIdx]++] = null;
        }), stream.on("error", () => {
          (stream.rstCode === NGHTTP2_REFUSED_STREAM || stream.rstCode === NGHTTP2_CANCEL) && abort(new InformationalError(`HTTP/2: "stream error" received - code ${stream.rstCode}`));
        }), stream.once("close", () => {
          session[kOpenStreams] -= 1, session[kOpenStreams] === 0 && session.unref();
        }), stream.setTimeout(requestTimeout), !0) : (stream = session.request(headers, { endStream: !1, signal }), stream[kHTTP2Stream] = !0, stream.on("response", (headers2) => {
          let { [HTTP2_HEADER_STATUS]: statusCode, ...realHeaders } = headers2;
          request.onUpgrade(statusCode, parseH2Headers(realHeaders), stream), ++session[kOpenStreams], client[kQueue][client[kRunningIdx]++] = null;
        }), stream.once("close", () => {
          session[kOpenStreams] -= 1, session[kOpenStreams] === 0 && session.unref();
        }), stream.setTimeout(requestTimeout), !0);
      headers[HTTP2_HEADER_PATH] = path, headers[HTTP2_HEADER_SCHEME] = protocol === "http:" ? "http" : "https";
      let expectsPayload = method === "PUT" || method === "POST" || method === "PATCH";
      body && typeof body.read == "function" && body.read(0);
      let contentLength = util.bodyLength(body);
      if (util.isFormDataLike(body)) {
        extractBody ??= require_body().extractBody;
        let [bodyStream, contentType] = extractBody(body);
        headers["content-type"] = contentType, body = bodyStream.stream, contentLength = bodyStream.length;
      }
      if (contentLength == null && (contentLength = request.contentLength), expectsPayload || (contentLength = null), shouldSendContentLength(method) && contentLength > 0 && request.contentLength != null && request.contentLength !== contentLength) {
        if (client[kStrictContentLength])
          return util.errorRequest(client, request, new RequestContentLengthMismatchError()), !1;
        process.emitWarning(new RequestContentLengthMismatchError());
      }
      if (contentLength != null && (assert(body || contentLength === 0, "no body must not have content length"), headers[HTTP2_HEADER_CONTENT_LENGTH] = `${contentLength}`), session.ref(), channels.sendHeaders.hasSubscribers) {
        let header = "";
        for (let key in headers)
          header += `${key}: ${headers[key]}\r
`;
        channels.sendHeaders.publish({ request, headers: header, socket: session[kSocket] });
      }
      let shouldEndStream = method === "GET" || method === "HEAD" || body === null;
      return expectContinue ? (headers[HTTP2_HEADER_EXPECT] = "100-continue", stream = session.request(headers, { endStream: shouldEndStream, signal }), stream[kHTTP2Stream] = !0, stream.once("continue", writeBodyH2)) : (stream = session.request(headers, {
        endStream: shouldEndStream,
        signal
      }), stream[kHTTP2Stream] = !0, writeBodyH2()), ++session[kOpenStreams], stream.setTimeout(requestTimeout), stream.once("response", (headers2) => {
        let { [HTTP2_HEADER_STATUS]: statusCode, ...realHeaders } = headers2;
        if (request.onResponseStarted(), request.aborted) {
          stream.removeAllListeners("data");
          return;
        }
        request.onHeaders(Number(statusCode), parseH2Headers(realHeaders), stream.resume.bind(stream), "") === !1 && stream.pause();
      }), stream.on("data", (chunk) => {
        request.onData(chunk) === !1 && stream.pause();
      }), stream.once("end", (err) => {
        stream.removeAllListeners("data"), stream.state?.state == null || stream.state.state < 6 ? (!request.aborted && !request.completed && request.onComplete({}), client[kQueue][client[kRunningIdx]++] = null, client[kResume]()) : (--session[kOpenStreams], session[kOpenStreams] === 0 && session.unref(), abort(err ?? new InformationalError("HTTP/2: stream half-closed (remote)")), client[kQueue][client[kRunningIdx]++] = null, client[kPendingIdx] = client[kRunningIdx], client[kResume]());
      }), stream.once("close", () => {
        stream.removeAllListeners("data"), session[kOpenStreams] -= 1, session[kOpenStreams] === 0 && session.unref();
      }), stream.once("error", function(err) {
        stream.removeAllListeners("data"), abort(err);
      }), stream.once("frameError", (type, code) => {
        stream.removeAllListeners("data"), abort(new InformationalError(`HTTP/2: "frameError" received - type ${type}, code ${code}`));
      }), stream.on("aborted", () => {
        stream.removeAllListeners("data");
      }), stream.on("timeout", () => {
        let err = new InformationalError(`HTTP/2: "stream timeout after ${requestTimeout}"`);
        stream.removeAllListeners("data"), session[kOpenStreams] -= 1, session[kOpenStreams] === 0 && session.unref(), abort(err);
      }), stream.once("trailers", (trailers) => {
        request.aborted || request.completed || request.onComplete(trailers);
      }), !0;
      function writeBodyH2() {
        !body || contentLength === 0 ? writeBuffer(
          abort,
          stream,
          null,
          client,
          request,
          client[kSocket],
          contentLength,
          expectsPayload
        ) : util.isBuffer(body) ? writeBuffer(
          abort,
          stream,
          body,
          client,
          request,
          client[kSocket],
          contentLength,
          expectsPayload
        ) : util.isBlobLike(body) ? typeof body.stream == "function" ? writeIterable(
          abort,
          stream,
          body.stream(),
          client,
          request,
          client[kSocket],
          contentLength,
          expectsPayload
        ) : writeBlob(
          abort,
          stream,
          body,
          client,
          request,
          client[kSocket],
          contentLength,
          expectsPayload
        ) : util.isStream(body) ? writeStream(
          abort,
          client[kSocket],
          expectsPayload,
          stream,
          body,
          client,
          request,
          contentLength
        ) : util.isIterable(body) ? writeIterable(
          abort,
          stream,
          body,
          client,
          request,
          client[kSocket],
          contentLength,
          expectsPayload
        ) : assert(!1);
      }
      __name(writeBodyH2, "writeBodyH2");
    }
    __name(writeH2, "writeH2");
    function writeBuffer(abort, h2stream, body, client, request, socket, contentLength, expectsPayload) {
      try {
        body != null && util.isBuffer(body) && (assert(contentLength === body.byteLength, "buffer body must have content length"), h2stream.cork(), h2stream.write(body), h2stream.uncork(), h2stream.end(), request.onBodySent(body)), expectsPayload || (socket[kReset] = !0), request.onRequestSent(), client[kResume]();
      } catch (error) {
        abort(error);
      }
    }
    __name(writeBuffer, "writeBuffer");
    function writeStream(abort, socket, expectsPayload, h2stream, body, client, request, contentLength) {
      assert(contentLength !== 0 || client[kRunning] === 0, "stream body cannot be pipelined");
      let pipe = pipeline(
        body,
        h2stream,
        (err) => {
          err ? (util.destroy(pipe, err), abort(err)) : (util.removeAllListeners(pipe), request.onRequestSent(), expectsPayload || (socket[kReset] = !0), client[kResume]());
        }
      );
      util.addListener(pipe, "data", onPipeData);
      function onPipeData(chunk) {
        request.onBodySent(chunk);
      }
      __name(onPipeData, "onPipeData");
    }
    __name(writeStream, "writeStream");
    async function writeBlob(abort, h2stream, body, client, request, socket, contentLength, expectsPayload) {
      assert(contentLength === body.size, "blob body must have content length");
      try {
        if (contentLength != null && contentLength !== body.size)
          throw new RequestContentLengthMismatchError();
        let buffer = Buffer.from(await body.arrayBuffer());
        h2stream.cork(), h2stream.write(buffer), h2stream.uncork(), h2stream.end(), request.onBodySent(buffer), request.onRequestSent(), expectsPayload || (socket[kReset] = !0), client[kResume]();
      } catch (err) {
        abort(err);
      }
    }
    __name(writeBlob, "writeBlob");
    async function writeIterable(abort, h2stream, body, client, request, socket, contentLength, expectsPayload) {
      assert(contentLength !== 0 || client[kRunning] === 0, "iterator body cannot be pipelined");
      let callback = null;
      function onDrain() {
        if (callback) {
          let cb = callback;
          callback = null, cb();
        }
      }
      __name(onDrain, "onDrain");
      let waitForDrain = /* @__PURE__ */ __name(() => new Promise((resolve, reject) => {
        assert(callback === null), socket[kError] ? reject(socket[kError]) : callback = resolve;
      }), "waitForDrain");
      h2stream.on("close", onDrain).on("drain", onDrain);
      try {
        for await (let chunk of body) {
          if (socket[kError])
            throw socket[kError];
          let res = h2stream.write(chunk);
          request.onBodySent(chunk), res || await waitForDrain();
        }
        h2stream.end(), request.onRequestSent(), expectsPayload || (socket[kReset] = !0), client[kResume]();
      } catch (err) {
        abort(err);
      } finally {
        h2stream.off("close", onDrain).off("drain", onDrain);
      }
    }
    __name(writeIterable, "writeIterable");
    module2.exports = connectH2;
  }
});

// lib/dispatcher/client.js
var require_client = __commonJS({
  "lib/dispatcher/client.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), net = require("node:net"), http = require("node:http"), util = require_util(), { ClientStats } = require_stats(), { channels } = require_diagnostics(), Request = require_request(), DispatcherBase = require_dispatcher_base(), {
      InvalidArgumentError,
      InformationalError,
      ClientDestroyedError
    } = require_errors(), buildConnector = require_connect(), {
      kUrl,
      kServerName,
      kClient,
      kBusy,
      kConnect,
      kResuming,
      kRunning,
      kPending,
      kSize,
      kQueue,
      kConnected,
      kConnecting,
      kNeedDrain,
      kKeepAliveDefaultTimeout,
      kHostHeader,
      kPendingIdx,
      kRunningIdx,
      kError,
      kPipelining,
      kKeepAliveTimeoutValue,
      kMaxHeadersSize,
      kKeepAliveMaxTimeout,
      kKeepAliveTimeoutThreshold,
      kHeadersTimeout,
      kBodyTimeout,
      kStrictContentLength,
      kConnector,
      kMaxRequests,
      kCounter,
      kClose,
      kDestroy,
      kDispatch,
      kLocalAddress,
      kMaxResponseSize,
      kOnError,
      kHTTPContext,
      kMaxConcurrentStreams,
      kResume
    } = require_symbols(), connectH1 = require_client_h1(), connectH2 = require_client_h2(), kClosedResolve = Symbol("kClosedResolve"), getDefaultNodeMaxHeaderSize = http && http.maxHeaderSize && Number.isInteger(http.maxHeaderSize) && http.maxHeaderSize > 0 ? () => http.maxHeaderSize : () => {
      throw new InvalidArgumentError("http module not available or http.maxHeaderSize invalid");
    }, noop = /* @__PURE__ */ __name(() => {
    }, "noop");
    function getPipelining(client) {
      return client[kPipelining] ?? client[kHTTPContext]?.defaultPipelining ?? 1;
    }
    __name(getPipelining, "getPipelining");
    var Client = class extends DispatcherBase {
      static {
        __name(this, "Client");
      }
      /**
       *
       * @param {string|URL} url
       * @param {import('../../types/client.js').Client.Options} options
       */
      constructor(url, {
        maxHeaderSize,
        headersTimeout,
        socketTimeout,
        requestTimeout,
        connectTimeout,
        bodyTimeout,
        idleTimeout,
        keepAlive,
        keepAliveTimeout,
        maxKeepAliveTimeout,
        keepAliveMaxTimeout,
        keepAliveTimeoutThreshold,
        socketPath,
        pipelining,
        tls,
        strictContentLength,
        maxCachedSessions,
        connect: connect2,
        maxRequestsPerClient,
        localAddress,
        maxResponseSize,
        autoSelectFamily,
        autoSelectFamilyAttemptTimeout,
        // h2
        maxConcurrentStreams,
        allowH2,
        useH2c
      } = {}) {
        if (keepAlive !== void 0)
          throw new InvalidArgumentError("unsupported keepAlive, use pipelining=0 instead");
        if (socketTimeout !== void 0)
          throw new InvalidArgumentError("unsupported socketTimeout, use headersTimeout & bodyTimeout instead");
        if (requestTimeout !== void 0)
          throw new InvalidArgumentError("unsupported requestTimeout, use headersTimeout & bodyTimeout instead");
        if (idleTimeout !== void 0)
          throw new InvalidArgumentError("unsupported idleTimeout, use keepAliveTimeout instead");
        if (maxKeepAliveTimeout !== void 0)
          throw new InvalidArgumentError("unsupported maxKeepAliveTimeout, use keepAliveMaxTimeout instead");
        if (maxHeaderSize != null) {
          if (!Number.isInteger(maxHeaderSize) || maxHeaderSize < 1)
            throw new InvalidArgumentError("invalid maxHeaderSize");
        } else
          maxHeaderSize = getDefaultNodeMaxHeaderSize();
        if (socketPath != null && typeof socketPath != "string")
          throw new InvalidArgumentError("invalid socketPath");
        if (connectTimeout != null && (!Number.isFinite(connectTimeout) || connectTimeout < 0))
          throw new InvalidArgumentError("invalid connectTimeout");
        if (keepAliveTimeout != null && (!Number.isFinite(keepAliveTimeout) || keepAliveTimeout <= 0))
          throw new InvalidArgumentError("invalid keepAliveTimeout");
        if (keepAliveMaxTimeout != null && (!Number.isFinite(keepAliveMaxTimeout) || keepAliveMaxTimeout <= 0))
          throw new InvalidArgumentError("invalid keepAliveMaxTimeout");
        if (keepAliveTimeoutThreshold != null && !Number.isFinite(keepAliveTimeoutThreshold))
          throw new InvalidArgumentError("invalid keepAliveTimeoutThreshold");
        if (headersTimeout != null && (!Number.isInteger(headersTimeout) || headersTimeout < 0))
          throw new InvalidArgumentError("headersTimeout must be a positive integer or zero");
        if (bodyTimeout != null && (!Number.isInteger(bodyTimeout) || bodyTimeout < 0))
          throw new InvalidArgumentError("bodyTimeout must be a positive integer or zero");
        if (connect2 != null && typeof connect2 != "function" && typeof connect2 != "object")
          throw new InvalidArgumentError("connect must be a function or an object");
        if (maxRequestsPerClient != null && (!Number.isInteger(maxRequestsPerClient) || maxRequestsPerClient < 0))
          throw new InvalidArgumentError("maxRequestsPerClient must be a positive number");
        if (localAddress != null && (typeof localAddress != "string" || net.isIP(localAddress) === 0))
          throw new InvalidArgumentError("localAddress must be valid string IP address");
        if (maxResponseSize != null && (!Number.isInteger(maxResponseSize) || maxResponseSize < -1))
          throw new InvalidArgumentError("maxResponseSize must be a positive number");
        if (autoSelectFamilyAttemptTimeout != null && (!Number.isInteger(autoSelectFamilyAttemptTimeout) || autoSelectFamilyAttemptTimeout < -1))
          throw new InvalidArgumentError("autoSelectFamilyAttemptTimeout must be a positive number");
        if (allowH2 != null && typeof allowH2 != "boolean")
          throw new InvalidArgumentError("allowH2 must be a valid boolean value");
        if (maxConcurrentStreams != null && (typeof maxConcurrentStreams != "number" || maxConcurrentStreams < 1))
          throw new InvalidArgumentError("maxConcurrentStreams must be a positive integer, greater than 0");
        if (useH2c != null && typeof useH2c != "boolean")
          throw new InvalidArgumentError("useH2c must be a valid boolean value");
        super(), typeof connect2 != "function" && (connect2 = buildConnector({
          ...tls,
          maxCachedSessions,
          allowH2,
          useH2c,
          socketPath,
          timeout: connectTimeout,
          ...typeof autoSelectFamily == "boolean" ? { autoSelectFamily, autoSelectFamilyAttemptTimeout } : void 0,
          ...connect2
        })), this[kUrl] = util.parseOrigin(url), this[kConnector] = connect2, this[kPipelining] = pipelining ?? 1, this[kMaxHeadersSize] = maxHeaderSize, this[kKeepAliveDefaultTimeout] = keepAliveTimeout ?? 4e3, this[kKeepAliveMaxTimeout] = keepAliveMaxTimeout ?? 6e5, this[kKeepAliveTimeoutThreshold] = keepAliveTimeoutThreshold ?? 2e3, this[kKeepAliveTimeoutValue] = this[kKeepAliveDefaultTimeout], this[kServerName] = null, this[kLocalAddress] = localAddress ?? null, this[kResuming] = 0, this[kNeedDrain] = 0, this[kHostHeader] = `host: ${this[kUrl].hostname}${this[kUrl].port ? `:${this[kUrl].port}` : ""}\r
`, this[kBodyTimeout] = bodyTimeout ?? 3e5, this[kHeadersTimeout] = headersTimeout ?? 3e5, this[kStrictContentLength] = strictContentLength ?? !0, this[kMaxRequests] = maxRequestsPerClient, this[kClosedResolve] = null, this[kMaxResponseSize] = maxResponseSize > -1 ? maxResponseSize : -1, this[kMaxConcurrentStreams] = maxConcurrentStreams ?? 100, this[kHTTPContext] = null, this[kQueue] = [], this[kRunningIdx] = 0, this[kPendingIdx] = 0, this[kResume] = (sync) => resume(this, sync), this[kOnError] = (err) => onError(this, err);
      }
      get pipelining() {
        return this[kPipelining];
      }
      set pipelining(value) {
        this[kPipelining] = value, this[kResume](!0);
      }
      get stats() {
        return new ClientStats(this);
      }
      get [kPending]() {
        return this[kQueue].length - this[kPendingIdx];
      }
      get [kRunning]() {
        return this[kPendingIdx] - this[kRunningIdx];
      }
      get [kSize]() {
        return this[kQueue].length - this[kRunningIdx];
      }
      get [kConnected]() {
        return !!this[kHTTPContext] && !this[kConnecting] && !this[kHTTPContext].destroyed;
      }
      get [kBusy]() {
        return !!(this[kHTTPContext]?.busy(null) || this[kSize] >= (getPipelining(this) || 1) || this[kPending] > 0);
      }
      [kConnect](cb) {
        connect(this), this.once("connect", cb);
      }
      [kDispatch](opts, handler) {
        let request = new Request(this[kUrl].origin, opts, handler);
        return this[kQueue].push(request), this[kResuming] || (util.bodyLength(request.body) == null && util.isIterable(request.body) ? (this[kResuming] = 1, queueMicrotask(() => resume(this))) : this[kResume](!0)), this[kResuming] && this[kNeedDrain] !== 2 && this[kBusy] && (this[kNeedDrain] = 2), this[kNeedDrain] < 2;
      }
      [kClose]() {
        return new Promise((resolve) => {
          this[kSize] ? this[kClosedResolve] = resolve : resolve(null);
        });
      }
      [kDestroy](err) {
        return new Promise((resolve) => {
          let requests = this[kQueue].splice(this[kPendingIdx]);
          for (let i = 0; i < requests.length; i++) {
            let request = requests[i];
            util.errorRequest(this, request, err);
          }
          let callback = /* @__PURE__ */ __name(() => {
            this[kClosedResolve] && (this[kClosedResolve](), this[kClosedResolve] = null), resolve(null);
          }, "callback");
          this[kHTTPContext] ? (this[kHTTPContext].destroy(err, callback), this[kHTTPContext] = null) : queueMicrotask(callback), this[kResume]();
        });
      }
    };
    function onError(client, err) {
      if (client[kRunning] === 0 && err.code !== "UND_ERR_INFO" && err.code !== "UND_ERR_SOCKET") {
        assert(client[kPendingIdx] === client[kRunningIdx]);
        let requests = client[kQueue].splice(client[kRunningIdx]);
        for (let i = 0; i < requests.length; i++) {
          let request = requests[i];
          util.errorRequest(client, request, err);
        }
        assert(client[kSize] === 0);
      }
    }
    __name(onError, "onError");
    function connect(client) {
      assert(!client[kConnecting]), assert(!client[kHTTPContext]);
      let { host, hostname, protocol, port } = client[kUrl];
      if (hostname[0] === "[") {
        let idx = hostname.indexOf("]");
        assert(idx !== -1);
        let ip = hostname.substring(1, idx);
        assert(net.isIPv6(ip)), hostname = ip;
      }
      client[kConnecting] = !0, channels.beforeConnect.hasSubscribers && channels.beforeConnect.publish({
        connectParams: {
          host,
          hostname,
          protocol,
          port,
          version: client[kHTTPContext]?.version,
          servername: client[kServerName],
          localAddress: client[kLocalAddress]
        },
        connector: client[kConnector]
      }), client[kConnector]({
        host,
        hostname,
        protocol,
        port,
        servername: client[kServerName],
        localAddress: client[kLocalAddress]
      }, (err, socket) => {
        if (err) {
          handleConnectError(client, err, { host, hostname, protocol, port }), client[kResume]();
          return;
        }
        if (client.destroyed) {
          util.destroy(socket.on("error", noop), new ClientDestroyedError()), client[kResume]();
          return;
        }
        assert(socket);
        try {
          client[kHTTPContext] = socket.alpnProtocol === "h2" ? connectH2(client, socket) : connectH1(client, socket);
        } catch (err2) {
          socket.destroy().on("error", noop), handleConnectError(client, err2, { host, hostname, protocol, port }), client[kResume]();
          return;
        }
        client[kConnecting] = !1, socket[kCounter] = 0, socket[kMaxRequests] = client[kMaxRequests], socket[kClient] = client, socket[kError] = null, channels.connected.hasSubscribers && channels.connected.publish({
          connectParams: {
            host,
            hostname,
            protocol,
            port,
            version: client[kHTTPContext]?.version,
            servername: client[kServerName],
            localAddress: client[kLocalAddress]
          },
          connector: client[kConnector],
          socket
        }), client.emit("connect", client[kUrl], [client]), client[kResume]();
      });
    }
    __name(connect, "connect");
    function handleConnectError(client, err, { host, hostname, protocol, port }) {
      if (!client.destroyed) {
        if (client[kConnecting] = !1, channels.connectError.hasSubscribers && channels.connectError.publish({
          connectParams: {
            host,
            hostname,
            protocol,
            port,
            version: client[kHTTPContext]?.version,
            servername: client[kServerName],
            localAddress: client[kLocalAddress]
          },
          connector: client[kConnector],
          error: err
        }), err.code === "ERR_TLS_CERT_ALTNAME_INVALID")
          for (assert(client[kRunning] === 0); client[kPending] > 0 && client[kQueue][client[kPendingIdx]].servername === client[kServerName]; ) {
            let request = client[kQueue][client[kPendingIdx]++];
            util.errorRequest(client, request, err);
          }
        else
          onError(client, err);
        client.emit("connectionError", client[kUrl], [client], err);
      }
    }
    __name(handleConnectError, "handleConnectError");
    function emitDrain(client) {
      client[kNeedDrain] = 0, client.emit("drain", client[kUrl], [client]);
    }
    __name(emitDrain, "emitDrain");
    function resume(client, sync) {
      client[kResuming] !== 2 && (client[kResuming] = 2, _resume(client, sync), client[kResuming] = 0, client[kRunningIdx] > 256 && (client[kQueue].splice(0, client[kRunningIdx]), client[kPendingIdx] -= client[kRunningIdx], client[kRunningIdx] = 0));
    }
    __name(resume, "resume");
    function _resume(client, sync) {
      for (; ; ) {
        if (client.destroyed) {
          assert(client[kPending] === 0);
          return;
        }
        if (client[kClosedResolve] && !client[kSize]) {
          client[kClosedResolve](), client[kClosedResolve] = null;
          return;
        }
        if (client[kHTTPContext] && client[kHTTPContext].resume(), client[kBusy])
          client[kNeedDrain] = 2;
        else if (client[kNeedDrain] === 2) {
          sync ? (client[kNeedDrain] = 1, queueMicrotask(() => emitDrain(client))) : emitDrain(client);
          continue;
        }
        if (client[kPending] === 0 || client[kRunning] >= (getPipelining(client) || 1))
          return;
        let request = client[kQueue][client[kPendingIdx]];
        if (client[kUrl].protocol === "https:" && client[kServerName] !== request.servername) {
          if (client[kRunning] > 0)
            return;
          client[kServerName] = request.servername, client[kHTTPContext]?.destroy(new InformationalError("servername changed"), () => {
            client[kHTTPContext] = null, resume(client);
          });
        }
        if (client[kConnecting])
          return;
        if (!client[kHTTPContext]) {
          connect(client);
          return;
        }
        if (client[kHTTPContext].destroyed || client[kHTTPContext].busy(request))
          return;
        !request.aborted && client[kHTTPContext].write(request) ? client[kPendingIdx]++ : client[kQueue].splice(client[kPendingIdx], 1);
      }
    }
    __name(_resume, "_resume");
    module2.exports = Client;
  }
});

// lib/dispatcher/pool.js
var require_pool = __commonJS({
  "lib/dispatcher/pool.js"(exports2, module2) {
    "use strict";
    var {
      PoolBase,
      kClients,
      kNeedDrain,
      kAddClient,
      kGetDispatcher,
      kRemoveClient
    } = require_pool_base(), Client = require_client(), {
      InvalidArgumentError
    } = require_errors(), util = require_util(), { kUrl } = require_symbols(), buildConnector = require_connect(), kOptions = Symbol("options"), kConnections = Symbol("connections"), kFactory = Symbol("factory");
    function defaultFactory(origin, opts) {
      return new Client(origin, opts);
    }
    __name(defaultFactory, "defaultFactory");
    var Pool = class extends PoolBase {
      static {
        __name(this, "Pool");
      }
      constructor(origin, {
        connections,
        factory = defaultFactory,
        connect,
        connectTimeout,
        tls,
        maxCachedSessions,
        socketPath,
        autoSelectFamily,
        autoSelectFamilyAttemptTimeout,
        allowH2,
        clientTtl,
        ...options
      } = {}) {
        if (connections != null && (!Number.isFinite(connections) || connections < 0))
          throw new InvalidArgumentError("invalid connections");
        if (typeof factory != "function")
          throw new InvalidArgumentError("factory must be a function.");
        if (connect != null && typeof connect != "function" && typeof connect != "object")
          throw new InvalidArgumentError("connect must be a function or an object");
        typeof connect != "function" && (connect = buildConnector({
          ...tls,
          maxCachedSessions,
          allowH2,
          socketPath,
          timeout: connectTimeout,
          ...typeof autoSelectFamily == "boolean" ? { autoSelectFamily, autoSelectFamilyAttemptTimeout } : void 0,
          ...connect
        })), super(), this[kConnections] = connections || null, this[kUrl] = util.parseOrigin(origin), this[kOptions] = { ...util.deepClone(options), connect, allowH2, clientTtl }, this[kOptions].interceptors = options.interceptors ? { ...options.interceptors } : void 0, this[kFactory] = factory, this.on("connect", (origin2, targets) => {
          if (clientTtl != null && clientTtl > 0)
            for (let target of targets)
              Object.assign(target, { ttl: Date.now() });
        }), this.on("connectionError", (origin2, targets, error) => {
          for (let target of targets) {
            let idx = this[kClients].indexOf(target);
            idx !== -1 && this[kClients].splice(idx, 1);
          }
        });
      }
      [kGetDispatcher]() {
        let clientTtlOption = this[kOptions].clientTtl;
        for (let client of this[kClients])
          if (clientTtlOption != null && clientTtlOption > 0 && client.ttl && Date.now() - client.ttl > clientTtlOption)
            this[kRemoveClient](client);
          else if (!client[kNeedDrain])
            return client;
        if (!this[kConnections] || this[kClients].length < this[kConnections]) {
          let dispatcher = this[kFactory](this[kUrl], this[kOptions]);
          return this[kAddClient](dispatcher), dispatcher;
        }
      }
    };
    module2.exports = Pool;
  }
});

// lib/dispatcher/agent.js
var require_agent = __commonJS({
  "lib/dispatcher/agent.js"(exports2, module2) {
    "use strict";
    var { InvalidArgumentError, MaxOriginsReachedError } = require_errors(), { kClients, kRunning, kClose, kDestroy, kDispatch, kUrl } = require_symbols(), DispatcherBase = require_dispatcher_base(), Pool = require_pool(), Client = require_client(), util = require_util(), kOnConnect = Symbol("onConnect"), kOnDisconnect = Symbol("onDisconnect"), kOnConnectionError = Symbol("onConnectionError"), kOnDrain = Symbol("onDrain"), kFactory = Symbol("factory"), kOptions = Symbol("options"), kOrigins = Symbol("origins");
    function defaultFactory(origin, opts) {
      return opts && opts.connections === 1 ? new Client(origin, opts) : new Pool(origin, opts);
    }
    __name(defaultFactory, "defaultFactory");
    var Agent = class extends DispatcherBase {
      static {
        __name(this, "Agent");
      }
      constructor({ factory = defaultFactory, maxOrigins = 1 / 0, connect, ...options } = {}) {
        if (typeof factory != "function")
          throw new InvalidArgumentError("factory must be a function.");
        if (connect != null && typeof connect != "function" && typeof connect != "object")
          throw new InvalidArgumentError("connect must be a function or an object");
        if (typeof maxOrigins != "number" || Number.isNaN(maxOrigins) || maxOrigins <= 0)
          throw new InvalidArgumentError("maxOrigins must be a number greater than 0");
        super(), connect && typeof connect != "function" && (connect = { ...connect }), this[kOptions] = { ...util.deepClone(options), maxOrigins, connect }, this[kFactory] = factory, this[kClients] = /* @__PURE__ */ new Map(), this[kOrigins] = /* @__PURE__ */ new Set(), this[kOnDrain] = (origin, targets) => {
          this.emit("drain", origin, [this, ...targets]);
        }, this[kOnConnect] = (origin, targets) => {
          this.emit("connect", origin, [this, ...targets]);
        }, this[kOnDisconnect] = (origin, targets, err) => {
          this.emit("disconnect", origin, [this, ...targets], err);
        }, this[kOnConnectionError] = (origin, targets, err) => {
          this.emit("connectionError", origin, [this, ...targets], err);
        };
      }
      get [kRunning]() {
        let ret = 0;
        for (let { dispatcher } of this[kClients].values())
          ret += dispatcher[kRunning];
        return ret;
      }
      [kDispatch](opts, handler) {
        let key;
        if (opts.origin && (typeof opts.origin == "string" || opts.origin instanceof URL))
          key = String(opts.origin);
        else
          throw new InvalidArgumentError("opts.origin must be a non-empty string or URL.");
        if (this[kOrigins].size >= this[kOptions].maxOrigins && !this[kOrigins].has(key))
          throw new MaxOriginsReachedError();
        let result = this[kClients].get(key), dispatcher = result && result.dispatcher;
        if (!dispatcher) {
          let closeClientIfUnused = /* @__PURE__ */ __name((connected) => {
            let result2 = this[kClients].get(key);
            result2 && (connected && (result2.count -= 1), result2.count <= 0 && (this[kClients].delete(key), result2.dispatcher.close()), this[kOrigins].delete(key));
          }, "closeClientIfUnused");
          dispatcher = this[kFactory](opts.origin, this[kOptions]).on("drain", this[kOnDrain]).on("connect", (origin, targets) => {
            let result2 = this[kClients].get(key);
            result2 && (result2.count += 1), this[kOnConnect](origin, targets);
          }).on("disconnect", (origin, targets, err) => {
            closeClientIfUnused(!0), this[kOnDisconnect](origin, targets, err);
          }).on("connectionError", (origin, targets, err) => {
            closeClientIfUnused(!1), this[kOnConnectionError](origin, targets, err);
          }), this[kClients].set(key, { count: 0, dispatcher }), this[kOrigins].add(key);
        }
        return dispatcher.dispatch(opts, handler);
      }
      [kClose]() {
        let closePromises = [];
        for (let { dispatcher } of this[kClients].values())
          closePromises.push(dispatcher.close());
        return this[kClients].clear(), Promise.all(closePromises);
      }
      [kDestroy](err) {
        let destroyPromises = [];
        for (let { dispatcher } of this[kClients].values())
          destroyPromises.push(dispatcher.destroy(err));
        return this[kClients].clear(), Promise.all(destroyPromises);
      }
      get stats() {
        let allClientStats = {};
        for (let { dispatcher } of this[kClients].values())
          dispatcher.stats && (allClientStats[dispatcher[kUrl].origin] = dispatcher.stats);
        return allClientStats;
      }
    };
    module2.exports = Agent;
  }
});

// lib/global.js
var require_global2 = __commonJS({
  "lib/global.js"(exports2, module2) {
    "use strict";
    var globalDispatcher = Symbol.for("undici.globalDispatcher.1"), { InvalidArgumentError } = require_errors(), Agent = require_agent();
    getGlobalDispatcher2() === void 0 && setGlobalDispatcher2(new Agent());
    function setGlobalDispatcher2(agent) {
      if (!agent || typeof agent.dispatch != "function")
        throw new InvalidArgumentError("Argument agent must implement Agent");
      Object.defineProperty(globalThis, globalDispatcher, {
        value: agent,
        writable: !0,
        enumerable: !1,
        configurable: !1
      });
    }
    __name(setGlobalDispatcher2, "setGlobalDispatcher");
    function getGlobalDispatcher2() {
      return globalThis[globalDispatcher];
    }
    __name(getGlobalDispatcher2, "getGlobalDispatcher");
    var installedExports = (
      /** @type {const} */
      [
        "fetch",
        "Headers",
        "Response",
        "Request",
        "FormData",
        "WebSocket",
        "CloseEvent",
        "ErrorEvent",
        "MessageEvent",
        "EventSource"
      ]
    );
    module2.exports = {
      setGlobalDispatcher: setGlobalDispatcher2,
      getGlobalDispatcher: getGlobalDispatcher2,
      installedExports
    };
  }
});

// lib/dispatcher/proxy-agent.js
var require_proxy_agent = __commonJS({
  "lib/dispatcher/proxy-agent.js"(exports2, module2) {
    "use strict";
    var { kProxy, kClose, kDestroy, kDispatch } = require_symbols(), Agent = require_agent(), Pool = require_pool(), DispatcherBase = require_dispatcher_base(), { InvalidArgumentError, RequestAbortedError, SecureProxyConnectionError } = require_errors(), buildConnector = require_connect(), Client = require_client(), { channels } = require_diagnostics(), kAgent = Symbol("proxy agent"), kClient = Symbol("proxy client"), kProxyHeaders = Symbol("proxy headers"), kRequestTls = Symbol("request tls settings"), kProxyTls = Symbol("proxy tls settings"), kConnectEndpoint = Symbol("connect endpoint function"), kTunnelProxy = Symbol("tunnel proxy");
    function defaultProtocolPort(protocol) {
      return protocol === "https:" ? 443 : 80;
    }
    __name(defaultProtocolPort, "defaultProtocolPort");
    function defaultFactory(origin, opts) {
      return new Pool(origin, opts);
    }
    __name(defaultFactory, "defaultFactory");
    var noop = /* @__PURE__ */ __name(() => {
    }, "noop");
    function defaultAgentFactory(origin, opts) {
      return opts.connections === 1 ? new Client(origin, opts) : new Pool(origin, opts);
    }
    __name(defaultAgentFactory, "defaultAgentFactory");
    var Http1ProxyWrapper = class extends DispatcherBase {
      static {
        __name(this, "Http1ProxyWrapper");
      }
      #client;
      constructor(proxyUrl, { headers = {}, connect, factory }) {
        if (!proxyUrl)
          throw new InvalidArgumentError("Proxy URL is mandatory");
        super(), this[kProxyHeaders] = headers, factory ? this.#client = factory(proxyUrl, { connect }) : this.#client = new Client(proxyUrl, { connect });
      }
      [kDispatch](opts, handler) {
        let onHeaders = handler.onHeaders;
        handler.onHeaders = function(statusCode, data, resume) {
          if (statusCode === 407) {
            typeof handler.onError == "function" && handler.onError(new InvalidArgumentError("Proxy Authentication Required (407)"));
            return;
          }
          onHeaders && onHeaders.call(this, statusCode, data, resume);
        };
        let {
          origin,
          path = "/",
          headers = {}
        } = opts;
        if (opts.path = origin + path, !("host" in headers) && !("Host" in headers)) {
          let { host } = new URL(origin);
          headers.host = host;
        }
        return opts.headers = { ...this[kProxyHeaders], ...headers }, this.#client[kDispatch](opts, handler);
      }
      [kClose]() {
        return this.#client.close();
      }
      [kDestroy](err) {
        return this.#client.destroy(err);
      }
    }, ProxyAgent = class extends DispatcherBase {
      static {
        __name(this, "ProxyAgent");
      }
      constructor(opts) {
        if (!opts || typeof opts == "object" && !(opts instanceof URL) && !opts.uri)
          throw new InvalidArgumentError("Proxy uri is mandatory");
        let { clientFactory = defaultFactory } = opts;
        if (typeof clientFactory != "function")
          throw new InvalidArgumentError("Proxy opts.clientFactory must be a function.");
        let { proxyTunnel = !0 } = opts;
        super();
        let url = this.#getUrl(opts), { href, origin, port, protocol, username, password, hostname: proxyHostname } = url;
        if (this[kProxy] = { uri: href, protocol }, this[kRequestTls] = opts.requestTls, this[kProxyTls] = opts.proxyTls, this[kProxyHeaders] = opts.headers || {}, this[kTunnelProxy] = proxyTunnel, opts.auth && opts.token)
          throw new InvalidArgumentError("opts.auth cannot be used in combination with opts.token");
        opts.auth ? this[kProxyHeaders]["proxy-authorization"] = `Basic ${opts.auth}` : opts.token ? this[kProxyHeaders]["proxy-authorization"] = opts.token : username && password && (this[kProxyHeaders]["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`);
        let connect = buildConnector({ ...opts.proxyTls });
        this[kConnectEndpoint] = buildConnector({ ...opts.requestTls });
        let agentFactory = opts.factory || defaultAgentFactory, factory = /* @__PURE__ */ __name((origin2, options) => {
          let { protocol: protocol2 } = new URL(origin2);
          return !this[kTunnelProxy] && protocol2 === "http:" && this[kProxy].protocol === "http:" ? new Http1ProxyWrapper(this[kProxy].uri, {
            headers: this[kProxyHeaders],
            connect,
            factory: agentFactory
          }) : agentFactory(origin2, options);
        }, "factory");
        this[kClient] = clientFactory(url, { connect }), this[kAgent] = new Agent({
          ...opts,
          factory,
          connect: /* @__PURE__ */ __name(async (opts2, callback) => {
            let requestedPath = opts2.host;
            opts2.port || (requestedPath += `:${defaultProtocolPort(opts2.protocol)}`);
            try {
              let connectParams = {
                origin,
                port,
                path: requestedPath,
                signal: opts2.signal,
                headers: {
                  ...this[kProxyHeaders],
                  host: opts2.host,
                  ...opts2.connections == null || opts2.connections > 0 ? { "proxy-connection": "keep-alive" } : {}
                },
                servername: this[kProxyTls]?.servername || proxyHostname
              }, { socket, statusCode } = await this[kClient].connect(connectParams);
              if (statusCode !== 200) {
                socket.on("error", noop).destroy(), callback(new RequestAbortedError(`Proxy response (${statusCode}) !== 200 when HTTP Tunneling`));
                return;
              }
              if (channels.proxyConnected.hasSubscribers && channels.proxyConnected.publish({
                socket,
                connectParams
              }), opts2.protocol !== "https:") {
                callback(null, socket);
                return;
              }
              let servername;
              this[kRequestTls] ? servername = this[kRequestTls].servername : servername = opts2.servername, this[kConnectEndpoint]({ ...opts2, servername, httpSocket: socket }, callback);
            } catch (err) {
              err.code === "ERR_TLS_CERT_ALTNAME_INVALID" ? callback(new SecureProxyConnectionError(err)) : callback(err);
            }
          }, "connect")
        });
      }
      dispatch(opts, handler) {
        let headers = buildHeaders(opts.headers);
        if (throwIfProxyAuthIsSent(headers), headers && !("host" in headers) && !("Host" in headers)) {
          let { host } = new URL(opts.origin);
          headers.host = host;
        }
        return this[kAgent].dispatch(
          {
            ...opts,
            headers
          },
          handler
        );
      }
      /**
       * @param {import('../../types/proxy-agent').ProxyAgent.Options | string | URL} opts
       * @returns {URL}
       */
      #getUrl(opts) {
        return typeof opts == "string" ? new URL(opts) : opts instanceof URL ? opts : new URL(opts.uri);
      }
      [kClose]() {
        return Promise.all([
          this[kAgent].close(),
          this[kClient].close()
        ]);
      }
      [kDestroy]() {
        return Promise.all([
          this[kAgent].destroy(),
          this[kClient].destroy()
        ]);
      }
    };
    function buildHeaders(headers) {
      if (Array.isArray(headers)) {
        let headersPair = {};
        for (let i = 0; i < headers.length; i += 2)
          headersPair[headers[i]] = headers[i + 1];
        return headersPair;
      }
      return headers;
    }
    __name(buildHeaders, "buildHeaders");
    function throwIfProxyAuthIsSent(headers) {
      if (headers && Object.keys(headers).find((key) => key.toLowerCase() === "proxy-authorization"))
        throw new InvalidArgumentError("Proxy-Authorization should be sent in ProxyAgent constructor");
    }
    __name(throwIfProxyAuthIsSent, "throwIfProxyAuthIsSent");
    module2.exports = ProxyAgent;
  }
});

// lib/dispatcher/env-http-proxy-agent.js
var require_env_http_proxy_agent = __commonJS({
  "lib/dispatcher/env-http-proxy-agent.js"(exports2, module2) {
    "use strict";
    var DispatcherBase = require_dispatcher_base(), { kClose, kDestroy, kClosed, kDestroyed, kDispatch, kNoProxyAgent, kHttpProxyAgent, kHttpsProxyAgent } = require_symbols(), ProxyAgent = require_proxy_agent(), Agent = require_agent(), DEFAULT_PORTS = {
      "http:": 80,
      "https:": 443
    }, EnvHttpProxyAgent2 = class extends DispatcherBase {
      static {
        __name(this, "EnvHttpProxyAgent");
      }
      #noProxyValue = null;
      #noProxyEntries = null;
      #opts = null;
      constructor(opts = {}) {
        super(), this.#opts = opts;
        let { httpProxy, httpsProxy, noProxy, ...agentOpts } = opts;
        this[kNoProxyAgent] = new Agent(agentOpts);
        let HTTP_PROXY = httpProxy ?? process.env.http_proxy ?? process.env.HTTP_PROXY;
        HTTP_PROXY ? this[kHttpProxyAgent] = new ProxyAgent({ ...agentOpts, uri: HTTP_PROXY }) : this[kHttpProxyAgent] = this[kNoProxyAgent];
        let HTTPS_PROXY = httpsProxy ?? process.env.https_proxy ?? process.env.HTTPS_PROXY;
        HTTPS_PROXY ? this[kHttpsProxyAgent] = new ProxyAgent({ ...agentOpts, uri: HTTPS_PROXY }) : this[kHttpsProxyAgent] = this[kHttpProxyAgent], this.#parseNoProxy();
      }
      [kDispatch](opts, handler) {
        let url = new URL(opts.origin);
        return this.#getProxyAgentForUrl(url).dispatch(opts, handler);
      }
      [kClose]() {
        return Promise.all([
          this[kNoProxyAgent].close(),
          !this[kHttpProxyAgent][kClosed] && this[kHttpProxyAgent].close(),
          !this[kHttpsProxyAgent][kClosed] && this[kHttpsProxyAgent].close()
        ]);
      }
      [kDestroy](err) {
        return Promise.all([
          this[kNoProxyAgent].destroy(err),
          !this[kHttpProxyAgent][kDestroyed] && this[kHttpProxyAgent].destroy(err),
          !this[kHttpsProxyAgent][kDestroyed] && this[kHttpsProxyAgent].destroy(err)
        ]);
      }
      #getProxyAgentForUrl(url) {
        let { protocol, host: hostname, port } = url;
        return hostname = hostname.replace(/:\d*$/, "").toLowerCase(), port = Number.parseInt(port, 10) || DEFAULT_PORTS[protocol] || 0, this.#shouldProxy(hostname, port) ? protocol === "https:" ? this[kHttpsProxyAgent] : this[kHttpProxyAgent] : this[kNoProxyAgent];
      }
      #shouldProxy(hostname, port) {
        if (this.#noProxyChanged && this.#parseNoProxy(), this.#noProxyEntries.length === 0)
          return !0;
        if (this.#noProxyValue === "*")
          return !1;
        for (let i = 0; i < this.#noProxyEntries.length; i++) {
          let entry = this.#noProxyEntries[i];
          if (!(entry.port && entry.port !== port)) {
            if (/^[.*]/.test(entry.hostname)) {
              if (hostname.endsWith(entry.hostname.replace(/^\*/, "")))
                return !1;
            } else if (hostname === entry.hostname)
              return !1;
          }
        }
        return !0;
      }
      #parseNoProxy() {
        let noProxyValue = this.#opts.noProxy ?? this.#noProxyEnv, noProxySplit = noProxyValue.split(/[,\s]/), noProxyEntries = [];
        for (let i = 0; i < noProxySplit.length; i++) {
          let entry = noProxySplit[i];
          if (!entry)
            continue;
          let parsed = entry.match(/^(.+):(\d+)$/);
          noProxyEntries.push({
            hostname: (parsed ? parsed[1] : entry).toLowerCase(),
            port: parsed ? Number.parseInt(parsed[2], 10) : 0
          });
        }
        this.#noProxyValue = noProxyValue, this.#noProxyEntries = noProxyEntries;
      }
      get #noProxyChanged() {
        return this.#opts.noProxy !== void 0 ? !1 : this.#noProxyValue !== this.#noProxyEnv;
      }
      get #noProxyEnv() {
        return process.env.no_proxy ?? process.env.NO_PROXY ?? "";
      }
    };
    module2.exports = EnvHttpProxyAgent2;
  }
});

// lib/web/fetch/headers.js
var require_headers = __commonJS({
  "lib/web/fetch/headers.js"(exports2, module2) {
    "use strict";
    var { kConstruct } = require_symbols(), { kEnumerableProperty } = require_util(), {
      iteratorMixin,
      isValidHeaderName,
      isValidHeaderValue
    } = require_util2(), { webidl } = require_webidl(), assert = require("node:assert"), util = require("node:util");
    function isHTTPWhiteSpaceCharCode(code) {
      return code === 10 || code === 13 || code === 9 || code === 32;
    }
    __name(isHTTPWhiteSpaceCharCode, "isHTTPWhiteSpaceCharCode");
    function headerValueNormalize(potentialValue) {
      let i = 0, j = potentialValue.length;
      for (; j > i && isHTTPWhiteSpaceCharCode(potentialValue.charCodeAt(j - 1)); ) --j;
      for (; j > i && isHTTPWhiteSpaceCharCode(potentialValue.charCodeAt(i)); ) ++i;
      return i === 0 && j === potentialValue.length ? potentialValue : potentialValue.substring(i, j);
    }
    __name(headerValueNormalize, "headerValueNormalize");
    function fill(headers, object) {
      if (Array.isArray(object))
        for (let i = 0; i < object.length; ++i) {
          let header = object[i];
          if (header.length !== 2)
            throw webidl.errors.exception({
              header: "Headers constructor",
              message: `expected name/value pair to be length 2, found ${header.length}.`
            });
          appendHeader(headers, header[0], header[1]);
        }
      else if (typeof object == "object" && object !== null) {
        let keys = Object.keys(object);
        for (let i = 0; i < keys.length; ++i)
          appendHeader(headers, keys[i], object[keys[i]]);
      } else
        throw webidl.errors.conversionFailed({
          prefix: "Headers constructor",
          argument: "Argument 1",
          types: ["sequence<sequence<ByteString>>", "record<ByteString, ByteString>"]
        });
    }
    __name(fill, "fill");
    function appendHeader(headers, name, value) {
      if (value = headerValueNormalize(value), isValidHeaderName(name)) {
        if (!isValidHeaderValue(value))
          throw webidl.errors.invalidArgument({
            prefix: "Headers.append",
            value,
            type: "header value"
          });
      } else throw webidl.errors.invalidArgument({
        prefix: "Headers.append",
        value: name,
        type: "header name"
      });
      if (getHeadersGuard(headers) === "immutable")
        throw new TypeError("immutable");
      return getHeadersList(headers).append(name, value, !1);
    }
    __name(appendHeader, "appendHeader");
    function headersListSortAndCombine(target) {
      let headersList = getHeadersList(target);
      if (!headersList)
        return [];
      if (headersList.sortedMap)
        return headersList.sortedMap;
      let headers = [], names = headersList.toSortedArray(), cookies = headersList.cookies;
      if (cookies === null || cookies.length === 1)
        return headersList.sortedMap = names;
      for (let i = 0; i < names.length; ++i) {
        let { 0: name, 1: value } = names[i];
        if (name === "set-cookie")
          for (let j = 0; j < cookies.length; ++j)
            headers.push([name, cookies[j]]);
        else
          headers.push([name, value]);
      }
      return headersList.sortedMap = headers;
    }
    __name(headersListSortAndCombine, "headersListSortAndCombine");
    function compareHeaderName(a, b) {
      return a[0] < b[0] ? -1 : 1;
    }
    __name(compareHeaderName, "compareHeaderName");
    var HeadersList = class _HeadersList {
      static {
        __name(this, "HeadersList");
      }
      /** @type {[string, string][]|null} */
      cookies = null;
      sortedMap;
      headersMap;
      constructor(init) {
        init instanceof _HeadersList ? (this.headersMap = new Map(init.headersMap), this.sortedMap = init.sortedMap, this.cookies = init.cookies === null ? null : [...init.cookies]) : (this.headersMap = new Map(init), this.sortedMap = null);
      }
      /**
       * @see https://fetch.spec.whatwg.org/#header-list-contains
       * @param {string} name
       * @param {boolean} isLowerCase
       */
      contains(name, isLowerCase) {
        return this.headersMap.has(isLowerCase ? name : name.toLowerCase());
      }
      clear() {
        this.headersMap.clear(), this.sortedMap = null, this.cookies = null;
      }
      /**
       * @see https://fetch.spec.whatwg.org/#concept-header-list-append
       * @param {string} name
       * @param {string} value
       * @param {boolean} isLowerCase
       */
      append(name, value, isLowerCase) {
        this.sortedMap = null;
        let lowercaseName = isLowerCase ? name : name.toLowerCase(), exists = this.headersMap.get(lowercaseName);
        if (exists) {
          let delimiter = lowercaseName === "cookie" ? "; " : ", ";
          this.headersMap.set(lowercaseName, {
            name: exists.name,
            value: `${exists.value}${delimiter}${value}`
          });
        } else
          this.headersMap.set(lowercaseName, { name, value });
        lowercaseName === "set-cookie" && (this.cookies ??= []).push(value);
      }
      /**
       * @see https://fetch.spec.whatwg.org/#concept-header-list-set
       * @param {string} name
       * @param {string} value
       * @param {boolean} isLowerCase
       */
      set(name, value, isLowerCase) {
        this.sortedMap = null;
        let lowercaseName = isLowerCase ? name : name.toLowerCase();
        lowercaseName === "set-cookie" && (this.cookies = [value]), this.headersMap.set(lowercaseName, { name, value });
      }
      /**
       * @see https://fetch.spec.whatwg.org/#concept-header-list-delete
       * @param {string} name
       * @param {boolean} isLowerCase
       */
      delete(name, isLowerCase) {
        this.sortedMap = null, isLowerCase || (name = name.toLowerCase()), name === "set-cookie" && (this.cookies = null), this.headersMap.delete(name);
      }
      /**
       * @see https://fetch.spec.whatwg.org/#concept-header-list-get
       * @param {string} name
       * @param {boolean} isLowerCase
       * @returns {string | null}
       */
      get(name, isLowerCase) {
        return this.headersMap.get(isLowerCase ? name : name.toLowerCase())?.value ?? null;
      }
      *[Symbol.iterator]() {
        for (let { 0: name, 1: { value } } of this.headersMap)
          yield [name, value];
      }
      get entries() {
        let headers = {};
        if (this.headersMap.size !== 0)
          for (let { name, value } of this.headersMap.values())
            headers[name] = value;
        return headers;
      }
      rawValues() {
        return this.headersMap.values();
      }
      get entriesList() {
        let headers = [];
        if (this.headersMap.size !== 0)
          for (let { 0: lowerName, 1: { name, value } } of this.headersMap)
            if (lowerName === "set-cookie")
              for (let cookie of this.cookies)
                headers.push([name, cookie]);
            else
              headers.push([name, value]);
        return headers;
      }
      // https://fetch.spec.whatwg.org/#convert-header-names-to-a-sorted-lowercase-set
      toSortedArray() {
        let size = this.headersMap.size, array = new Array(size);
        if (size <= 32) {
          if (size === 0)
            return array;
          let iterator = this.headersMap[Symbol.iterator](), firstValue = iterator.next().value;
          array[0] = [firstValue[0], firstValue[1].value], assert(firstValue[1].value !== null);
          for (let i = 1, j = 0, right = 0, left = 0, pivot = 0, x, value; i < size; ++i) {
            for (value = iterator.next().value, x = array[i] = [value[0], value[1].value], assert(x[1] !== null), left = 0, right = i; left < right; )
              pivot = left + (right - left >> 1), array[pivot][0] <= x[0] ? left = pivot + 1 : right = pivot;
            if (i !== pivot) {
              for (j = i; j > left; )
                array[j] = array[--j];
              array[left] = x;
            }
          }
          if (!iterator.next().done)
            throw new TypeError("Unreachable");
          return array;
        } else {
          let i = 0;
          for (let { 0: name, 1: { value } } of this.headersMap)
            array[i++] = [name, value], assert(value !== null);
          return array.sort(compareHeaderName);
        }
      }
    }, Headers = class _Headers {
      static {
        __name(this, "Headers");
      }
      #guard;
      /**
       * @type {HeadersList}
       */
      #headersList;
      /**
       * @param {HeadersInit|Symbol} [init]
       * @returns
       */
      constructor(init = void 0) {
        webidl.util.markAsUncloneable(this), init !== kConstruct && (this.#headersList = new HeadersList(), this.#guard = "none", init !== void 0 && (init = webidl.converters.HeadersInit(init, "Headers constructor", "init"), fill(this, init)));
      }
      // https://fetch.spec.whatwg.org/#dom-headers-append
      append(name, value) {
        webidl.brandCheck(this, _Headers), webidl.argumentLengthCheck(arguments, 2, "Headers.append");
        let prefix = "Headers.append";
        return name = webidl.converters.ByteString(name, prefix, "name"), value = webidl.converters.ByteString(value, prefix, "value"), appendHeader(this, name, value);
      }
      // https://fetch.spec.whatwg.org/#dom-headers-delete
      delete(name) {
        if (webidl.brandCheck(this, _Headers), webidl.argumentLengthCheck(arguments, 1, "Headers.delete"), name = webidl.converters.ByteString(name, "Headers.delete", "name"), !isValidHeaderName(name))
          throw webidl.errors.invalidArgument({
            prefix: "Headers.delete",
            value: name,
            type: "header name"
          });
        if (this.#guard === "immutable")
          throw new TypeError("immutable");
        this.#headersList.contains(name, !1) && this.#headersList.delete(name, !1);
      }
      // https://fetch.spec.whatwg.org/#dom-headers-get
      get(name) {
        webidl.brandCheck(this, _Headers), webidl.argumentLengthCheck(arguments, 1, "Headers.get");
        let prefix = "Headers.get";
        if (name = webidl.converters.ByteString(name, prefix, "name"), !isValidHeaderName(name))
          throw webidl.errors.invalidArgument({
            prefix,
            value: name,
            type: "header name"
          });
        return this.#headersList.get(name, !1);
      }
      // https://fetch.spec.whatwg.org/#dom-headers-has
      has(name) {
        webidl.brandCheck(this, _Headers), webidl.argumentLengthCheck(arguments, 1, "Headers.has");
        let prefix = "Headers.has";
        if (name = webidl.converters.ByteString(name, prefix, "name"), !isValidHeaderName(name))
          throw webidl.errors.invalidArgument({
            prefix,
            value: name,
            type: "header name"
          });
        return this.#headersList.contains(name, !1);
      }
      // https://fetch.spec.whatwg.org/#dom-headers-set
      set(name, value) {
        webidl.brandCheck(this, _Headers), webidl.argumentLengthCheck(arguments, 2, "Headers.set");
        let prefix = "Headers.set";
        if (name = webidl.converters.ByteString(name, prefix, "name"), value = webidl.converters.ByteString(value, prefix, "value"), value = headerValueNormalize(value), isValidHeaderName(name)) {
          if (!isValidHeaderValue(value))
            throw webidl.errors.invalidArgument({
              prefix,
              value,
              type: "header value"
            });
        } else throw webidl.errors.invalidArgument({
          prefix,
          value: name,
          type: "header name"
        });
        if (this.#guard === "immutable")
          throw new TypeError("immutable");
        this.#headersList.set(name, value, !1);
      }
      // https://fetch.spec.whatwg.org/#dom-headers-getsetcookie
      getSetCookie() {
        webidl.brandCheck(this, _Headers);
        let list = this.#headersList.cookies;
        return list ? [...list] : [];
      }
      [util.inspect.custom](depth, options) {
        return options.depth ??= depth, `Headers ${util.formatWithOptions(options, this.#headersList.entries)}`;
      }
      static getHeadersGuard(o) {
        return o.#guard;
      }
      static setHeadersGuard(o, guard) {
        o.#guard = guard;
      }
      /**
       * @param {Headers} o
       */
      static getHeadersList(o) {
        return o.#headersList;
      }
      /**
       * @param {Headers} target
       * @param {HeadersList} list
       */
      static setHeadersList(target, list) {
        target.#headersList = list;
      }
    }, { getHeadersGuard, setHeadersGuard, getHeadersList, setHeadersList } = Headers;
    Reflect.deleteProperty(Headers, "getHeadersGuard");
    Reflect.deleteProperty(Headers, "setHeadersGuard");
    Reflect.deleteProperty(Headers, "getHeadersList");
    Reflect.deleteProperty(Headers, "setHeadersList");
    iteratorMixin("Headers", Headers, headersListSortAndCombine, 0, 1);
    Object.defineProperties(Headers.prototype, {
      append: kEnumerableProperty,
      delete: kEnumerableProperty,
      get: kEnumerableProperty,
      has: kEnumerableProperty,
      set: kEnumerableProperty,
      getSetCookie: kEnumerableProperty,
      [Symbol.toStringTag]: {
        value: "Headers",
        configurable: !0
      },
      [util.inspect.custom]: {
        enumerable: !1
      }
    });
    webidl.converters.HeadersInit = function(V, prefix, argument) {
      if (webidl.util.Type(V) === webidl.util.Types.OBJECT) {
        let iterator = Reflect.get(V, Symbol.iterator);
        if (!util.types.isProxy(V) && iterator === Headers.prototype.entries)
          try {
            return getHeadersList(V).entriesList;
          } catch {
          }
        return typeof iterator == "function" ? webidl.converters["sequence<sequence<ByteString>>"](V, prefix, argument, iterator.bind(V)) : webidl.converters["record<ByteString, ByteString>"](V, prefix, argument);
      }
      throw webidl.errors.conversionFailed({
        prefix: "Headers constructor",
        argument: "Argument 1",
        types: ["sequence<sequence<ByteString>>", "record<ByteString, ByteString>"]
      });
    };
    module2.exports = {
      fill,
      // for test.
      compareHeaderName,
      Headers,
      HeadersList,
      getHeadersGuard,
      setHeadersGuard,
      setHeadersList,
      getHeadersList
    };
  }
});

// lib/web/fetch/response.js
var require_response = __commonJS({
  "lib/web/fetch/response.js"(exports2, module2) {
    "use strict";
    var { Headers, HeadersList, fill, getHeadersGuard, setHeadersGuard, setHeadersList } = require_headers(), { extractBody, cloneBody, mixinBody, streamRegistry, bodyUnusable } = require_body(), util = require_util(), nodeUtil = require("node:util"), { kEnumerableProperty } = util, {
      isValidReasonPhrase,
      isCancelled,
      isAborted,
      isErrorLike,
      environmentSettingsObject: relevantRealm
    } = require_util2(), {
      redirectStatusSet,
      nullBodyStatus
    } = require_constants3(), { webidl } = require_webidl(), { URLSerializer } = require_data_url(), { kConstruct } = require_symbols(), assert = require("node:assert"), { isomorphicEncode, serializeJavascriptValueToJSONString } = require_infra(), textEncoder = new TextEncoder("utf-8"), Response = class _Response {
      static {
        __name(this, "Response");
      }
      /** @type {Headers} */
      #headers;
      #state;
      // Creates network error Response.
      static error() {
        return fromInnerResponse(makeNetworkError(), "immutable");
      }
      // https://fetch.spec.whatwg.org/#dom-response-json
      static json(data, init = void 0) {
        webidl.argumentLengthCheck(arguments, 1, "Response.json"), init !== null && (init = webidl.converters.ResponseInit(init));
        let bytes = textEncoder.encode(
          serializeJavascriptValueToJSONString(data)
        ), body = extractBody(bytes), responseObject = fromInnerResponse(makeResponse({}), "response");
        return initializeResponse(responseObject, init, { body: body[0], type: "application/json" }), responseObject;
      }
      // Creates a redirect Response that redirects to url with status status.
      static redirect(url, status = 302) {
        webidl.argumentLengthCheck(arguments, 1, "Response.redirect"), url = webidl.converters.USVString(url), status = webidl.converters["unsigned short"](status);
        let parsedURL;
        try {
          parsedURL = new URL(url, relevantRealm.settingsObject.baseUrl);
        } catch (err) {
          throw new TypeError(`Failed to parse URL from ${url}`, { cause: err });
        }
        if (!redirectStatusSet.has(status))
          throw new RangeError(`Invalid status code ${status}`);
        let responseObject = fromInnerResponse(makeResponse({}), "immutable");
        responseObject.#state.status = status;
        let value = isomorphicEncode(URLSerializer(parsedURL));
        return responseObject.#state.headersList.append("location", value, !0), responseObject;
      }
      // https://fetch.spec.whatwg.org/#dom-response
      constructor(body = null, init = void 0) {
        if (webidl.util.markAsUncloneable(this), body === kConstruct)
          return;
        body !== null && (body = webidl.converters.BodyInit(body, "Response", "body")), init = webidl.converters.ResponseInit(init), this.#state = makeResponse({}), this.#headers = new Headers(kConstruct), setHeadersGuard(this.#headers, "response"), setHeadersList(this.#headers, this.#state.headersList);
        let bodyWithType = null;
        if (body != null) {
          let [extractedBody, type] = extractBody(body);
          bodyWithType = { body: extractedBody, type };
        }
        initializeResponse(this, init, bodyWithType);
      }
      // Returns response?s type, e.g., "cors".
      get type() {
        return webidl.brandCheck(this, _Response), this.#state.type;
      }
      // Returns response?s URL, if it has one; otherwise the empty string.
      get url() {
        webidl.brandCheck(this, _Response);
        let urlList = this.#state.urlList, url = urlList[urlList.length - 1] ?? null;
        return url === null ? "" : URLSerializer(url, !0);
      }
      // Returns whether response was obtained through a redirect.
      get redirected() {
        return webidl.brandCheck(this, _Response), this.#state.urlList.length > 1;
      }
      // Returns response?s status.
      get status() {
        return webidl.brandCheck(this, _Response), this.#state.status;
      }
      // Returns whether response?s status is an ok status.
      get ok() {
        return webidl.brandCheck(this, _Response), this.#state.status >= 200 && this.#state.status <= 299;
      }
      // Returns response?s status message.
      get statusText() {
        return webidl.brandCheck(this, _Response), this.#state.statusText;
      }
      // Returns response?s headers as Headers.
      get headers() {
        return webidl.brandCheck(this, _Response), this.#headers;
      }
      get body() {
        return webidl.brandCheck(this, _Response), this.#state.body ? this.#state.body.stream : null;
      }
      get bodyUsed() {
        return webidl.brandCheck(this, _Response), !!this.#state.body && util.isDisturbed(this.#state.body.stream);
      }
      // Returns a clone of response.
      clone() {
        if (webidl.brandCheck(this, _Response), bodyUnusable(this.#state))
          throw webidl.errors.exception({
            header: "Response.clone",
            message: "Body has already been consumed."
          });
        let clonedResponse = cloneResponse(this.#state);
        return this.#state.body?.stream && streamRegistry.register(this, new WeakRef(this.#state.body.stream)), fromInnerResponse(clonedResponse, getHeadersGuard(this.#headers));
      }
      [nodeUtil.inspect.custom](depth, options) {
        options.depth === null && (options.depth = 2), options.colors ??= !0;
        let properties = {
          status: this.status,
          statusText: this.statusText,
          headers: this.headers,
          body: this.body,
          bodyUsed: this.bodyUsed,
          ok: this.ok,
          redirected: this.redirected,
          type: this.type,
          url: this.url
        };
        return `Response ${nodeUtil.formatWithOptions(options, properties)}`;
      }
      /**
       * @param {Response} response
       */
      static getResponseHeaders(response) {
        return response.#headers;
      }
      /**
       * @param {Response} response
       * @param {Headers} newHeaders
       */
      static setResponseHeaders(response, newHeaders) {
        response.#headers = newHeaders;
      }
      /**
       * @param {Response} response
       */
      static getResponseState(response) {
        return response.#state;
      }
      /**
       * @param {Response} response
       * @param {any} newState
       */
      static setResponseState(response, newState) {
        response.#state = newState;
      }
    }, { getResponseHeaders, setResponseHeaders, getResponseState, setResponseState } = Response;
    Reflect.deleteProperty(Response, "getResponseHeaders");
    Reflect.deleteProperty(Response, "setResponseHeaders");
    Reflect.deleteProperty(Response, "getResponseState");
    Reflect.deleteProperty(Response, "setResponseState");
    mixinBody(Response, getResponseState);
    Object.defineProperties(Response.prototype, {
      type: kEnumerableProperty,
      url: kEnumerableProperty,
      status: kEnumerableProperty,
      ok: kEnumerableProperty,
      redirected: kEnumerableProperty,
      statusText: kEnumerableProperty,
      headers: kEnumerableProperty,
      clone: kEnumerableProperty,
      body: kEnumerableProperty,
      bodyUsed: kEnumerableProperty,
      [Symbol.toStringTag]: {
        value: "Response",
        configurable: !0
      }
    });
    Object.defineProperties(Response, {
      json: kEnumerableProperty,
      redirect: kEnumerableProperty,
      error: kEnumerableProperty
    });
    function cloneResponse(response) {
      if (response.internalResponse)
        return filterResponse(
          cloneResponse(response.internalResponse),
          response.type
        );
      let newResponse = makeResponse({ ...response, body: null });
      return response.body != null && (newResponse.body = cloneBody(response.body)), newResponse;
    }
    __name(cloneResponse, "cloneResponse");
    function makeResponse(init) {
      return {
        aborted: !1,
        rangeRequested: !1,
        timingAllowPassed: !1,
        requestIncludesCredentials: !1,
        type: "default",
        status: 200,
        timingInfo: null,
        cacheState: "",
        statusText: "",
        ...init,
        headersList: init?.headersList ? new HeadersList(init?.headersList) : new HeadersList(),
        urlList: init?.urlList ? [...init.urlList] : []
      };
    }
    __name(makeResponse, "makeResponse");
    function makeNetworkError(reason) {
      let isError = isErrorLike(reason);
      return makeResponse({
        type: "error",
        status: 0,
        error: isError ? reason : new Error(reason && String(reason)),
        aborted: reason && reason.name === "AbortError"
      });
    }
    __name(makeNetworkError, "makeNetworkError");
    function isNetworkError(response) {
      return (
        // A network error is a response whose type is "error",
        response.type === "error" && // status is 0
        response.status === 0
      );
    }
    __name(isNetworkError, "isNetworkError");
    function makeFilteredResponse(response, state) {
      return state = {
        internalResponse: response,
        ...state
      }, new Proxy(response, {
        get(target, p) {
          return p in state ? state[p] : target[p];
        },
        set(target, p, value) {
          return assert(!(p in state)), target[p] = value, !0;
        }
      });
    }
    __name(makeFilteredResponse, "makeFilteredResponse");
    function filterResponse(response, type) {
      if (type === "basic")
        return makeFilteredResponse(response, {
          type: "basic",
          headersList: response.headersList
        });
      if (type === "cors")
        return makeFilteredResponse(response, {
          type: "cors",
          headersList: response.headersList
        });
      if (type === "opaque")
        return makeFilteredResponse(response, {
          type: "opaque",
          urlList: [],
          status: 0,
          statusText: "",
          body: null
        });
      if (type === "opaqueredirect")
        return makeFilteredResponse(response, {
          type: "opaqueredirect",
          status: 0,
          statusText: "",
          headersList: [],
          body: null
        });
      assert(!1);
    }
    __name(filterResponse, "filterResponse");
    function makeAppropriateNetworkError(fetchParams, err = null) {
      return assert(isCancelled(fetchParams)), isAborted(fetchParams) ? makeNetworkError(Object.assign(new DOMException("The operation was aborted.", "AbortError"), { cause: err })) : makeNetworkError(Object.assign(new DOMException("Request was cancelled."), { cause: err }));
    }
    __name(makeAppropriateNetworkError, "makeAppropriateNetworkError");
    function initializeResponse(response, init, body) {
      if (init.status !== null && (init.status < 200 || init.status > 599))
        throw new RangeError('init["status"] must be in the range of 200 to 599, inclusive.');
      if ("statusText" in init && init.statusText != null && !isValidReasonPhrase(String(init.statusText)))
        throw new TypeError("Invalid statusText");
      if ("status" in init && init.status != null && (getResponseState(response).status = init.status), "statusText" in init && init.statusText != null && (getResponseState(response).statusText = init.statusText), "headers" in init && init.headers != null && fill(getResponseHeaders(response), init.headers), body) {
        if (nullBodyStatus.includes(response.status))
          throw webidl.errors.exception({
            header: "Response constructor",
            message: `Invalid response status code ${response.status}`
          });
        getResponseState(response).body = body.body, body.type != null && !getResponseState(response).headersList.contains("content-type", !0) && getResponseState(response).headersList.append("content-type", body.type, !0);
      }
    }
    __name(initializeResponse, "initializeResponse");
    function fromInnerResponse(innerResponse, guard) {
      let response = new Response(kConstruct);
      setResponseState(response, innerResponse);
      let headers = new Headers(kConstruct);
      return setResponseHeaders(response, headers), setHeadersList(headers, innerResponse.headersList), setHeadersGuard(headers, guard), innerResponse.body?.stream && streamRegistry.register(response, new WeakRef(innerResponse.body.stream)), response;
    }
    __name(fromInnerResponse, "fromInnerResponse");
    webidl.converters.XMLHttpRequestBodyInit = function(V, prefix, name) {
      return typeof V == "string" ? webidl.converters.USVString(V, prefix, name) : webidl.is.Blob(V) || webidl.is.BufferSource(V) || webidl.is.FormData(V) || webidl.is.URLSearchParams(V) ? V : webidl.converters.DOMString(V, prefix, name);
    };
    webidl.converters.BodyInit = function(V, prefix, argument) {
      return webidl.is.ReadableStream(V) || V?.[Symbol.asyncIterator] ? V : webidl.converters.XMLHttpRequestBodyInit(V, prefix, argument);
    };
    webidl.converters.ResponseInit = webidl.dictionaryConverter([
      {
        key: "status",
        converter: webidl.converters["unsigned short"],
        defaultValue: /* @__PURE__ */ __name(() => 200, "defaultValue")
      },
      {
        key: "statusText",
        converter: webidl.converters.ByteString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      },
      {
        key: "headers",
        converter: webidl.converters.HeadersInit
      }
    ]);
    webidl.is.Response = webidl.util.MakeTypeAssertion(Response);
    module2.exports = {
      isNetworkError,
      makeNetworkError,
      makeResponse,
      makeAppropriateNetworkError,
      filterResponse,
      Response,
      cloneResponse,
      fromInnerResponse,
      getResponseState
    };
  }
});

// lib/web/fetch/request.js
var require_request2 = __commonJS({
  "lib/web/fetch/request.js"(exports2, module2) {
    "use strict";
    var { extractBody, mixinBody, cloneBody, bodyUnusable } = require_body(), { Headers, fill: fillHeaders, HeadersList, setHeadersGuard, getHeadersGuard, setHeadersList, getHeadersList } = require_headers(), util = require_util(), nodeUtil = require("node:util"), {
      isValidHTTPToken,
      sameOrigin,
      environmentSettingsObject
    } = require_util2(), {
      forbiddenMethodsSet,
      corsSafeListedMethodsSet,
      referrerPolicy,
      requestRedirect,
      requestMode,
      requestCredentials,
      requestCache,
      requestDuplex
    } = require_constants3(), { kEnumerableProperty, normalizedMethodRecordsBase, normalizedMethodRecords } = util, { webidl } = require_webidl(), { URLSerializer } = require_data_url(), { kConstruct } = require_symbols(), assert = require("node:assert"), { getMaxListeners, setMaxListeners, defaultMaxListeners } = require("node:events"), kAbortController = Symbol("abortController"), requestFinalizer = new FinalizationRegistry(({ signal, abort }) => {
      signal.removeEventListener("abort", abort);
    }), dependentControllerMap = /* @__PURE__ */ new WeakMap(), abortSignalHasEventHandlerLeakWarning;
    try {
      abortSignalHasEventHandlerLeakWarning = getMaxListeners(new AbortController().signal) > 0;
    } catch {
      abortSignalHasEventHandlerLeakWarning = !1;
    }
    function buildAbort(acRef) {
      return abort;
      function abort() {
        let ac = acRef.deref();
        if (ac !== void 0) {
          requestFinalizer.unregister(abort), this.removeEventListener("abort", abort), ac.abort(this.reason);
          let controllerList = dependentControllerMap.get(ac.signal);
          if (controllerList !== void 0) {
            if (controllerList.size !== 0) {
              for (let ref of controllerList) {
                let ctrl = ref.deref();
                ctrl !== void 0 && ctrl.abort(this.reason);
              }
              controllerList.clear();
            }
            dependentControllerMap.delete(ac.signal);
          }
        }
      }
    }
    __name(buildAbort, "buildAbort");
    var patchMethodWarning = !1, Request = class _Request {
      static {
        __name(this, "Request");
      }
      /** @type {AbortSignal} */
      #signal;
      /** @type {import('../../dispatcher/dispatcher')} */
      #dispatcher;
      /** @type {Headers} */
      #headers;
      #state;
      // https://fetch.spec.whatwg.org/#dom-request
      constructor(input, init = void 0) {
        if (webidl.util.markAsUncloneable(this), input === kConstruct)
          return;
        webidl.argumentLengthCheck(arguments, 1, "Request constructor"), input = webidl.converters.RequestInfo(input), init = webidl.converters.RequestInit(init);
        let request = null, fallbackMode = null, baseUrl = environmentSettingsObject.settingsObject.baseUrl, signal = null;
        if (typeof input == "string") {
          this.#dispatcher = init.dispatcher;
          let parsedURL;
          try {
            parsedURL = new URL(input, baseUrl);
          } catch (err) {
            throw new TypeError("Failed to parse URL from " + input, { cause: err });
          }
          if (parsedURL.username || parsedURL.password)
            throw new TypeError(
              "Request cannot be constructed from a URL that includes credentials: " + input
            );
          request = makeRequest({ urlList: [parsedURL] }), fallbackMode = "cors";
        } else
          assert(webidl.is.Request(input)), request = input.#state, signal = input.#signal, this.#dispatcher = init.dispatcher || input.#dispatcher;
        let origin = environmentSettingsObject.settingsObject.origin, window = "client";
        if (request.window?.constructor?.name === "EnvironmentSettingsObject" && sameOrigin(request.window, origin) && (window = request.window), init.window != null)
          throw new TypeError(`'window' option '${window}' must be null`);
        "window" in init && (window = "no-window"), request = makeRequest({
          // URL request?s URL.
          // undici implementation note: this is set as the first item in request's urlList in makeRequest
          // method request?s method.
          method: request.method,
          // header list A copy of request?s header list.
          // undici implementation note: headersList is cloned in makeRequest
          headersList: request.headersList,
          // unsafe-request flag Set.
          unsafeRequest: request.unsafeRequest,
          // client This?s relevant settings object.
          client: environmentSettingsObject.settingsObject,
          // window window.
          window,
          // priority request?s priority.
          priority: request.priority,
          // origin request?s origin. The propagation of the origin is only significant for navigation requests
          // being handled by a service worker. In this scenario a request can have an origin that is different
          // from the current client.
          origin: request.origin,
          // referrer request?s referrer.
          referrer: request.referrer,
          // referrer policy request?s referrer policy.
          referrerPolicy: request.referrerPolicy,
          // mode request?s mode.
          mode: request.mode,
          // credentials mode request?s credentials mode.
          credentials: request.credentials,
          // cache mode request?s cache mode.
          cache: request.cache,
          // redirect mode request?s redirect mode.
          redirect: request.redirect,
          // integrity metadata request?s integrity metadata.
          integrity: request.integrity,
          // keepalive request?s keepalive.
          keepalive: request.keepalive,
          // reload-navigation flag request?s reload-navigation flag.
          reloadNavigation: request.reloadNavigation,
          // history-navigation flag request?s history-navigation flag.
          historyNavigation: request.historyNavigation,
          // URL list A clone of request?s URL list.
          urlList: [...request.urlList]
        });
        let initHasKey = Object.keys(init).length !== 0;
        if (initHasKey && (request.mode === "navigate" && (request.mode = "same-origin"), request.reloadNavigation = !1, request.historyNavigation = !1, request.origin = "client", request.referrer = "client", request.referrerPolicy = "", request.url = request.urlList[request.urlList.length - 1], request.urlList = [request.url]), init.referrer !== void 0) {
          let referrer = init.referrer;
          if (referrer === "")
            request.referrer = "no-referrer";
          else {
            let parsedReferrer;
            try {
              parsedReferrer = new URL(referrer, baseUrl);
            } catch (err) {
              throw new TypeError(`Referrer "${referrer}" is not a valid URL.`, { cause: err });
            }
            parsedReferrer.protocol === "about:" && parsedReferrer.hostname === "client" || origin && !sameOrigin(parsedReferrer, environmentSettingsObject.settingsObject.baseUrl) ? request.referrer = "client" : request.referrer = parsedReferrer;
          }
        }
        init.referrerPolicy !== void 0 && (request.referrerPolicy = init.referrerPolicy);
        let mode;
        if (init.mode !== void 0 ? mode = init.mode : mode = fallbackMode, mode === "navigate")
          throw webidl.errors.exception({
            header: "Request constructor",
            message: "invalid request mode navigate."
          });
        if (mode != null && (request.mode = mode), init.credentials !== void 0 && (request.credentials = init.credentials), init.cache !== void 0 && (request.cache = init.cache), request.cache === "only-if-cached" && request.mode !== "same-origin")
          throw new TypeError(
            "'only-if-cached' can be set only with 'same-origin' mode"
          );
        if (init.redirect !== void 0 && (request.redirect = init.redirect), init.integrity != null && (request.integrity = String(init.integrity)), init.keepalive !== void 0 && (request.keepalive = !!init.keepalive), init.method !== void 0) {
          let method = init.method, mayBeNormalized = normalizedMethodRecords[method];
          if (mayBeNormalized !== void 0)
            request.method = mayBeNormalized;
          else {
            if (!isValidHTTPToken(method))
              throw new TypeError(`'${method}' is not a valid HTTP method.`);
            let upperCase = method.toUpperCase();
            if (forbiddenMethodsSet.has(upperCase))
              throw new TypeError(`'${method}' HTTP method is unsupported.`);
            method = normalizedMethodRecordsBase[upperCase] ?? method, request.method = method;
          }
          !patchMethodWarning && request.method === "patch" && (process.emitWarning("Using `patch` is highly likely to result in a `405 Method Not Allowed`. `PATCH` is much more likely to succeed.", {
            code: "UNDICI-FETCH-patch"
          }), patchMethodWarning = !0);
        }
        init.signal !== void 0 && (signal = init.signal), this.#state = request;
        let ac = new AbortController();
        if (this.#signal = ac.signal, signal != null)
          if (signal.aborted)
            ac.abort(signal.reason);
          else {
            this[kAbortController] = ac;
            let acRef = new WeakRef(ac), abort = buildAbort(acRef);
            abortSignalHasEventHandlerLeakWarning && getMaxListeners(signal) === defaultMaxListeners && setMaxListeners(1500, signal), util.addAbortListener(signal, abort), requestFinalizer.register(ac, { signal, abort }, abort);
          }
        if (this.#headers = new Headers(kConstruct), setHeadersList(this.#headers, request.headersList), setHeadersGuard(this.#headers, "request"), mode === "no-cors") {
          if (!corsSafeListedMethodsSet.has(request.method))
            throw new TypeError(
              `'${request.method} is unsupported in no-cors mode.`
            );
          setHeadersGuard(this.#headers, "request-no-cors");
        }
        if (initHasKey) {
          let headersList = getHeadersList(this.#headers), headers = init.headers !== void 0 ? init.headers : new HeadersList(headersList);
          if (headersList.clear(), headers instanceof HeadersList) {
            for (let { name, value } of headers.rawValues())
              headersList.append(name, value, !1);
            headersList.cookies = headers.cookies;
          } else
            fillHeaders(this.#headers, headers);
        }
        let inputBody = webidl.is.Request(input) ? input.#state.body : null;
        if ((init.body != null || inputBody != null) && (request.method === "GET" || request.method === "HEAD"))
          throw new TypeError("Request with GET/HEAD method cannot have body.");
        let initBody = null;
        if (init.body != null) {
          let [extractedBody, contentType] = extractBody(
            init.body,
            request.keepalive
          );
          initBody = extractedBody, contentType && !getHeadersList(this.#headers).contains("content-type", !0) && this.#headers.append("content-type", contentType, !0);
        }
        let inputOrInitBody = initBody ?? inputBody;
        if (inputOrInitBody != null && inputOrInitBody.source == null) {
          if (initBody != null && init.duplex == null)
            throw new TypeError("RequestInit: duplex option is required when sending a body.");
          if (request.mode !== "same-origin" && request.mode !== "cors")
            throw new TypeError(
              'If request is made from ReadableStream, mode should be "same-origin" or "cors"'
            );
          request.useCORSPreflightFlag = !0;
        }
        let finalBody = inputOrInitBody;
        if (initBody == null && inputBody != null) {
          if (bodyUnusable(input.#state))
            throw new TypeError(
              "Cannot construct a Request with a Request object that has already been used."
            );
          let identityTransform = new TransformStream();
          inputBody.stream.pipeThrough(identityTransform), finalBody = {
            source: inputBody.source,
            length: inputBody.length,
            stream: identityTransform.readable
          };
        }
        this.#state.body = finalBody;
      }
      // Returns request?s HTTP method, which is "GET" by default.
      get method() {
        return webidl.brandCheck(this, _Request), this.#state.method;
      }
      // Returns the URL of request as a string.
      get url() {
        return webidl.brandCheck(this, _Request), URLSerializer(this.#state.url);
      }
      // Returns a Headers object consisting of the headers associated with request.
      // Note that headers added in the network layer by the user agent will not
      // be accounted for in this object, e.g., the "Host" header.
      get headers() {
        return webidl.brandCheck(this, _Request), this.#headers;
      }
      // Returns the kind of resource requested by request, e.g., "document"
      // or "script".
      get destination() {
        return webidl.brandCheck(this, _Request), this.#state.destination;
      }
      // Returns the referrer of request. Its value can be a same-origin URL if
      // explicitly set in init, the empty string to indicate no referrer, and
      // "about:client" when defaulting to the global?s default. This is used
      // during fetching to determine the value of the `Referer` header of the
      // request being made.
      get referrer() {
        return webidl.brandCheck(this, _Request), this.#state.referrer === "no-referrer" ? "" : this.#state.referrer === "client" ? "about:client" : this.#state.referrer.toString();
      }
      // Returns the referrer policy associated with request.
      // This is used during fetching to compute the value of the request?s
      // referrer.
      get referrerPolicy() {
        return webidl.brandCheck(this, _Request), this.#state.referrerPolicy;
      }
      // Returns the mode associated with request, which is a string indicating
      // whether the request will use CORS, or will be restricted to same-origin
      // URLs.
      get mode() {
        return webidl.brandCheck(this, _Request), this.#state.mode;
      }
      // Returns the credentials mode associated with request,
      // which is a string indicating whether credentials will be sent with the
      // request always, never, or only when sent to a same-origin URL.
      get credentials() {
        return webidl.brandCheck(this, _Request), this.#state.credentials;
      }
      // Returns the cache mode associated with request,
      // which is a string indicating how the request will
      // interact with the browser?s cache when fetching.
      get cache() {
        return webidl.brandCheck(this, _Request), this.#state.cache;
      }
      // Returns the redirect mode associated with request,
      // which is a string indicating how redirects for the
      // request will be handled during fetching. A request
      // will follow redirects by default.
      get redirect() {
        return webidl.brandCheck(this, _Request), this.#state.redirect;
      }
      // Returns request?s subresource integrity metadata, which is a
      // cryptographic hash of the resource being fetched. Its value
      // consists of multiple hashes separated by whitespace. [SRI]
      get integrity() {
        return webidl.brandCheck(this, _Request), this.#state.integrity;
      }
      // Returns a boolean indicating whether or not request can outlive the
      // global in which it was created.
      get keepalive() {
        return webidl.brandCheck(this, _Request), this.#state.keepalive;
      }
      // Returns a boolean indicating whether or not request is for a reload
      // navigation.
      get isReloadNavigation() {
        return webidl.brandCheck(this, _Request), this.#state.reloadNavigation;
      }
      // Returns a boolean indicating whether or not request is for a history
      // navigation (a.k.a. back-forward navigation).
      get isHistoryNavigation() {
        return webidl.brandCheck(this, _Request), this.#state.historyNavigation;
      }
      // Returns the signal associated with request, which is an AbortSignal
      // object indicating whether or not request has been aborted, and its
      // abort event handler.
      get signal() {
        return webidl.brandCheck(this, _Request), this.#signal;
      }
      get body() {
        return webidl.brandCheck(this, _Request), this.#state.body ? this.#state.body.stream : null;
      }
      get bodyUsed() {
        return webidl.brandCheck(this, _Request), !!this.#state.body && util.isDisturbed(this.#state.body.stream);
      }
      get duplex() {
        return webidl.brandCheck(this, _Request), "half";
      }
      // Returns a clone of request.
      clone() {
        if (webidl.brandCheck(this, _Request), bodyUnusable(this.#state))
          throw new TypeError("unusable");
        let clonedRequest = cloneRequest(this.#state), ac = new AbortController();
        if (this.signal.aborted)
          ac.abort(this.signal.reason);
        else {
          let list = dependentControllerMap.get(this.signal);
          list === void 0 && (list = /* @__PURE__ */ new Set(), dependentControllerMap.set(this.signal, list));
          let acRef = new WeakRef(ac);
          list.add(acRef), util.addAbortListener(
            ac.signal,
            buildAbort(acRef)
          );
        }
        return fromInnerRequest(clonedRequest, this.#dispatcher, ac.signal, getHeadersGuard(this.#headers));
      }
      [nodeUtil.inspect.custom](depth, options) {
        options.depth === null && (options.depth = 2), options.colors ??= !0;
        let properties = {
          method: this.method,
          url: this.url,
          headers: this.headers,
          destination: this.destination,
          referrer: this.referrer,
          referrerPolicy: this.referrerPolicy,
          mode: this.mode,
          credentials: this.credentials,
          cache: this.cache,
          redirect: this.redirect,
          integrity: this.integrity,
          keepalive: this.keepalive,
          isReloadNavigation: this.isReloadNavigation,
          isHistoryNavigation: this.isHistoryNavigation,
          signal: this.signal
        };
        return `Request ${nodeUtil.formatWithOptions(options, properties)}`;
      }
      /**
       * @param {Request} request
       * @param {AbortSignal} newSignal
       */
      static setRequestSignal(request, newSignal) {
        return request.#signal = newSignal, request;
      }
      /**
       * @param {Request} request
       */
      static getRequestDispatcher(request) {
        return request.#dispatcher;
      }
      /**
       * @param {Request} request
       * @param {import('../../dispatcher/dispatcher')} newDispatcher
       */
      static setRequestDispatcher(request, newDispatcher) {
        request.#dispatcher = newDispatcher;
      }
      /**
       * @param {Request} request
       * @param {Headers} newHeaders
       */
      static setRequestHeaders(request, newHeaders) {
        request.#headers = newHeaders;
      }
      /**
       * @param {Request} request
       */
      static getRequestState(request) {
        return request.#state;
      }
      /**
       * @param {Request} request
       * @param {any} newState
       */
      static setRequestState(request, newState) {
        request.#state = newState;
      }
    }, { setRequestSignal, getRequestDispatcher, setRequestDispatcher, setRequestHeaders, getRequestState, setRequestState } = Request;
    Reflect.deleteProperty(Request, "setRequestSignal");
    Reflect.deleteProperty(Request, "getRequestDispatcher");
    Reflect.deleteProperty(Request, "setRequestDispatcher");
    Reflect.deleteProperty(Request, "setRequestHeaders");
    Reflect.deleteProperty(Request, "getRequestState");
    Reflect.deleteProperty(Request, "setRequestState");
    mixinBody(Request, getRequestState);
    function makeRequest(init) {
      return {
        method: init.method ?? "GET",
        localURLsOnly: init.localURLsOnly ?? !1,
        unsafeRequest: init.unsafeRequest ?? !1,
        body: init.body ?? null,
        client: init.client ?? null,
        reservedClient: init.reservedClient ?? null,
        replacesClientId: init.replacesClientId ?? "",
        window: init.window ?? "client",
        keepalive: init.keepalive ?? !1,
        serviceWorkers: init.serviceWorkers ?? "all",
        initiator: init.initiator ?? "",
        destination: init.destination ?? "",
        priority: init.priority ?? null,
        origin: init.origin ?? "client",
        policyContainer: init.policyContainer ?? "client",
        referrer: init.referrer ?? "client",
        referrerPolicy: init.referrerPolicy ?? "",
        mode: init.mode ?? "no-cors",
        useCORSPreflightFlag: init.useCORSPreflightFlag ?? !1,
        credentials: init.credentials ?? "same-origin",
        useCredentials: init.useCredentials ?? !1,
        cache: init.cache ?? "default",
        redirect: init.redirect ?? "follow",
        integrity: init.integrity ?? "",
        cryptoGraphicsNonceMetadata: init.cryptoGraphicsNonceMetadata ?? "",
        parserMetadata: init.parserMetadata ?? "",
        reloadNavigation: init.reloadNavigation ?? !1,
        historyNavigation: init.historyNavigation ?? !1,
        userActivation: init.userActivation ?? !1,
        taintedOrigin: init.taintedOrigin ?? !1,
        redirectCount: init.redirectCount ?? 0,
        responseTainting: init.responseTainting ?? "basic",
        preventNoCacheCacheControlHeaderModification: init.preventNoCacheCacheControlHeaderModification ?? !1,
        done: init.done ?? !1,
        timingAllowFailed: init.timingAllowFailed ?? !1,
        urlList: init.urlList,
        url: init.urlList[0],
        headersList: init.headersList ? new HeadersList(init.headersList) : new HeadersList()
      };
    }
    __name(makeRequest, "makeRequest");
    function cloneRequest(request) {
      let newRequest = makeRequest({ ...request, body: null });
      return request.body != null && (newRequest.body = cloneBody(request.body)), newRequest;
    }
    __name(cloneRequest, "cloneRequest");
    function fromInnerRequest(innerRequest, dispatcher, signal, guard) {
      let request = new Request(kConstruct);
      setRequestState(request, innerRequest), setRequestDispatcher(request, dispatcher), setRequestSignal(request, signal);
      let headers = new Headers(kConstruct);
      return setRequestHeaders(request, headers), setHeadersList(headers, innerRequest.headersList), setHeadersGuard(headers, guard), request;
    }
    __name(fromInnerRequest, "fromInnerRequest");
    Object.defineProperties(Request.prototype, {
      method: kEnumerableProperty,
      url: kEnumerableProperty,
      headers: kEnumerableProperty,
      redirect: kEnumerableProperty,
      clone: kEnumerableProperty,
      signal: kEnumerableProperty,
      duplex: kEnumerableProperty,
      destination: kEnumerableProperty,
      body: kEnumerableProperty,
      bodyUsed: kEnumerableProperty,
      isHistoryNavigation: kEnumerableProperty,
      isReloadNavigation: kEnumerableProperty,
      keepalive: kEnumerableProperty,
      integrity: kEnumerableProperty,
      cache: kEnumerableProperty,
      credentials: kEnumerableProperty,
      attribute: kEnumerableProperty,
      referrerPolicy: kEnumerableProperty,
      referrer: kEnumerableProperty,
      mode: kEnumerableProperty,
      [Symbol.toStringTag]: {
        value: "Request",
        configurable: !0
      }
    });
    webidl.is.Request = webidl.util.MakeTypeAssertion(Request);
    webidl.converters.RequestInfo = function(V) {
      return typeof V == "string" ? webidl.converters.USVString(V) : webidl.is.Request(V) ? V : webidl.converters.USVString(V);
    };
    webidl.converters.RequestInit = webidl.dictionaryConverter([
      {
        key: "method",
        converter: webidl.converters.ByteString
      },
      {
        key: "headers",
        converter: webidl.converters.HeadersInit
      },
      {
        key: "body",
        converter: webidl.nullableConverter(
          webidl.converters.BodyInit
        )
      },
      {
        key: "referrer",
        converter: webidl.converters.USVString
      },
      {
        key: "referrerPolicy",
        converter: webidl.converters.DOMString,
        // https://w3c.github.io/webappsec-referrer-policy/#referrer-policy
        allowedValues: referrerPolicy
      },
      {
        key: "mode",
        converter: webidl.converters.DOMString,
        // https://fetch.spec.whatwg.org/#concept-request-mode
        allowedValues: requestMode
      },
      {
        key: "credentials",
        converter: webidl.converters.DOMString,
        // https://fetch.spec.whatwg.org/#requestcredentials
        allowedValues: requestCredentials
      },
      {
        key: "cache",
        converter: webidl.converters.DOMString,
        // https://fetch.spec.whatwg.org/#requestcache
        allowedValues: requestCache
      },
      {
        key: "redirect",
        converter: webidl.converters.DOMString,
        // https://fetch.spec.whatwg.org/#requestredirect
        allowedValues: requestRedirect
      },
      {
        key: "integrity",
        converter: webidl.converters.DOMString
      },
      {
        key: "keepalive",
        converter: webidl.converters.boolean
      },
      {
        key: "signal",
        converter: webidl.nullableConverter(
          (signal) => webidl.converters.AbortSignal(
            signal,
            "RequestInit",
            "signal"
          )
        )
      },
      {
        key: "window",
        converter: webidl.converters.any
      },
      {
        key: "duplex",
        converter: webidl.converters.DOMString,
        allowedValues: requestDuplex
      },
      {
        key: "dispatcher",
        // undici specific option
        converter: webidl.converters.any
      },
      {
        key: "priority",
        converter: webidl.converters.DOMString,
        allowedValues: ["high", "low", "auto"],
        defaultValue: /* @__PURE__ */ __name(() => "auto", "defaultValue")
      }
    ]);
    module2.exports = {
      Request,
      makeRequest,
      fromInnerRequest,
      cloneRequest,
      getRequestDispatcher,
      getRequestState
    };
  }
});

// lib/web/subresource-integrity/subresource-integrity.js
var require_subresource_integrity = __commonJS({
  "lib/web/subresource-integrity/subresource-integrity.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { runtimeFeatures } = require_runtime_features(), validSRIHashAlgorithmTokenSet = /* @__PURE__ */ new Map([["sha256", 0], ["sha384", 1], ["sha512", 2]]), crypto;
    if (runtimeFeatures.has("crypto")) {
      crypto = require("node:crypto");
      let cryptoHashes = crypto.getHashes();
      cryptoHashes.length === 0 && validSRIHashAlgorithmTokenSet.clear();
      for (let algorithm of validSRIHashAlgorithmTokenSet.keys())
        cryptoHashes.includes(algorithm) === !1 && validSRIHashAlgorithmTokenSet.delete(algorithm);
    } else
      validSRIHashAlgorithmTokenSet.clear();
    var getSRIHashAlgorithmIndex = (
      /** @type {GetSRIHashAlgorithmIndex} */
      Map.prototype.get.bind(
        validSRIHashAlgorithmTokenSet
      )
    ), isValidSRIHashAlgorithm = (
      /** @type {IsValidSRIHashAlgorithm} */
      Map.prototype.has.bind(validSRIHashAlgorithmTokenSet)
    ), bytesMatch = runtimeFeatures.has("crypto") === !1 || validSRIHashAlgorithmTokenSet.size === 0 ? () => !0 : (bytes, metadataList) => {
      let parsedMetadata = parseMetadata(metadataList);
      if (parsedMetadata.length === 0)
        return !0;
      let metadata = getStrongestMetadata(parsedMetadata);
      for (let item of metadata) {
        let algorithm = item.alg, expectedValue = item.val, actualValue = applyAlgorithmToBytes(algorithm, bytes);
        if (caseSensitiveMatch(actualValue, expectedValue))
          return !0;
      }
      return !1;
    };
    function getStrongestMetadata(metadataList) {
      let result = [], strongest = null;
      for (let item of metadataList) {
        if (assert(isValidSRIHashAlgorithm(item.alg), "Invalid SRI hash algorithm token"), result.length === 0) {
          result.push(item), strongest = item;
          continue;
        }
        let currentAlgorithm = (
          /** @type {Metadata} */
          strongest.alg
        ), currentAlgorithmIndex = getSRIHashAlgorithmIndex(currentAlgorithm), newAlgorithm = item.alg, newAlgorithmIndex = getSRIHashAlgorithmIndex(newAlgorithm);
        newAlgorithmIndex < currentAlgorithmIndex || (newAlgorithmIndex > currentAlgorithmIndex ? (strongest = item, result[0] = item, result.length = 1) : result.push(item));
      }
      return result;
    }
    __name(getStrongestMetadata, "getStrongestMetadata");
    function parseMetadata(metadata) {
      let result = [];
      for (let item of metadata.split(" ")) {
        let algorithmExpression = item.split("?", 1)[0], base64Value = "", algorithmAndValue = [algorithmExpression.slice(0, 6), algorithmExpression.slice(7)], algorithm = algorithmAndValue[0];
        if (!isValidSRIHashAlgorithm(algorithm))
          continue;
        algorithmAndValue[1] && (base64Value = algorithmAndValue[1]);
        let metadata2 = {
          alg: algorithm,
          val: base64Value
        };
        result.push(metadata2);
      }
      return result;
    }
    __name(parseMetadata, "parseMetadata");
    var applyAlgorithmToBytes = /* @__PURE__ */ __name((algorithm, bytes) => crypto.hash(algorithm, bytes, "base64"), "applyAlgorithmToBytes");
    function caseSensitiveMatch(actualValue, expectedValue) {
      let actualValueLength = actualValue.length;
      actualValueLength !== 0 && actualValue[actualValueLength - 1] === "=" && (actualValueLength -= 1), actualValueLength !== 0 && actualValue[actualValueLength - 1] === "=" && (actualValueLength -= 1);
      let expectedValueLength = expectedValue.length;
      if (expectedValueLength !== 0 && expectedValue[expectedValueLength - 1] === "=" && (expectedValueLength -= 1), expectedValueLength !== 0 && expectedValue[expectedValueLength - 1] === "=" && (expectedValueLength -= 1), actualValueLength !== expectedValueLength)
        return !1;
      for (let i = 0; i < actualValueLength; ++i)
        if (!(actualValue[i] === expectedValue[i] || actualValue[i] === "+" && expectedValue[i] === "-" || actualValue[i] === "/" && expectedValue[i] === "_"))
          return !1;
      return !0;
    }
    __name(caseSensitiveMatch, "caseSensitiveMatch");
    module2.exports = {
      applyAlgorithmToBytes,
      bytesMatch,
      caseSensitiveMatch,
      isValidSRIHashAlgorithm,
      getStrongestMetadata,
      parseMetadata
    };
  }
});

// lib/web/fetch/index.js
var require_fetch = __commonJS({
  "lib/web/fetch/index.js"(exports2, module2) {
    "use strict";
    var {
      makeNetworkError,
      makeAppropriateNetworkError,
      filterResponse,
      makeResponse,
      fromInnerResponse,
      getResponseState
    } = require_response(), { HeadersList } = require_headers(), { Request, cloneRequest, getRequestDispatcher, getRequestState } = require_request2(), zlib = require("node:zlib"), {
      makePolicyContainer,
      clonePolicyContainer,
      requestBadPort,
      TAOCheck,
      appendRequestOriginHeader,
      responseLocationURL,
      requestCurrentURL,
      setRequestReferrerPolicyOnRedirect,
      tryUpgradeRequestToAPotentiallyTrustworthyURL,
      createOpaqueTimingInfo,
      appendFetchMetadata,
      corsCheck,
      crossOriginResourcePolicyCheck,
      determineRequestsReferrer,
      coarsenedSharedCurrentTime,
      sameOrigin,
      isCancelled,
      isAborted,
      isErrorLike,
      fullyReadBody,
      readableStreamClose,
      urlIsLocal,
      urlIsHttpHttpsScheme,
      urlHasHttpsScheme,
      clampAndCoarsenConnectionTimingInfo,
      simpleRangeHeaderValue,
      buildContentRange,
      createInflate,
      extractMimeType
    } = require_util2(), assert = require("node:assert"), { safelyExtractBody, extractBody } = require_body(), {
      redirectStatusSet,
      nullBodyStatus,
      safeMethodsSet,
      requestBodyHeader,
      subresourceSet
    } = require_constants3(), EE = require("node:events"), { Readable, pipeline, finished, isErrored, isReadable } = require("node:stream"), { addAbortListener, bufferToLowerCasedHeaderName } = require_util(), { dataURLProcessor, serializeAMimeType, minimizeSupportedMimeType } = require_data_url(), { getGlobalDispatcher: getGlobalDispatcher2 } = require_global2(), { webidl } = require_webidl(), { STATUS_CODES } = require("node:http"), { bytesMatch } = require_subresource_integrity(), { createDeferredPromise } = require_promise(), { isomorphicEncode } = require_infra(), { runtimeFeatures } = require_runtime_features(), hasZstd = runtimeFeatures.has("zstd"), GET_OR_HEAD = ["GET", "HEAD"], defaultUserAgent = (typeof __UNDICI_IS_NODE__ < "u", "node"), resolveObjectURL, Fetch = class extends EE {
      static {
        __name(this, "Fetch");
      }
      constructor(dispatcher) {
        super(), this.dispatcher = dispatcher, this.connection = null, this.dump = !1, this.state = "ongoing";
      }
      terminate(reason) {
        this.state === "ongoing" && (this.state = "terminated", this.connection?.destroy(reason), this.emit("terminated", reason));
      }
      // https://fetch.spec.whatwg.org/#fetch-controller-abort
      abort(error) {
        this.state === "ongoing" && (this.state = "aborted", error || (error = new DOMException("The operation was aborted.", "AbortError")), this.serializedAbortReason = error, this.connection?.destroy(error), this.emit("terminated", error));
      }
    };
    function handleFetchDone(response) {
      finalizeAndReportTiming(response, "fetch");
    }
    __name(handleFetchDone, "handleFetchDone");
    function fetch2(input, init = void 0) {
      webidl.argumentLengthCheck(arguments, 1, "globalThis.fetch");
      let p = createDeferredPromise(), requestObject;
      try {
        requestObject = new Request(input, init);
      } catch (e) {
        return p.reject(e), p.promise;
      }
      let request = getRequestState(requestObject);
      if (requestObject.signal.aborted)
        return abortFetch(p, request, null, requestObject.signal.reason), p.promise;
      request.client.globalObject?.constructor?.name === "ServiceWorkerGlobalScope" && (request.serviceWorkers = "none");
      let responseObject = null, locallyAborted = !1, controller = null;
      return addAbortListener(
        requestObject.signal,
        () => {
          locallyAborted = !0, assert(controller != null), controller.abort(requestObject.signal.reason);
          let realResponse = responseObject?.deref();
          abortFetch(p, request, realResponse, requestObject.signal.reason);
        }
      ), controller = fetching({
        request,
        processResponseEndOfBody: handleFetchDone,
        processResponse: /* @__PURE__ */ __name((response) => {
          if (locallyAborted)
            return;
          if (response.aborted) {
            abortFetch(p, request, responseObject, controller.serializedAbortReason);
            return;
          }
          if (response.type === "error") {
            p.reject(new TypeError("fetch failed", { cause: response.error }));
            return;
          }
          let responseValue = fromInnerResponse(response, "immutable");
          responseObject = new WeakRef(responseValue), p.resolve(responseValue), p = null;
        }, "processResponse"),
        dispatcher: getRequestDispatcher(requestObject)
        // undici
      }), p.promise;
    }
    __name(fetch2, "fetch");
    function finalizeAndReportTiming(response, initiatorType = "other") {
      if (response.type === "error" && response.aborted || !response.urlList?.length)
        return;
      let originalURL = response.urlList[0], timingInfo = response.timingInfo, cacheState = response.cacheState;
      urlIsHttpHttpsScheme(originalURL) && timingInfo !== null && (response.timingAllowPassed || (timingInfo = createOpaqueTimingInfo({
        startTime: timingInfo.startTime
      }), cacheState = ""), timingInfo.endTime = coarsenedSharedCurrentTime(), response.timingInfo = timingInfo, markResourceTiming(
        timingInfo,
        originalURL.href,
        initiatorType,
        globalThis,
        cacheState,
        "",
        // bodyType
        response.status
      ));
    }
    __name(finalizeAndReportTiming, "finalizeAndReportTiming");
    var markResourceTiming = performance.markResourceTiming;
    function abortFetch(p, request, responseObject, error) {
      if (p && p.reject(error), request.body?.stream != null && isReadable(request.body.stream) && request.body.stream.cancel(error).catch((err) => {
        if (err.code !== "ERR_INVALID_STATE")
          throw err;
      }), responseObject == null)
        return;
      let response = getResponseState(responseObject);
      response.body?.stream != null && isReadable(response.body.stream) && response.body.stream.cancel(error).catch((err) => {
        if (err.code !== "ERR_INVALID_STATE")
          throw err;
      });
    }
    __name(abortFetch, "abortFetch");
    function fetching({
      request,
      processRequestBodyChunkLength,
      processRequestEndOfBody,
      processResponse,
      processResponseEndOfBody,
      processResponseConsumeBody,
      useParallelQueue = !1,
      dispatcher = getGlobalDispatcher2()
      // undici
    }) {
      assert(dispatcher);
      let taskDestination = null, crossOriginIsolatedCapability = !1;
      request.client != null && (taskDestination = request.client.globalObject, crossOriginIsolatedCapability = request.client.crossOriginIsolatedCapability);
      let currentTime = coarsenedSharedCurrentTime(crossOriginIsolatedCapability), timingInfo = createOpaqueTimingInfo({
        startTime: currentTime
      }), fetchParams = {
        controller: new Fetch(dispatcher),
        request,
        timingInfo,
        processRequestBodyChunkLength,
        processRequestEndOfBody,
        processResponse,
        processResponseConsumeBody,
        processResponseEndOfBody,
        taskDestination,
        crossOriginIsolatedCapability
      };
      return assert(!request.body || request.body.stream), request.window === "client" && (request.window = request.client?.globalObject?.constructor?.name === "Window" ? request.client : "no-window"), request.origin === "client" && (request.origin = request.client.origin), request.policyContainer === "client" && (request.client != null ? request.policyContainer = clonePolicyContainer(
        request.client.policyContainer
      ) : request.policyContainer = makePolicyContainer()), request.headersList.contains("accept", !0) || request.headersList.append("accept", "*/*", !0), request.headersList.contains("accept-language", !0) || request.headersList.append("accept-language", "*", !0), request.priority, subresourceSet.has(request.destination), mainFetch(fetchParams, !1), fetchParams.controller;
    }
    __name(fetching, "fetching");
    async function mainFetch(fetchParams, recursive) {
      try {
        let request = fetchParams.request, response = null;
        if (request.localURLsOnly && !urlIsLocal(requestCurrentURL(request)) && (response = makeNetworkError("local URLs only")), tryUpgradeRequestToAPotentiallyTrustworthyURL(request), requestBadPort(request) === "blocked" && (response = makeNetworkError("bad port")), request.referrerPolicy === "" && (request.referrerPolicy = request.policyContainer.referrerPolicy), request.referrer !== "no-referrer" && (request.referrer = determineRequestsReferrer(request)), response === null) {
          let currentURL = requestCurrentURL(request);
          // - request?s current URL?s origin is same origin with request?s origin,
          //   and request?s response tainting is "basic"
          sameOrigin(currentURL, request.url) && request.responseTainting === "basic" || // request?s current URL?s scheme is "data"
          currentURL.protocol === "data:" || // - request?s mode is "navigate" or "websocket"
          request.mode === "navigate" || request.mode === "websocket" ? (request.responseTainting = "basic", response = await schemeFetch(fetchParams)) : request.mode === "same-origin" ? response = makeNetworkError('request mode cannot be "same-origin"') : request.mode === "no-cors" ? request.redirect !== "follow" ? response = makeNetworkError(
            'redirect mode cannot be "follow" for "no-cors" request'
          ) : (request.responseTainting = "opaque", response = await schemeFetch(fetchParams)) : urlIsHttpHttpsScheme(requestCurrentURL(request)) ? (request.responseTainting = "cors", response = await httpFetch(fetchParams)) : response = makeNetworkError("URL scheme must be a HTTP(S) scheme");
        }
        if (recursive)
          return response;
        response.status !== 0 && !response.internalResponse && (request.responseTainting, request.responseTainting === "basic" ? response = filterResponse(response, "basic") : request.responseTainting === "cors" ? response = filterResponse(response, "cors") : request.responseTainting === "opaque" ? response = filterResponse(response, "opaque") : assert(!1));
        let internalResponse = response.status === 0 ? response : response.internalResponse;
        if (internalResponse.urlList.length === 0 && internalResponse.urlList.push(...request.urlList), request.timingAllowFailed || (response.timingAllowPassed = !0), response.type === "opaque" && internalResponse.status === 206 && internalResponse.rangeRequested && !request.headers.contains("range", !0) && (response = internalResponse = makeNetworkError()), response.status !== 0 && (request.method === "HEAD" || request.method === "CONNECT" || nullBodyStatus.includes(internalResponse.status)) && (internalResponse.body = null, fetchParams.controller.dump = !0), request.integrity) {
          let processBodyError = /* @__PURE__ */ __name((reason) => fetchFinale(fetchParams, makeNetworkError(reason)), "processBodyError");
          if (request.responseTainting === "opaque" || response.body == null) {
            processBodyError(response.error);
            return;
          }
          let processBody = /* @__PURE__ */ __name((bytes) => {
            if (!bytesMatch(bytes, request.integrity)) {
              processBodyError("integrity mismatch");
              return;
            }
            response.body = safelyExtractBody(bytes)[0], fetchFinale(fetchParams, response);
          }, "processBody");
          fullyReadBody(response.body, processBody, processBodyError);
        } else
          fetchFinale(fetchParams, response);
      } catch (err) {
        fetchParams.controller.terminate(err);
      }
    }
    __name(mainFetch, "mainFetch");
    function schemeFetch(fetchParams) {
      if (isCancelled(fetchParams) && fetchParams.request.redirectCount === 0)
        return Promise.resolve(makeAppropriateNetworkError(fetchParams));
      let { request } = fetchParams, { protocol: scheme } = requestCurrentURL(request);
      switch (scheme) {
        case "about:":
          return Promise.resolve(makeNetworkError("about scheme is not supported"));
        case "blob:": {
          resolveObjectURL || (resolveObjectURL = require("node:buffer").resolveObjectURL);
          let blobURLEntry = requestCurrentURL(request);
          if (blobURLEntry.search.length !== 0)
            return Promise.resolve(makeNetworkError("NetworkError when attempting to fetch resource."));
          let blob = resolveObjectURL(blobURLEntry.toString());
          if (request.method !== "GET" || !webidl.is.Blob(blob))
            return Promise.resolve(makeNetworkError("invalid method"));
          let response = makeResponse(), fullLength = blob.size, serializedFullLength = isomorphicEncode(`${fullLength}`), type = blob.type;
          if (request.headersList.contains("range", !0)) {
            response.rangeRequested = !0;
            let rangeHeader = request.headersList.get("range", !0), rangeValue = simpleRangeHeaderValue(rangeHeader, !0);
            if (rangeValue === "failure")
              return Promise.resolve(makeNetworkError("failed to fetch the data URL"));
            let { rangeStartValue: rangeStart, rangeEndValue: rangeEnd } = rangeValue;
            if (rangeStart === null)
              rangeStart = fullLength - rangeEnd, rangeEnd = rangeStart + rangeEnd - 1;
            else {
              if (rangeStart >= fullLength)
                return Promise.resolve(makeNetworkError("Range start is greater than the blob's size."));
              (rangeEnd === null || rangeEnd >= fullLength) && (rangeEnd = fullLength - 1);
            }
            let slicedBlob = blob.slice(rangeStart, rangeEnd + 1, type), slicedBodyWithType = extractBody(slicedBlob);
            response.body = slicedBodyWithType[0];
            let serializedSlicedLength = isomorphicEncode(`${slicedBlob.size}`), contentRange = buildContentRange(rangeStart, rangeEnd, fullLength);
            response.status = 206, response.statusText = "Partial Content", response.headersList.set("content-length", serializedSlicedLength, !0), response.headersList.set("content-type", type, !0), response.headersList.set("content-range", contentRange, !0);
          } else {
            let bodyWithType = extractBody(blob);
            response.statusText = "OK", response.body = bodyWithType[0], response.headersList.set("content-length", serializedFullLength, !0), response.headersList.set("content-type", type, !0);
          }
          return Promise.resolve(response);
        }
        case "data:": {
          let currentURL = requestCurrentURL(request), dataURLStruct = dataURLProcessor(currentURL);
          if (dataURLStruct === "failure")
            return Promise.resolve(makeNetworkError("failed to fetch the data URL"));
          let mimeType = serializeAMimeType(dataURLStruct.mimeType);
          return Promise.resolve(makeResponse({
            statusText: "OK",
            headersList: [
              ["content-type", { name: "Content-Type", value: mimeType }]
            ],
            body: safelyExtractBody(dataURLStruct.body)[0]
          }));
        }
        case "file:":
          return Promise.resolve(makeNetworkError("not implemented... yet..."));
        case "http:":
        case "https:":
          return httpFetch(fetchParams).catch((err) => makeNetworkError(err));
        default:
          return Promise.resolve(makeNetworkError("unknown scheme"));
      }
    }
    __name(schemeFetch, "schemeFetch");
    function finalizeResponse(fetchParams, response) {
      fetchParams.request.done = !0, fetchParams.processResponseDone != null && queueMicrotask(() => fetchParams.processResponseDone(response));
    }
    __name(finalizeResponse, "finalizeResponse");
    function fetchFinale(fetchParams, response) {
      let timingInfo = fetchParams.timingInfo, processResponseEndOfBody = /* @__PURE__ */ __name(() => {
        let unsafeEndTime = Date.now();
        fetchParams.request.destination === "document" && (fetchParams.controller.fullTimingInfo = timingInfo), fetchParams.controller.reportTimingSteps = () => {
          if (!urlIsHttpHttpsScheme(fetchParams.request.url))
            return;
          timingInfo.endTime = unsafeEndTime;
          let cacheState = response.cacheState, bodyInfo = response.bodyInfo;
          response.timingAllowPassed || (timingInfo = createOpaqueTimingInfo(timingInfo), cacheState = "");
          let responseStatus = 0;
          if (fetchParams.request.mode !== "navigator" || !response.hasCrossOriginRedirects) {
            responseStatus = response.status;
            let mimeType = extractMimeType(response.headersList);
            mimeType !== "failure" && (bodyInfo.contentType = minimizeSupportedMimeType(mimeType));
          }
          fetchParams.request.initiatorType != null && markResourceTiming(timingInfo, fetchParams.request.url.href, fetchParams.request.initiatorType, globalThis, cacheState, bodyInfo, responseStatus);
        };
        let processResponseEndOfBodyTask = /* @__PURE__ */ __name(() => {
          fetchParams.request.done = !0, fetchParams.processResponseEndOfBody != null && queueMicrotask(() => fetchParams.processResponseEndOfBody(response)), fetchParams.request.initiatorType != null && fetchParams.controller.reportTimingSteps();
        }, "processResponseEndOfBodyTask");
        queueMicrotask(() => processResponseEndOfBodyTask());
      }, "processResponseEndOfBody");
      fetchParams.processResponse != null && queueMicrotask(() => {
        fetchParams.processResponse(response), fetchParams.processResponse = null;
      });
      let internalResponse = response.type === "error" ? response : response.internalResponse ?? response;
      internalResponse.body == null ? processResponseEndOfBody() : finished(internalResponse.body.stream, () => {
        processResponseEndOfBody();
      });
    }
    __name(fetchFinale, "fetchFinale");
    async function httpFetch(fetchParams) {
      let request = fetchParams.request, response = null, actualResponse = null, timingInfo = fetchParams.timingInfo;
      if (request.serviceWorkers, response === null) {
        if (request.redirect === "follow" && (request.serviceWorkers = "none"), actualResponse = response = await httpNetworkOrCacheFetch(fetchParams), request.responseTainting === "cors" && corsCheck(request, response) === "failure")
          return makeNetworkError("cors failure");
        TAOCheck(request, response) === "failure" && (request.timingAllowFailed = !0);
      }
      return (request.responseTainting === "opaque" || response.type === "opaque") && crossOriginResourcePolicyCheck(
        request.origin,
        request.client,
        request.destination,
        actualResponse
      ) === "blocked" ? makeNetworkError("blocked") : (redirectStatusSet.has(actualResponse.status) && (request.redirect !== "manual" && fetchParams.controller.connection.destroy(void 0, !1), request.redirect === "error" ? response = makeNetworkError("unexpected redirect") : request.redirect === "manual" ? response = actualResponse : request.redirect === "follow" ? response = await httpRedirectFetch(fetchParams, response) : assert(!1)), response.timingInfo = timingInfo, response);
    }
    __name(httpFetch, "httpFetch");
    function httpRedirectFetch(fetchParams, response) {
      let request = fetchParams.request, actualResponse = response.internalResponse ? response.internalResponse : response, locationURL;
      try {
        if (locationURL = responseLocationURL(
          actualResponse,
          requestCurrentURL(request).hash
        ), locationURL == null)
          return response;
      } catch (err) {
        return Promise.resolve(makeNetworkError(err));
      }
      if (!urlIsHttpHttpsScheme(locationURL))
        return Promise.resolve(makeNetworkError("URL scheme must be a HTTP(S) scheme"));
      if (request.redirectCount === 20)
        return Promise.resolve(makeNetworkError("redirect count exceeded"));
      if (request.redirectCount += 1, request.mode === "cors" && (locationURL.username || locationURL.password) && !sameOrigin(request, locationURL))
        return Promise.resolve(makeNetworkError('cross origin not allowed for request mode "cors"'));
      if (request.responseTainting === "cors" && (locationURL.username || locationURL.password))
        return Promise.resolve(makeNetworkError(
          'URL cannot contain credentials for request mode "cors"'
        ));
      if (actualResponse.status !== 303 && request.body != null && request.body.source == null)
        return Promise.resolve(makeNetworkError());
      if ([301, 302].includes(actualResponse.status) && request.method === "POST" || actualResponse.status === 303 && !GET_OR_HEAD.includes(request.method)) {
        request.method = "GET", request.body = null;
        for (let headerName of requestBodyHeader)
          request.headersList.delete(headerName);
      }
      sameOrigin(requestCurrentURL(request), locationURL) || (request.headersList.delete("authorization", !0), request.headersList.delete("proxy-authorization", !0), request.headersList.delete("cookie", !0), request.headersList.delete("host", !0)), request.body != null && (assert(request.body.source != null), request.body = safelyExtractBody(request.body.source)[0]);
      let timingInfo = fetchParams.timingInfo;
      return timingInfo.redirectEndTime = timingInfo.postRedirectStartTime = coarsenedSharedCurrentTime(fetchParams.crossOriginIsolatedCapability), timingInfo.redirectStartTime === 0 && (timingInfo.redirectStartTime = timingInfo.startTime), request.urlList.push(locationURL), setRequestReferrerPolicyOnRedirect(request, actualResponse), mainFetch(fetchParams, !0);
    }
    __name(httpRedirectFetch, "httpRedirectFetch");
    async function httpNetworkOrCacheFetch(fetchParams, isAuthenticationFetch = !1, isNewConnectionFetch = !1) {
      let request = fetchParams.request, httpFetchParams = null, httpRequest = null, response = null, httpCache = null, revalidatingFlag = !1;
      request.window === "no-window" && request.redirect === "error" ? (httpFetchParams = fetchParams, httpRequest = request) : (httpRequest = cloneRequest(request), httpFetchParams = { ...fetchParams }, httpFetchParams.request = httpRequest);
      let includeCredentials = request.credentials === "include" || request.credentials === "same-origin" && request.responseTainting === "basic", contentLength = httpRequest.body ? httpRequest.body.length : null, contentLengthHeaderValue = null;
      if (httpRequest.body == null && ["POST", "PUT"].includes(httpRequest.method) && (contentLengthHeaderValue = "0"), contentLength != null && (contentLengthHeaderValue = isomorphicEncode(`${contentLength}`)), contentLengthHeaderValue != null && httpRequest.headersList.append("content-length", contentLengthHeaderValue, !0), contentLength != null && httpRequest.keepalive, webidl.is.URL(httpRequest.referrer) && httpRequest.headersList.append("referer", isomorphicEncode(httpRequest.referrer.href), !0), appendRequestOriginHeader(httpRequest), appendFetchMetadata(httpRequest), httpRequest.headersList.contains("user-agent", !0) || httpRequest.headersList.append("user-agent", defaultUserAgent, !0), httpRequest.cache === "default" && (httpRequest.headersList.contains("if-modified-since", !0) || httpRequest.headersList.contains("if-none-match", !0) || httpRequest.headersList.contains("if-unmodified-since", !0) || httpRequest.headersList.contains("if-match", !0) || httpRequest.headersList.contains("if-range", !0)) && (httpRequest.cache = "no-store"), httpRequest.cache === "no-cache" && !httpRequest.preventNoCacheCacheControlHeaderModification && !httpRequest.headersList.contains("cache-control", !0) && httpRequest.headersList.append("cache-control", "max-age=0", !0), (httpRequest.cache === "no-store" || httpRequest.cache === "reload") && (httpRequest.headersList.contains("pragma", !0) || httpRequest.headersList.append("pragma", "no-cache", !0), httpRequest.headersList.contains("cache-control", !0) || httpRequest.headersList.append("cache-control", "no-cache", !0)), httpRequest.headersList.contains("range", !0) && httpRequest.headersList.append("accept-encoding", "identity", !0), httpRequest.headersList.contains("accept-encoding", !0) || (urlHasHttpsScheme(requestCurrentURL(httpRequest)) ? httpRequest.headersList.append("accept-encoding", "br, gzip, deflate", !0) : httpRequest.headersList.append("accept-encoding", "gzip, deflate", !0)), httpRequest.headersList.delete("host", !0), httpCache == null && (httpRequest.cache = "no-store"), httpRequest.cache !== "no-store" && httpRequest.cache, response == null) {
        if (httpRequest.cache === "only-if-cached")
          return makeNetworkError("only if cached");
        let forwardResponse = await httpNetworkFetch(
          httpFetchParams,
          includeCredentials,
          isNewConnectionFetch
        );
        !safeMethodsSet.has(httpRequest.method) && forwardResponse.status >= 200 && forwardResponse.status <= 399, revalidatingFlag && forwardResponse.status, response == null && (response = forwardResponse);
      }
      if (response.urlList = [...httpRequest.urlList], httpRequest.headersList.contains("range", !0) && (response.rangeRequested = !0), response.requestIncludesCredentials = includeCredentials, response.status === 407)
        return request.window === "no-window" ? makeNetworkError() : isCancelled(fetchParams) ? makeAppropriateNetworkError(fetchParams) : makeNetworkError("proxy authentication required");
      if (
        // response?s status is 421
        response.status === 421 && // isNewConnectionFetch is false
        !isNewConnectionFetch && // request?s body is null, or request?s body is non-null and request?s body?s source is non-null
        (request.body == null || request.body.source != null)
      ) {
        if (isCancelled(fetchParams))
          return makeAppropriateNetworkError(fetchParams);
        fetchParams.controller.connection.destroy(), response = await httpNetworkOrCacheFetch(
          fetchParams,
          isAuthenticationFetch,
          !0
        );
      }
      return response;
    }
    __name(httpNetworkOrCacheFetch, "httpNetworkOrCacheFetch");
    async function httpNetworkFetch(fetchParams, includeCredentials = !1, forceNewConnection = !1) {
      assert(!fetchParams.controller.connection || fetchParams.controller.connection.destroyed), fetchParams.controller.connection = {
        abort: null,
        destroyed: !1,
        destroy(err, abort = !0) {
          this.destroyed || (this.destroyed = !0, abort && this.abort?.(err ?? new DOMException("The operation was aborted.", "AbortError")));
        }
      };
      let request = fetchParams.request, response = null, timingInfo = fetchParams.timingInfo;
      null == null && (request.cache = "no-store");
      let newConnection = forceNewConnection ? "yes" : "no";
      request.mode;
      let requestBody = null;
      if (request.body == null && fetchParams.processRequestEndOfBody)
        queueMicrotask(() => fetchParams.processRequestEndOfBody());
      else if (request.body != null) {
        let processBodyChunk = /* @__PURE__ */ __name(async function* (bytes) {
          isCancelled(fetchParams) || (yield bytes, fetchParams.processRequestBodyChunkLength?.(bytes.byteLength));
        }, "processBodyChunk"), processEndOfBody = /* @__PURE__ */ __name(() => {
          isCancelled(fetchParams) || fetchParams.processRequestEndOfBody && fetchParams.processRequestEndOfBody();
        }, "processEndOfBody"), processBodyError = /* @__PURE__ */ __name((e) => {
          isCancelled(fetchParams) || (e.name === "AbortError" ? fetchParams.controller.abort() : fetchParams.controller.terminate(e));
        }, "processBodyError");
        requestBody = (async function* () {
          try {
            for await (let bytes of request.body.stream)
              yield* processBodyChunk(bytes);
            processEndOfBody();
          } catch (err) {
            processBodyError(err);
          }
        })();
      }
      try {
        let { body, status, statusText, headersList, socket } = await dispatch({ body: requestBody });
        if (socket)
          response = makeResponse({ status, statusText, headersList, socket });
        else {
          let iterator = body[Symbol.asyncIterator]();
          fetchParams.controller.next = () => iterator.next(), response = makeResponse({ status, statusText, headersList });
        }
      } catch (err) {
        return err.name === "AbortError" ? (fetchParams.controller.connection.destroy(), makeAppropriateNetworkError(fetchParams, err)) : makeNetworkError(err);
      }
      let pullAlgorithm = /* @__PURE__ */ __name(() => fetchParams.controller.resume(), "pullAlgorithm"), cancelAlgorithm = /* @__PURE__ */ __name((reason) => {
        isCancelled(fetchParams) || fetchParams.controller.abort(reason);
      }, "cancelAlgorithm"), stream = new ReadableStream(
        {
          start(controller) {
            fetchParams.controller.controller = controller;
          },
          pull: pullAlgorithm,
          cancel: cancelAlgorithm,
          type: "bytes"
        }
      );
      response.body = { stream, source: null, length: null }, fetchParams.controller.resume || fetchParams.controller.on("terminated", onAborted), fetchParams.controller.resume = async () => {
        for (; ; ) {
          let bytes, isFailure;
          try {
            let { done, value } = await fetchParams.controller.next();
            if (isAborted(fetchParams))
              break;
            bytes = done ? void 0 : value;
          } catch (err) {
            fetchParams.controller.ended && !timingInfo.encodedBodySize ? bytes = void 0 : (bytes = err, isFailure = !0);
          }
          if (bytes === void 0) {
            readableStreamClose(fetchParams.controller.controller), finalizeResponse(fetchParams, response);
            return;
          }
          if (timingInfo.decodedBodySize += bytes?.byteLength ?? 0, isFailure) {
            fetchParams.controller.terminate(bytes);
            return;
          }
          let buffer = new Uint8Array(bytes);
          if (buffer.byteLength && fetchParams.controller.controller.enqueue(buffer), isErrored(stream)) {
            fetchParams.controller.terminate();
            return;
          }
          if (fetchParams.controller.controller.desiredSize <= 0)
            return;
        }
      };
      function onAborted(reason) {
        isAborted(fetchParams) ? (response.aborted = !0, isReadable(stream) && fetchParams.controller.controller.error(
          fetchParams.controller.serializedAbortReason
        )) : isReadable(stream) && fetchParams.controller.controller.error(new TypeError("terminated", {
          cause: isErrorLike(reason) ? reason : void 0
        })), fetchParams.controller.connection.destroy();
      }
      return __name(onAborted, "onAborted"), response;
      function dispatch({ body }) {
        let url = requestCurrentURL(request), agent = fetchParams.controller.dispatcher;
        return new Promise((resolve, reject) => agent.dispatch(
          {
            path: url.pathname + url.search,
            origin: url.origin,
            method: request.method,
            body: agent.isMockActive ? request.body && (request.body.source || request.body.stream) : body,
            headers: request.headersList.entries,
            maxRedirections: 0,
            upgrade: request.mode === "websocket" ? "websocket" : void 0
          },
          {
            body: null,
            abort: null,
            onConnect(abort) {
              let { connection } = fetchParams.controller;
              timingInfo.finalConnectionTimingInfo = clampAndCoarsenConnectionTimingInfo(void 0, timingInfo.postRedirectStartTime, fetchParams.crossOriginIsolatedCapability), connection.destroyed ? abort(new DOMException("The operation was aborted.", "AbortError")) : (fetchParams.controller.on("terminated", abort), this.abort = connection.abort = abort), timingInfo.finalNetworkRequestStartTime = coarsenedSharedCurrentTime(fetchParams.crossOriginIsolatedCapability);
            },
            onResponseStarted() {
              timingInfo.finalNetworkResponseStartTime = coarsenedSharedCurrentTime(fetchParams.crossOriginIsolatedCapability);
            },
            onHeaders(status, rawHeaders, resume, statusText) {
              if (status < 200)
                return !1;
              let headersList = new HeadersList();
              for (let i = 0; i < rawHeaders.length; i += 2)
                headersList.append(bufferToLowerCasedHeaderName(rawHeaders[i]), rawHeaders[i + 1].toString("latin1"), !0);
              let location = headersList.get("location", !0);
              this.body = new Readable({ read: resume });
              let willFollow = location && request.redirect === "follow" && redirectStatusSet.has(status), decoders = [];
              if (request.method !== "HEAD" && request.method !== "CONNECT" && !nullBodyStatus.includes(status) && !willFollow) {
                let contentEncoding = headersList.get("content-encoding", !0), codings = contentEncoding ? contentEncoding.toLowerCase().split(",") : [], maxContentEncodings = 5;
                if (codings.length > maxContentEncodings)
                  return reject(new Error(`too many content-encodings in response: ${codings.length}, maximum allowed is ${maxContentEncodings}`)), !0;
                for (let i = codings.length - 1; i >= 0; --i) {
                  let coding = codings[i].trim();
                  if (coding === "x-gzip" || coding === "gzip")
                    decoders.push(zlib.createGunzip({
                      // Be less strict when decoding compressed responses, since sometimes
                      // servers send slightly invalid responses that are still accepted
                      // by common browsers.
                      // Always using Z_SYNC_FLUSH is what cURL does.
                      flush: zlib.constants.Z_SYNC_FLUSH,
                      finishFlush: zlib.constants.Z_SYNC_FLUSH
                    }));
                  else if (coding === "deflate")
                    decoders.push(createInflate({
                      flush: zlib.constants.Z_SYNC_FLUSH,
                      finishFlush: zlib.constants.Z_SYNC_FLUSH
                    }));
                  else if (coding === "br")
                    decoders.push(zlib.createBrotliDecompress({
                      flush: zlib.constants.BROTLI_OPERATION_FLUSH,
                      finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH
                    }));
                  else if (coding === "zstd" && hasZstd)
                    decoders.push(zlib.createZstdDecompress({
                      flush: zlib.constants.ZSTD_e_continue,
                      finishFlush: zlib.constants.ZSTD_e_end
                    }));
                  else {
                    decoders.length = 0;
                    break;
                  }
                }
              }
              let onError = this.onError.bind(this);
              return resolve({
                status,
                statusText,
                headersList,
                body: decoders.length ? pipeline(this.body, ...decoders, (err) => {
                  err && this.onError(err);
                }).on("error", onError) : this.body.on("error", onError)
              }), !0;
            },
            onData(chunk) {
              if (fetchParams.controller.dump)
                return;
              let bytes = chunk;
              return timingInfo.encodedBodySize += bytes.byteLength, this.body.push(bytes);
            },
            onComplete() {
              this.abort && fetchParams.controller.off("terminated", this.abort), fetchParams.controller.ended = !0, this.body.push(null);
            },
            onError(error) {
              this.abort && fetchParams.controller.off("terminated", this.abort), this.body?.destroy(error), fetchParams.controller.terminate(error), reject(error);
            },
            onUpgrade(status, rawHeaders, socket) {
              if (socket.session != null && status !== 200 || socket.session == null && status !== 101)
                return !1;
              let headersList = new HeadersList();
              for (let i = 0; i < rawHeaders.length; i += 2)
                headersList.append(bufferToLowerCasedHeaderName(rawHeaders[i]), rawHeaders[i + 1].toString("latin1"), !0);
              return resolve({
                status,
                statusText: STATUS_CODES[status],
                headersList,
                socket
              }), !0;
            }
          }
        ));
      }
      __name(dispatch, "dispatch");
    }
    __name(httpNetworkFetch, "httpNetworkFetch");
    module2.exports = {
      fetch: fetch2,
      Fetch,
      fetching,
      finalizeAndReportTiming
    };
  }
});

// lib/web/websocket/events.js
var require_events = __commonJS({
  "lib/web/websocket/events.js"(exports2, module2) {
    "use strict";
    var { webidl } = require_webidl(), { kEnumerableProperty } = require_util(), { kConstruct } = require_symbols(), MessageEvent2 = class _MessageEvent extends Event {
      static {
        __name(this, "MessageEvent");
      }
      #eventInit;
      constructor(type, eventInitDict = {}) {
        if (type === kConstruct) {
          super(arguments[1], arguments[2]), webidl.util.markAsUncloneable(this);
          return;
        }
        let prefix = "MessageEvent constructor";
        webidl.argumentLengthCheck(arguments, 1, prefix), type = webidl.converters.DOMString(type, prefix, "type"), eventInitDict = webidl.converters.MessageEventInit(eventInitDict, prefix, "eventInitDict"), super(type, eventInitDict), this.#eventInit = eventInitDict, webidl.util.markAsUncloneable(this);
      }
      get data() {
        return webidl.brandCheck(this, _MessageEvent), this.#eventInit.data;
      }
      get origin() {
        return webidl.brandCheck(this, _MessageEvent), this.#eventInit.origin;
      }
      get lastEventId() {
        return webidl.brandCheck(this, _MessageEvent), this.#eventInit.lastEventId;
      }
      get source() {
        return webidl.brandCheck(this, _MessageEvent), this.#eventInit.source;
      }
      get ports() {
        return webidl.brandCheck(this, _MessageEvent), Object.isFrozen(this.#eventInit.ports) || Object.freeze(this.#eventInit.ports), this.#eventInit.ports;
      }
      initMessageEvent(type, bubbles = !1, cancelable = !1, data = null, origin = "", lastEventId = "", source = null, ports = []) {
        return webidl.brandCheck(this, _MessageEvent), webidl.argumentLengthCheck(arguments, 1, "MessageEvent.initMessageEvent"), new _MessageEvent(type, {
          bubbles,
          cancelable,
          data,
          origin,
          lastEventId,
          source,
          ports
        });
      }
      static createFastMessageEvent(type, init) {
        let messageEvent = new _MessageEvent(kConstruct, type, init);
        return messageEvent.#eventInit = init, messageEvent.#eventInit.data ??= null, messageEvent.#eventInit.origin ??= "", messageEvent.#eventInit.lastEventId ??= "", messageEvent.#eventInit.source ??= null, messageEvent.#eventInit.ports ??= [], messageEvent;
      }
    }, { createFastMessageEvent: createFastMessageEvent2 } = MessageEvent2;
    delete MessageEvent2.createFastMessageEvent;
    var CloseEvent2 = class _CloseEvent extends Event {
      static {
        __name(this, "CloseEvent");
      }
      #eventInit;
      constructor(type, eventInitDict = {}) {
        let prefix = "CloseEvent constructor";
        webidl.argumentLengthCheck(arguments, 1, prefix), type = webidl.converters.DOMString(type, prefix, "type"), eventInitDict = webidl.converters.CloseEventInit(eventInitDict), super(type, eventInitDict), this.#eventInit = eventInitDict, webidl.util.markAsUncloneable(this);
      }
      get wasClean() {
        return webidl.brandCheck(this, _CloseEvent), this.#eventInit.wasClean;
      }
      get code() {
        return webidl.brandCheck(this, _CloseEvent), this.#eventInit.code;
      }
      get reason() {
        return webidl.brandCheck(this, _CloseEvent), this.#eventInit.reason;
      }
    }, ErrorEvent2 = class _ErrorEvent extends Event {
      static {
        __name(this, "ErrorEvent");
      }
      #eventInit;
      constructor(type, eventInitDict) {
        let prefix = "ErrorEvent constructor";
        webidl.argumentLengthCheck(arguments, 1, prefix), super(type, eventInitDict), webidl.util.markAsUncloneable(this), type = webidl.converters.DOMString(type, prefix, "type"), eventInitDict = webidl.converters.ErrorEventInit(eventInitDict ?? {}), this.#eventInit = eventInitDict;
      }
      get message() {
        return webidl.brandCheck(this, _ErrorEvent), this.#eventInit.message;
      }
      get filename() {
        return webidl.brandCheck(this, _ErrorEvent), this.#eventInit.filename;
      }
      get lineno() {
        return webidl.brandCheck(this, _ErrorEvent), this.#eventInit.lineno;
      }
      get colno() {
        return webidl.brandCheck(this, _ErrorEvent), this.#eventInit.colno;
      }
      get error() {
        return webidl.brandCheck(this, _ErrorEvent), this.#eventInit.error;
      }
    };
    Object.defineProperties(MessageEvent2.prototype, {
      [Symbol.toStringTag]: {
        value: "MessageEvent",
        configurable: !0
      },
      data: kEnumerableProperty,
      origin: kEnumerableProperty,
      lastEventId: kEnumerableProperty,
      source: kEnumerableProperty,
      ports: kEnumerableProperty,
      initMessageEvent: kEnumerableProperty
    });
    Object.defineProperties(CloseEvent2.prototype, {
      [Symbol.toStringTag]: {
        value: "CloseEvent",
        configurable: !0
      },
      reason: kEnumerableProperty,
      code: kEnumerableProperty,
      wasClean: kEnumerableProperty
    });
    Object.defineProperties(ErrorEvent2.prototype, {
      [Symbol.toStringTag]: {
        value: "ErrorEvent",
        configurable: !0
      },
      message: kEnumerableProperty,
      filename: kEnumerableProperty,
      lineno: kEnumerableProperty,
      colno: kEnumerableProperty,
      error: kEnumerableProperty
    });
    webidl.converters.MessagePort = webidl.interfaceConverter(
      webidl.is.MessagePort,
      "MessagePort"
    );
    webidl.converters["sequence<MessagePort>"] = webidl.sequenceConverter(
      webidl.converters.MessagePort
    );
    var eventInit = [
      {
        key: "bubbles",
        converter: webidl.converters.boolean,
        defaultValue: /* @__PURE__ */ __name(() => !1, "defaultValue")
      },
      {
        key: "cancelable",
        converter: webidl.converters.boolean,
        defaultValue: /* @__PURE__ */ __name(() => !1, "defaultValue")
      },
      {
        key: "composed",
        converter: webidl.converters.boolean,
        defaultValue: /* @__PURE__ */ __name(() => !1, "defaultValue")
      }
    ];
    webidl.converters.MessageEventInit = webidl.dictionaryConverter([
      ...eventInit,
      {
        key: "data",
        converter: webidl.converters.any,
        defaultValue: /* @__PURE__ */ __name(() => null, "defaultValue")
      },
      {
        key: "origin",
        converter: webidl.converters.USVString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      },
      {
        key: "lastEventId",
        converter: webidl.converters.DOMString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      },
      {
        key: "source",
        // Node doesn't implement WindowProxy or ServiceWorker, so the only
        // valid value for source is a MessagePort.
        converter: webidl.nullableConverter(webidl.converters.MessagePort),
        defaultValue: /* @__PURE__ */ __name(() => null, "defaultValue")
      },
      {
        key: "ports",
        converter: webidl.converters["sequence<MessagePort>"],
        defaultValue: /* @__PURE__ */ __name(() => [], "defaultValue")
      }
    ]);
    webidl.converters.CloseEventInit = webidl.dictionaryConverter([
      ...eventInit,
      {
        key: "wasClean",
        converter: webidl.converters.boolean,
        defaultValue: /* @__PURE__ */ __name(() => !1, "defaultValue")
      },
      {
        key: "code",
        converter: webidl.converters["unsigned short"],
        defaultValue: /* @__PURE__ */ __name(() => 0, "defaultValue")
      },
      {
        key: "reason",
        converter: webidl.converters.USVString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      }
    ]);
    webidl.converters.ErrorEventInit = webidl.dictionaryConverter([
      ...eventInit,
      {
        key: "message",
        converter: webidl.converters.DOMString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      },
      {
        key: "filename",
        converter: webidl.converters.USVString,
        defaultValue: /* @__PURE__ */ __name(() => "", "defaultValue")
      },
      {
        key: "lineno",
        converter: webidl.converters["unsigned long"],
        defaultValue: /* @__PURE__ */ __name(() => 0, "defaultValue")
      },
      {
        key: "colno",
        converter: webidl.converters["unsigned long"],
        defaultValue: /* @__PURE__ */ __name(() => 0, "defaultValue")
      },
      {
        key: "error",
        converter: webidl.converters.any
      }
    ]);
    module2.exports = {
      MessageEvent: MessageEvent2,
      CloseEvent: CloseEvent2,
      ErrorEvent: ErrorEvent2,
      createFastMessageEvent: createFastMessageEvent2
    };
  }
});

// lib/web/websocket/constants.js
var require_constants4 = __commonJS({
  "lib/web/websocket/constants.js"(exports2, module2) {
    "use strict";
    var uid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", staticPropertyDescriptors = {
      enumerable: !0,
      writable: !1,
      configurable: !1
    }, states = {
      CONNECTING: 0,
      OPEN: 1,
      CLOSING: 2,
      CLOSED: 3
    }, sentCloseFrameState = {
      SENT: 1,
      RECEIVED: 2
    }, opcodes = {
      CONTINUATION: 0,
      TEXT: 1,
      BINARY: 2,
      CLOSE: 8,
      PING: 9,
      PONG: 10
    }, maxUnsigned16Bit = 65535, parserStates = {
      INFO: 0,
      PAYLOADLENGTH_16: 2,
      PAYLOADLENGTH_64: 3,
      READ_DATA: 4
    }, emptyBuffer = Buffer.allocUnsafe(0), sendHints = {
      text: 1,
      typedArray: 2,
      arrayBuffer: 3,
      blob: 4
    };
    module2.exports = {
      uid,
      sentCloseFrameState,
      staticPropertyDescriptors,
      states,
      opcodes,
      maxUnsigned16Bit,
      parserStates,
      emptyBuffer,
      sendHints
    };
  }
});

// lib/web/websocket/util.js
var require_util3 = __commonJS({
  "lib/web/websocket/util.js"(exports2, module2) {
    "use strict";
    var { states, opcodes } = require_constants4(), { isUtf8 } = require("node:buffer"), { removeHTTPWhitespace } = require_data_url(), { collectASequenceOfCodePointsFast } = require_infra();
    function isConnecting(readyState) {
      return readyState === states.CONNECTING;
    }
    __name(isConnecting, "isConnecting");
    function isEstablished(readyState) {
      return readyState === states.OPEN;
    }
    __name(isEstablished, "isEstablished");
    function isClosing(readyState) {
      return readyState === states.CLOSING;
    }
    __name(isClosing, "isClosing");
    function isClosed(readyState) {
      return readyState === states.CLOSED;
    }
    __name(isClosed, "isClosed");
    function fireEvent(e, target, eventFactory = (type, init) => new Event(type, init), eventInitDict = {}) {
      let event = eventFactory(e, eventInitDict);
      target.dispatchEvent(event);
    }
    __name(fireEvent, "fireEvent");
    function websocketMessageReceived(handler, type, data) {
      handler.onMessage(type, data);
    }
    __name(websocketMessageReceived, "websocketMessageReceived");
    function toArrayBuffer(buffer) {
      return buffer.byteLength === buffer.buffer.byteLength ? buffer.buffer : new Uint8Array(buffer).buffer;
    }
    __name(toArrayBuffer, "toArrayBuffer");
    function isValidSubprotocol(protocol) {
      if (protocol.length === 0)
        return !1;
      for (let i = 0; i < protocol.length; ++i) {
        let code = protocol.charCodeAt(i);
        if (code < 33 || // CTL, contains SP (0x20) and HT (0x09)
        code > 126 || code === 34 || // "
        code === 40 || // (
        code === 41 || // )
        code === 44 || // ,
        code === 47 || // /
        code === 58 || // :
        code === 59 || // ;
        code === 60 || // <
        code === 61 || // =
        code === 62 || // >
        code === 63 || // ?
        code === 64 || // @
        code === 91 || // [
        code === 92 || // \
        code === 93 || // ]
        code === 123 || // {
        code === 125)
          return !1;
      }
      return !0;
    }
    __name(isValidSubprotocol, "isValidSubprotocol");
    function isValidStatusCode(code) {
      return code >= 1e3 && code < 1015 ? code !== 1004 && // reserved
      code !== 1005 && // "MUST NOT be set as a status code"
      code !== 1006 : code >= 3e3 && code <= 4999;
    }
    __name(isValidStatusCode, "isValidStatusCode");
    function isControlFrame(opcode) {
      return opcode === opcodes.CLOSE || opcode === opcodes.PING || opcode === opcodes.PONG;
    }
    __name(isControlFrame, "isControlFrame");
    function isContinuationFrame(opcode) {
      return opcode === opcodes.CONTINUATION;
    }
    __name(isContinuationFrame, "isContinuationFrame");
    function isTextBinaryFrame(opcode) {
      return opcode === opcodes.TEXT || opcode === opcodes.BINARY;
    }
    __name(isTextBinaryFrame, "isTextBinaryFrame");
    function isValidOpcode(opcode) {
      return isTextBinaryFrame(opcode) || isContinuationFrame(opcode) || isControlFrame(opcode);
    }
    __name(isValidOpcode, "isValidOpcode");
    function parseExtensions(extensions) {
      let position = { position: 0 }, extensionList = /* @__PURE__ */ new Map();
      for (; position.position < extensions.length; ) {
        let pair = collectASequenceOfCodePointsFast(";", extensions, position), [name, value = ""] = pair.split("=", 2);
        extensionList.set(
          removeHTTPWhitespace(name, !0, !1),
          removeHTTPWhitespace(value, !1, !0)
        ), position.position++;
      }
      return extensionList;
    }
    __name(parseExtensions, "parseExtensions");
    function isValidClientWindowBits(value) {
      for (let i = 0; i < value.length; i++) {
        let byte = value.charCodeAt(i);
        if (byte < 48 || byte > 57)
          return !1;
      }
      return !0;
    }
    __name(isValidClientWindowBits, "isValidClientWindowBits");
    function getURLRecord(url, baseURL) {
      let urlRecord;
      try {
        urlRecord = new URL(url, baseURL);
      } catch (e) {
        throw new DOMException(e, "SyntaxError");
      }
      if (urlRecord.protocol === "http:" ? urlRecord.protocol = "ws:" : urlRecord.protocol === "https:" && (urlRecord.protocol = "wss:"), urlRecord.protocol !== "ws:" && urlRecord.protocol !== "wss:")
        throw new DOMException("expected a ws: or wss: url", "SyntaxError");
      if (urlRecord.hash.length || urlRecord.href.endsWith("#"))
        throw new DOMException("hash", "SyntaxError");
      return urlRecord;
    }
    __name(getURLRecord, "getURLRecord");
    function validateCloseCodeAndReason(code, reason) {
      if (code !== null && code !== 1e3 && (code < 3e3 || code > 4999))
        throw new DOMException("invalid code", "InvalidAccessError");
      if (reason !== null) {
        let reasonBytesLength = Buffer.byteLength(reason);
        if (reasonBytesLength > 123)
          throw new DOMException(`Reason must be less than 123 bytes; received ${reasonBytesLength}`, "SyntaxError");
      }
    }
    __name(validateCloseCodeAndReason, "validateCloseCodeAndReason");
    var utf8Decode = (() => {
      if (typeof process.versions.icu == "string") {
        let fatalDecoder = new TextDecoder("utf-8", { fatal: !0 });
        return fatalDecoder.decode.bind(fatalDecoder);
      }
      return function(buffer) {
        if (isUtf8(buffer))
          return buffer.toString("utf-8");
        throw new TypeError("Invalid utf-8 received.");
      };
    })();
    module2.exports = {
      isConnecting,
      isEstablished,
      isClosing,
      isClosed,
      fireEvent,
      isValidSubprotocol,
      isValidStatusCode,
      websocketMessageReceived,
      utf8Decode,
      isControlFrame,
      isContinuationFrame,
      isTextBinaryFrame,
      isValidOpcode,
      parseExtensions,
      isValidClientWindowBits,
      toArrayBuffer,
      getURLRecord,
      validateCloseCodeAndReason
    };
  }
});

// lib/web/websocket/frame.js
var require_frame = __commonJS({
  "lib/web/websocket/frame.js"(exports2, module2) {
    "use strict";
    var { runtimeFeatures } = require_runtime_features(), { maxUnsigned16Bit, opcodes } = require_constants4(), BUFFER_SIZE = 8 * 1024, buffer = null, bufIdx = BUFFER_SIZE, randomFillSync = runtimeFeatures.has("crypto") ? require("node:crypto").randomFillSync : /* @__PURE__ */ __name(function(buffer2, _offset, _size) {
      for (let i = 0; i < buffer2.length; ++i)
        buffer2[i] = Math.random() * 255 | 0;
      return buffer2;
    }, "randomFillSync");
    function generateMask() {
      return bufIdx === BUFFER_SIZE && (bufIdx = 0, randomFillSync(buffer ??= Buffer.allocUnsafeSlow(BUFFER_SIZE), 0, BUFFER_SIZE)), [buffer[bufIdx++], buffer[bufIdx++], buffer[bufIdx++], buffer[bufIdx++]];
    }
    __name(generateMask, "generateMask");
    var WebsocketFrameSend = class {
      static {
        __name(this, "WebsocketFrameSend");
      }
      /**
       * @param {Buffer|undefined} data
       */
      constructor(data) {
        this.frameData = data;
      }
      createFrame(opcode) {
        let frameData = this.frameData, maskKey = generateMask(), bodyLength = frameData?.byteLength ?? 0, payloadLength = bodyLength, offset = 6;
        bodyLength > maxUnsigned16Bit ? (offset += 8, payloadLength = 127) : bodyLength > 125 && (offset += 2, payloadLength = 126);
        let buffer2 = Buffer.allocUnsafe(bodyLength + offset);
        buffer2[0] = buffer2[1] = 0, buffer2[0] |= 128, buffer2[0] = (buffer2[0] & 240) + opcode;
        buffer2[offset - 4] = maskKey[0], buffer2[offset - 3] = maskKey[1], buffer2[offset - 2] = maskKey[2], buffer2[offset - 1] = maskKey[3], buffer2[1] = payloadLength, payloadLength === 126 ? buffer2.writeUInt16BE(bodyLength, 2) : payloadLength === 127 && (buffer2[2] = buffer2[3] = 0, buffer2.writeUIntBE(bodyLength, 4, 6)), buffer2[1] |= 128;
        for (let i = 0; i < bodyLength; ++i)
          buffer2[offset + i] = frameData[i] ^ maskKey[i & 3];
        return buffer2;
      }
      /**
       * @param {Uint8Array} buffer
       */
      static createFastTextFrame(buffer2) {
        let maskKey = generateMask(), bodyLength = buffer2.length;
        for (let i = 0; i < bodyLength; ++i)
          buffer2[i] ^= maskKey[i & 3];
        let payloadLength = bodyLength, offset = 6;
        bodyLength > maxUnsigned16Bit ? (offset += 8, payloadLength = 127) : bodyLength > 125 && (offset += 2, payloadLength = 126);
        let head = Buffer.allocUnsafeSlow(offset);
        return head[0] = 128 | opcodes.TEXT, head[1] = payloadLength | 128, head[offset - 4] = maskKey[0], head[offset - 3] = maskKey[1], head[offset - 2] = maskKey[2], head[offset - 1] = maskKey[3], payloadLength === 126 ? head.writeUInt16BE(bodyLength, 2) : payloadLength === 127 && (head[2] = head[3] = 0, head.writeUIntBE(bodyLength, 4, 6)), [head, buffer2];
      }
    };
    module2.exports = {
      WebsocketFrameSend,
      generateMask
      // for benchmark
    };
  }
});

// lib/web/websocket/connection.js
var require_connection = __commonJS({
  "lib/web/websocket/connection.js"(exports2, module2) {
    "use strict";
    var { uid, states, sentCloseFrameState, emptyBuffer, opcodes } = require_constants4(), { parseExtensions, isClosed, isClosing, isEstablished, isConnecting, validateCloseCodeAndReason } = require_util3(), { makeRequest } = require_request2(), { fetching } = require_fetch(), { Headers, getHeadersList } = require_headers(), { getDecodeSplit } = require_util2(), { WebsocketFrameSend } = require_frame(), assert = require("node:assert"), { runtimeFeatures } = require_runtime_features(), crypto = runtimeFeatures.has("crypto") ? require("node:crypto") : null, warningEmitted = !1;
    function establishWebSocketConnection(url, protocols, client, handler, options) {
      let requestURL = url;
      requestURL.protocol = url.protocol === "ws:" ? "http:" : "https:";
      let request = makeRequest({
        urlList: [requestURL],
        client,
        serviceWorkers: "none",
        referrer: "no-referrer",
        mode: "websocket",
        credentials: "include",
        cache: "no-store",
        redirect: "error"
      });
      if (options.headers) {
        let headersList = getHeadersList(new Headers(options.headers));
        request.headersList = headersList;
      }
      let keyValue = crypto.randomBytes(16).toString("base64");
      request.headersList.append("sec-websocket-key", keyValue, !0), request.headersList.append("sec-websocket-version", "13", !0);
      for (let protocol of protocols)
        request.headersList.append("sec-websocket-protocol", protocol, !0);
      return request.headersList.append("sec-websocket-extensions", "permessage-deflate; client_max_window_bits", !0), fetching({
        request,
        useParallelQueue: !0,
        dispatcher: options.dispatcher,
        processResponse(response) {
          if (response.type === "error" || response.status !== 101) {
            if (response.socket?.session == null) {
              failWebsocketConnection(handler, 1002, "Received network error or non-101 status code.", response.error);
              return;
            }
            if (response.status !== 200) {
              failWebsocketConnection(handler, 1002, "Received network error or non-200 status code.", response.error);
              return;
            }
          }
          if (warningEmitted === !1 && response.socket?.session != null && (process.emitWarning("WebSocket over HTTP2 is experimental, and subject to change.", "ExperimentalWarning"), warningEmitted = !0), protocols.length !== 0 && !response.headersList.get("Sec-WebSocket-Protocol")) {
            failWebsocketConnection(handler, 1002, "Server did not respond with sent protocols.");
            return;
          }
          if (response.socket.session == null && response.headersList.get("Upgrade")?.toLowerCase() !== "websocket") {
            failWebsocketConnection(handler, 1002, 'Server did not set Upgrade header to "websocket".');
            return;
          }
          if (response.socket.session == null && response.headersList.get("Connection")?.toLowerCase() !== "upgrade") {
            failWebsocketConnection(handler, 1002, 'Server did not set Connection header to "upgrade".');
            return;
          }
          let secWSAccept = response.headersList.get("Sec-WebSocket-Accept"), digest = crypto.hash("sha1", keyValue + uid, "base64");
          if (secWSAccept !== digest) {
            failWebsocketConnection(handler, 1002, "Incorrect hash received in Sec-WebSocket-Accept header.");
            return;
          }
          let secExtension = response.headersList.get("Sec-WebSocket-Extensions"), extensions;
          if (secExtension !== null && (extensions = parseExtensions(secExtension), !extensions.has("permessage-deflate"))) {
            failWebsocketConnection(handler, 1002, "Sec-WebSocket-Extensions header does not match.");
            return;
          }
          let secProtocol = response.headersList.get("Sec-WebSocket-Protocol");
          if (secProtocol !== null && !getDecodeSplit("sec-websocket-protocol", request.headersList).includes(secProtocol)) {
            failWebsocketConnection(handler, 1002, "Protocol was not set in the opening handshake.");
            return;
          }
          response.socket.on("data", handler.onSocketData), response.socket.on("close", handler.onSocketClose), response.socket.on("error", handler.onSocketError), handler.wasEverConnected = !0, handler.onConnectionEstablished(response, extensions);
        }
      });
    }
    __name(establishWebSocketConnection, "establishWebSocketConnection");
    function closeWebSocketConnection(object, code, reason, validate = !1) {
      if (code ??= null, reason ??= "", validate && validateCloseCodeAndReason(code, reason), !(isClosed(object.readyState) || isClosing(object.readyState)))
        if (!isEstablished(object.readyState))
          failWebsocketConnection(object), object.readyState = states.CLOSING;
        else if (!object.closeState.has(sentCloseFrameState.SENT) && !object.closeState.has(sentCloseFrameState.RECEIVED)) {
          let frame = new WebsocketFrameSend();
          reason.length !== 0 && code === null && (code = 1e3), assert(code === null || Number.isInteger(code)), code === null && reason.length === 0 ? frame.frameData = emptyBuffer : code !== null && reason === null ? (frame.frameData = Buffer.allocUnsafe(2), frame.frameData.writeUInt16BE(code, 0)) : code !== null && reason !== null ? (frame.frameData = Buffer.allocUnsafe(2 + Buffer.byteLength(reason)), frame.frameData.writeUInt16BE(code, 0), frame.frameData.write(reason, 2, "utf-8")) : frame.frameData = emptyBuffer, object.socket.write(frame.createFrame(opcodes.CLOSE)), object.closeState.add(sentCloseFrameState.SENT), object.readyState = states.CLOSING;
        } else
          object.readyState = states.CLOSING;
    }
    __name(closeWebSocketConnection, "closeWebSocketConnection");
    function failWebsocketConnection(handler, code, reason, cause) {
      isEstablished(handler.readyState) && closeWebSocketConnection(handler, code, reason, !1), handler.controller.abort(), isConnecting(handler.readyState) ? handler.onSocketClose() : handler.socket?.destroyed === !1 && handler.socket.destroy();
    }
    __name(failWebsocketConnection, "failWebsocketConnection");
    module2.exports = {
      establishWebSocketConnection,
      failWebsocketConnection,
      closeWebSocketConnection
    };
  }
});

// lib/web/websocket/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "lib/web/websocket/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var { createInflateRaw, Z_DEFAULT_WINDOWBITS } = require("node:zlib"), { isValidClientWindowBits } = require_util3(), tail = Buffer.from([0, 0, 255, 255]), kBuffer = Symbol("kBuffer"), kLength = Symbol("kLength"), PerMessageDeflate = class {
      static {
        __name(this, "PerMessageDeflate");
      }
      /** @type {import('node:zlib').InflateRaw} */
      #inflate;
      #options = {};
      constructor(extensions) {
        this.#options.serverNoContextTakeover = extensions.has("server_no_context_takeover"), this.#options.serverMaxWindowBits = extensions.get("server_max_window_bits");
      }
      decompress(chunk, fin, callback) {
        if (!this.#inflate) {
          let windowBits = Z_DEFAULT_WINDOWBITS;
          if (this.#options.serverMaxWindowBits) {
            if (!isValidClientWindowBits(this.#options.serverMaxWindowBits)) {
              callback(new Error("Invalid server_max_window_bits"));
              return;
            }
            windowBits = Number.parseInt(this.#options.serverMaxWindowBits);
          }
          this.#inflate = createInflateRaw({ windowBits }), this.#inflate[kBuffer] = [], this.#inflate[kLength] = 0, this.#inflate.on("data", (data) => {
            this.#inflate[kBuffer].push(data), this.#inflate[kLength] += data.length;
          }), this.#inflate.on("error", (err) => {
            this.#inflate = null, callback(err);
          });
        }
        this.#inflate.write(chunk), fin && this.#inflate.write(tail), this.#inflate.flush(() => {
          let full = Buffer.concat(this.#inflate[kBuffer], this.#inflate[kLength]);
          this.#inflate[kBuffer].length = 0, this.#inflate[kLength] = 0, callback(null, full);
        });
      }
    };
    module2.exports = { PerMessageDeflate };
  }
});

// lib/web/websocket/receiver.js
var require_receiver = __commonJS({
  "lib/web/websocket/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("node:stream"), assert = require("node:assert"), { parserStates, opcodes, states, emptyBuffer, sentCloseFrameState } = require_constants4(), {
      isValidStatusCode,
      isValidOpcode,
      websocketMessageReceived,
      utf8Decode,
      isControlFrame,
      isTextBinaryFrame,
      isContinuationFrame
    } = require_util3(), { failWebsocketConnection } = require_connection(), { WebsocketFrameSend } = require_frame(), { PerMessageDeflate } = require_permessage_deflate(), ByteParser = class extends Writable {
      static {
        __name(this, "ByteParser");
      }
      #buffers = [];
      #fragmentsBytes = 0;
      #byteOffset = 0;
      #loop = !1;
      #state = parserStates.INFO;
      #info = {};
      #fragments = [];
      /** @type {Map<string, PerMessageDeflate>} */
      #extensions;
      /** @type {import('./websocket').Handler} */
      #handler;
      constructor(handler, extensions) {
        super(), this.#handler = handler, this.#extensions = extensions ?? /* @__PURE__ */ new Map(), this.#extensions.has("permessage-deflate") && this.#extensions.set("permessage-deflate", new PerMessageDeflate(extensions));
      }
      /**
       * @param {Buffer} chunk
       * @param {() => void} callback
       */
      _write(chunk, _, callback) {
        this.#buffers.push(chunk), this.#byteOffset += chunk.length, this.#loop = !0, this.run(callback);
      }
      /**
       * Runs whenever a new chunk is received.
       * Callback is called whenever there are no more chunks buffering,
       * or not enough bytes are buffered to parse.
       */
      run(callback) {
        for (; this.#loop; )
          if (this.#state === parserStates.INFO) {
            if (this.#byteOffset < 2)
              return callback();
            let buffer = this.consume(2), fin = (buffer[0] & 128) !== 0, opcode = buffer[0] & 15, masked = (buffer[1] & 128) === 128, fragmented = !fin && opcode !== opcodes.CONTINUATION, payloadLength = buffer[1] & 127, rsv1 = buffer[0] & 64, rsv2 = buffer[0] & 32, rsv3 = buffer[0] & 16;
            if (!isValidOpcode(opcode))
              return failWebsocketConnection(this.#handler, 1002, "Invalid opcode received"), callback();
            if (masked)
              return failWebsocketConnection(this.#handler, 1002, "Frame cannot be masked"), callback();
            if (rsv1 !== 0 && !this.#extensions.has("permessage-deflate")) {
              failWebsocketConnection(this.#handler, 1002, "Expected RSV1 to be clear.");
              return;
            }
            if (rsv2 !== 0 || rsv3 !== 0) {
              failWebsocketConnection(this.#handler, 1002, "RSV1, RSV2, RSV3 must be clear");
              return;
            }
            if (fragmented && !isTextBinaryFrame(opcode)) {
              failWebsocketConnection(this.#handler, 1002, "Invalid frame type was fragmented.");
              return;
            }
            if (isTextBinaryFrame(opcode) && this.#fragments.length > 0) {
              failWebsocketConnection(this.#handler, 1002, "Expected continuation frame");
              return;
            }
            if (this.#info.fragmented && fragmented) {
              failWebsocketConnection(this.#handler, 1002, "Fragmented frame exceeded 125 bytes.");
              return;
            }
            if ((payloadLength > 125 || fragmented) && isControlFrame(opcode)) {
              failWebsocketConnection(this.#handler, 1002, "Control frame either too large or fragmented");
              return;
            }
            if (isContinuationFrame(opcode) && this.#fragments.length === 0 && !this.#info.compressed) {
              failWebsocketConnection(this.#handler, 1002, "Unexpected continuation frame");
              return;
            }
            payloadLength <= 125 ? (this.#info.payloadLength = payloadLength, this.#state = parserStates.READ_DATA) : payloadLength === 126 ? this.#state = parserStates.PAYLOADLENGTH_16 : payloadLength === 127 && (this.#state = parserStates.PAYLOADLENGTH_64), isTextBinaryFrame(opcode) && (this.#info.binaryType = opcode, this.#info.compressed = rsv1 !== 0), this.#info.opcode = opcode, this.#info.masked = masked, this.#info.fin = fin, this.#info.fragmented = fragmented;
          } else if (this.#state === parserStates.PAYLOADLENGTH_16) {
            if (this.#byteOffset < 2)
              return callback();
            let buffer = this.consume(2);
            this.#info.payloadLength = buffer.readUInt16BE(0), this.#state = parserStates.READ_DATA;
          } else if (this.#state === parserStates.PAYLOADLENGTH_64) {
            if (this.#byteOffset < 8)
              return callback();
            let buffer = this.consume(8), upper = buffer.readUInt32BE(0);
            if (upper > 2 ** 31 - 1) {
              failWebsocketConnection(this.#handler, 1009, "Received payload length > 2^31 bytes.");
              return;
            }
            let lower = buffer.readUInt32BE(4);
            this.#info.payloadLength = (upper << 8) + lower, this.#state = parserStates.READ_DATA;
          } else if (this.#state === parserStates.READ_DATA) {
            if (this.#byteOffset < this.#info.payloadLength)
              return callback();
            let body = this.consume(this.#info.payloadLength);
            if (isControlFrame(this.#info.opcode))
              this.#loop = this.parseControlFrame(body), this.#state = parserStates.INFO;
            else if (!this.#info.compressed)
              this.writeFragments(body), !this.#info.fragmented && this.#info.fin && websocketMessageReceived(this.#handler, this.#info.binaryType, this.consumeFragments()), this.#state = parserStates.INFO;
            else {
              this.#extensions.get("permessage-deflate").decompress(body, this.#info.fin, (error, data) => {
                if (error) {
                  failWebsocketConnection(this.#handler, 1007, error.message);
                  return;
                }
                if (this.writeFragments(data), !this.#info.fin) {
                  this.#state = parserStates.INFO, this.#loop = !0, this.run(callback);
                  return;
                }
                websocketMessageReceived(this.#handler, this.#info.binaryType, this.consumeFragments()), this.#loop = !0, this.#state = parserStates.INFO, this.run(callback);
              }), this.#loop = !1;
              break;
            }
          }
      }
      /**
       * Take n bytes from the buffered Buffers
       * @param {number} n
       * @returns {Buffer}
       */
      consume(n) {
        if (n > this.#byteOffset)
          throw new Error("Called consume() before buffers satiated.");
        if (n === 0)
          return emptyBuffer;
        this.#byteOffset -= n;
        let first = this.#buffers[0];
        if (first.length > n)
          return this.#buffers[0] = first.subarray(n, first.length), first.subarray(0, n);
        if (first.length === n)
          return this.#buffers.shift();
        {
          let offset = 0, buffer = Buffer.allocUnsafeSlow(n);
          for (; offset !== n; ) {
            let next = this.#buffers[0], length = next.length;
            if (length + offset === n) {
              buffer.set(this.#buffers.shift(), offset);
              break;
            } else if (length + offset > n) {
              buffer.set(next.subarray(0, n - offset), offset), this.#buffers[0] = next.subarray(n - offset);
              break;
            } else
              buffer.set(this.#buffers.shift(), offset), offset += length;
          }
          return buffer;
        }
      }
      writeFragments(fragment) {
        this.#fragmentsBytes += fragment.length, this.#fragments.push(fragment);
      }
      consumeFragments() {
        let fragments = this.#fragments;
        if (fragments.length === 1)
          return this.#fragmentsBytes = 0, fragments.shift();
        let offset = 0, output = Buffer.allocUnsafeSlow(this.#fragmentsBytes);
        for (let i = 0; i < fragments.length; ++i) {
          let buffer = fragments[i];
          output.set(buffer, offset), offset += buffer.length;
        }
        return this.#fragments = [], this.#fragmentsBytes = 0, output;
      }
      parseCloseBody(data) {
        assert(data.length !== 1);
        let code;
        if (data.length >= 2 && (code = data.readUInt16BE(0)), code !== void 0 && !isValidStatusCode(code))
          return { code: 1002, reason: "Invalid status code", error: !0 };
        let reason = data.subarray(2);
        reason[0] === 239 && reason[1] === 187 && reason[2] === 191 && (reason = reason.subarray(3));
        try {
          reason = utf8Decode(reason);
        } catch {
          return { code: 1007, reason: "Invalid UTF-8", error: !0 };
        }
        return { code, reason, error: !1 };
      }
      /**
       * Parses control frames.
       * @param {Buffer} body
       */
      parseControlFrame(body) {
        let { opcode, payloadLength } = this.#info;
        if (opcode === opcodes.CLOSE) {
          if (payloadLength === 1)
            return failWebsocketConnection(this.#handler, 1002, "Received close frame with a 1-byte body."), !1;
          if (this.#info.closeInfo = this.parseCloseBody(body), this.#info.closeInfo.error) {
            let { code, reason } = this.#info.closeInfo;
            return failWebsocketConnection(this.#handler, code, reason), !1;
          }
          if (!this.#handler.closeState.has(sentCloseFrameState.SENT) && !this.#handler.closeState.has(sentCloseFrameState.RECEIVED)) {
            let body2 = emptyBuffer;
            this.#info.closeInfo.code && (body2 = Buffer.allocUnsafe(2), body2.writeUInt16BE(this.#info.closeInfo.code, 0));
            let closeFrame = new WebsocketFrameSend(body2);
            this.#handler.socket.write(closeFrame.createFrame(opcodes.CLOSE)), this.#handler.closeState.add(sentCloseFrameState.SENT);
          }
          return this.#handler.readyState = states.CLOSING, this.#handler.closeState.add(sentCloseFrameState.RECEIVED), !1;
        } else if (opcode === opcodes.PING) {
          if (!this.#handler.closeState.has(sentCloseFrameState.RECEIVED)) {
            let frame = new WebsocketFrameSend(body);
            this.#handler.socket.write(frame.createFrame(opcodes.PONG)), this.#handler.onPing(body);
          }
        } else opcode === opcodes.PONG && this.#handler.onPong(body);
        return !0;
      }
      get closingInfo() {
        return this.#info.closeInfo;
      }
    };
    module2.exports = {
      ByteParser
    };
  }
});

// lib/web/websocket/sender.js
var require_sender = __commonJS({
  "lib/web/websocket/sender.js"(exports2, module2) {
    "use strict";
    var { WebsocketFrameSend } = require_frame(), { opcodes, sendHints } = require_constants4(), FixedQueue = require_fixed_queue(), SendQueue = class {
      static {
        __name(this, "SendQueue");
      }
      /**
       * @type {FixedQueue}
       */
      #queue = new FixedQueue();
      /**
       * @type {boolean}
       */
      #running = !1;
      /** @type {import('node:net').Socket} */
      #socket;
      constructor(socket) {
        this.#socket = socket;
      }
      add(item, cb, hint) {
        if (hint !== sendHints.blob) {
          if (this.#running) {
            let node2 = {
              promise: null,
              callback: cb,
              frame: createFrame(item, hint)
            };
            this.#queue.push(node2);
          } else if (hint === sendHints.text) {
            let { 0: head, 1: body } = WebsocketFrameSend.createFastTextFrame(item);
            this.#socket.cork(), this.#socket.write(head), this.#socket.write(body, cb), this.#socket.uncork();
          } else
            this.#socket.write(createFrame(item, hint), cb);
          return;
        }
        let node = {
          promise: item.arrayBuffer().then((ab) => {
            node.promise = null, node.frame = createFrame(ab, hint);
          }),
          callback: cb,
          frame: null
        };
        this.#queue.push(node), this.#running || this.#run();
      }
      async #run() {
        this.#running = !0;
        let queue = this.#queue;
        for (; !queue.isEmpty(); ) {
          let node = queue.shift();
          node.promise !== null && await node.promise, this.#socket.write(node.frame, node.callback), node.callback = node.frame = null;
        }
        this.#running = !1;
      }
    };
    function createFrame(data, hint) {
      return new WebsocketFrameSend(toBuffer(data, hint)).createFrame(hint === sendHints.text ? opcodes.TEXT : opcodes.BINARY);
    }
    __name(createFrame, "createFrame");
    function toBuffer(data, hint) {
      switch (hint) {
        case sendHints.text:
        case sendHints.typedArray:
          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        case sendHints.arrayBuffer:
        case sendHints.blob:
          return new Uint8Array(data);
      }
    }
    __name(toBuffer, "toBuffer");
    module2.exports = { SendQueue };
  }
});

// lib/web/websocket/websocket.js
var require_websocket = __commonJS({
  "lib/web/websocket/websocket.js"(exports2, module2) {
    "use strict";
    var { isArrayBuffer } = require("node:util/types"), { webidl } = require_webidl(), { URLSerializer } = require_data_url(), { environmentSettingsObject } = require_util2(), { staticPropertyDescriptors, states, sentCloseFrameState, sendHints, opcodes } = require_constants4(), {
      isConnecting,
      isEstablished,
      isClosing,
      isClosed,
      isValidSubprotocol,
      fireEvent,
      utf8Decode,
      toArrayBuffer,
      getURLRecord
    } = require_util3(), { establishWebSocketConnection, closeWebSocketConnection, failWebsocketConnection } = require_connection(), { ByteParser } = require_receiver(), { kEnumerableProperty } = require_util(), { getGlobalDispatcher: getGlobalDispatcher2 } = require_global2(), { ErrorEvent: ErrorEvent2, CloseEvent: CloseEvent2, createFastMessageEvent: createFastMessageEvent2 } = require_events(), { SendQueue } = require_sender(), { WebsocketFrameSend } = require_frame(), { channels } = require_diagnostics(), WebSocket = class _WebSocket extends EventTarget {
      static {
        __name(this, "WebSocket");
      }
      #events = {
        open: null,
        error: null,
        close: null,
        message: null
      };
      #bufferedAmount = 0;
      #protocol = "";
      #extensions = "";
      /** @type {SendQueue} */
      #sendQueue;
      /** @type {Handler} */
      #handler = {
        onConnectionEstablished: /* @__PURE__ */ __name((response, extensions) => this.#onConnectionEstablished(response, extensions), "onConnectionEstablished"),
        onMessage: /* @__PURE__ */ __name((opcode, data) => this.#onMessage(opcode, data), "onMessage"),
        onParserError: /* @__PURE__ */ __name((err) => failWebsocketConnection(this.#handler, null, err.message), "onParserError"),
        onParserDrain: /* @__PURE__ */ __name(() => this.#onParserDrain(), "onParserDrain"),
        onSocketData: /* @__PURE__ */ __name((chunk) => {
          this.#parser.write(chunk) || this.#handler.socket.pause();
        }, "onSocketData"),
        onSocketError: /* @__PURE__ */ __name((err) => {
          this.#handler.readyState = states.CLOSING, channels.socketError.hasSubscribers && channels.socketError.publish(err), this.#handler.socket.destroy();
        }, "onSocketError"),
        onSocketClose: /* @__PURE__ */ __name(() => this.#onSocketClose(), "onSocketClose"),
        onPing: /* @__PURE__ */ __name((body) => {
          channels.ping.hasSubscribers && channels.ping.publish({
            payload: body,
            websocket: this
          });
        }, "onPing"),
        onPong: /* @__PURE__ */ __name((body) => {
          channels.pong.hasSubscribers && channels.pong.publish({
            payload: body,
            websocket: this
          });
        }, "onPong"),
        readyState: states.CONNECTING,
        socket: null,
        closeState: /* @__PURE__ */ new Set(),
        controller: null,
        wasEverConnected: !1
      };
      #url;
      #binaryType;
      /** @type {import('./receiver').ByteParser} */
      #parser;
      /**
       * @param {string} url
       * @param {string|string[]} protocols
       */
      constructor(url, protocols = []) {
        super(), webidl.util.markAsUncloneable(this);
        let prefix = "WebSocket constructor";
        webidl.argumentLengthCheck(arguments, 1, prefix);
        let options = webidl.converters["DOMString or sequence<DOMString> or WebSocketInit"](protocols, prefix, "options");
        url = webidl.converters.USVString(url), protocols = options.protocols;
        let baseURL = environmentSettingsObject.settingsObject.baseUrl, urlRecord = getURLRecord(url, baseURL);
        if (typeof protocols == "string" && (protocols = [protocols]), protocols.length !== new Set(protocols.map((p) => p.toLowerCase())).size)
          throw new DOMException("Invalid Sec-WebSocket-Protocol value", "SyntaxError");
        if (protocols.length > 0 && !protocols.every((p) => isValidSubprotocol(p)))
          throw new DOMException("Invalid Sec-WebSocket-Protocol value", "SyntaxError");
        this.#url = new URL(urlRecord.href);
        let client = environmentSettingsObject.settingsObject;
        this.#handler.controller = establishWebSocketConnection(
          urlRecord,
          protocols,
          client,
          this.#handler,
          options
        ), this.#handler.readyState = _WebSocket.CONNECTING, this.#binaryType = "blob";
      }
      /**
       * @see https://websockets.spec.whatwg.org/#dom-websocket-close
       * @param {number|undefined} code
       * @param {string|undefined} reason
       */
      close(code = void 0, reason = void 0) {
        webidl.brandCheck(this, _WebSocket), code !== void 0 && (code = webidl.converters["unsigned short"](code, "WebSocket.close", "code", webidl.attributes.Clamp)), reason !== void 0 && (reason = webidl.converters.USVString(reason)), code ??= null, reason ??= "", closeWebSocketConnection(this.#handler, code, reason, !0);
      }
      /**
       * @see https://websockets.spec.whatwg.org/#dom-websocket-send
       * @param {NodeJS.TypedArray|ArrayBuffer|Blob|string} data
       */
      send(data) {
        webidl.brandCheck(this, _WebSocket);
        let prefix = "WebSocket.send";
        if (webidl.argumentLengthCheck(arguments, 1, prefix), data = webidl.converters.WebSocketSendData(data, prefix, "data"), isConnecting(this.#handler.readyState))
          throw new DOMException("Sent before connected.", "InvalidStateError");
        if (!(!isEstablished(this.#handler.readyState) || isClosing(this.#handler.readyState)))
          if (typeof data == "string") {
            let buffer = Buffer.from(data);
            this.#bufferedAmount += buffer.byteLength, this.#sendQueue.add(buffer, () => {
              this.#bufferedAmount -= buffer.byteLength;
            }, sendHints.text);
          } else isArrayBuffer(data) ? (this.#bufferedAmount += data.byteLength, this.#sendQueue.add(data, () => {
            this.#bufferedAmount -= data.byteLength;
          }, sendHints.arrayBuffer)) : ArrayBuffer.isView(data) ? (this.#bufferedAmount += data.byteLength, this.#sendQueue.add(data, () => {
            this.#bufferedAmount -= data.byteLength;
          }, sendHints.typedArray)) : webidl.is.Blob(data) && (this.#bufferedAmount += data.size, this.#sendQueue.add(data, () => {
            this.#bufferedAmount -= data.size;
          }, sendHints.blob));
      }
      get readyState() {
        return webidl.brandCheck(this, _WebSocket), this.#handler.readyState;
      }
      get bufferedAmount() {
        return webidl.brandCheck(this, _WebSocket), this.#bufferedAmount;
      }
      get url() {
        return webidl.brandCheck(this, _WebSocket), URLSerializer(this.#url);
      }
      get extensions() {
        return webidl.brandCheck(this, _WebSocket), this.#extensions;
      }
      get protocol() {
        return webidl.brandCheck(this, _WebSocket), this.#protocol;
      }
      get onopen() {
        return webidl.brandCheck(this, _WebSocket), this.#events.open;
      }
      set onopen(fn) {
        webidl.brandCheck(this, _WebSocket), this.#events.open && this.removeEventListener("open", this.#events.open);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("open", listener), this.#events.open = fn) : this.#events.open = null;
      }
      get onerror() {
        return webidl.brandCheck(this, _WebSocket), this.#events.error;
      }
      set onerror(fn) {
        webidl.brandCheck(this, _WebSocket), this.#events.error && this.removeEventListener("error", this.#events.error);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("error", listener), this.#events.error = fn) : this.#events.error = null;
      }
      get onclose() {
        return webidl.brandCheck(this, _WebSocket), this.#events.close;
      }
      set onclose(fn) {
        webidl.brandCheck(this, _WebSocket), this.#events.close && this.removeEventListener("close", this.#events.close);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("close", listener), this.#events.close = fn) : this.#events.close = null;
      }
      get onmessage() {
        return webidl.brandCheck(this, _WebSocket), this.#events.message;
      }
      set onmessage(fn) {
        webidl.brandCheck(this, _WebSocket), this.#events.message && this.removeEventListener("message", this.#events.message);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("message", listener), this.#events.message = fn) : this.#events.message = null;
      }
      get binaryType() {
        return webidl.brandCheck(this, _WebSocket), this.#binaryType;
      }
      set binaryType(type) {
        webidl.brandCheck(this, _WebSocket), type !== "blob" && type !== "arraybuffer" ? this.#binaryType = "blob" : this.#binaryType = type;
      }
      /**
       * @see https://websockets.spec.whatwg.org/#feedback-from-the-protocol
       */
      #onConnectionEstablished(response, parsedExtensions) {
        this.#handler.socket = response.socket;
        let parser = new ByteParser(this.#handler, parsedExtensions);
        parser.on("drain", () => this.#handler.onParserDrain()), parser.on("error", (err) => this.#handler.onParserError(err)), this.#parser = parser, this.#sendQueue = new SendQueue(response.socket), this.#handler.readyState = states.OPEN;
        let extensions = response.headersList.get("sec-websocket-extensions");
        extensions !== null && (this.#extensions = extensions);
        let protocol = response.headersList.get("sec-websocket-protocol");
        if (protocol !== null && (this.#protocol = protocol), fireEvent("open", this), channels.open.hasSubscribers) {
          let headers = response.headersList.entries;
          channels.open.publish({
            address: response.socket.address(),
            protocol: this.#protocol,
            extensions: this.#extensions,
            websocket: this,
            handshakeResponse: {
              status: response.status,
              statusText: response.statusText,
              headers
            }
          });
        }
      }
      #onMessage(type, data) {
        if (this.#handler.readyState !== states.OPEN)
          return;
        let dataForEvent;
        if (type === opcodes.TEXT)
          try {
            dataForEvent = utf8Decode(data);
          } catch {
            failWebsocketConnection(this.#handler, 1007, "Received invalid UTF-8 in text frame.");
            return;
          }
        else type === opcodes.BINARY && (this.#binaryType === "blob" ? dataForEvent = new Blob([data]) : dataForEvent = toArrayBuffer(data));
        fireEvent("message", this, createFastMessageEvent2, {
          origin: this.#url.origin,
          data: dataForEvent
        });
      }
      #onParserDrain() {
        this.#handler.socket.resume();
      }
      /**
       * @see https://websockets.spec.whatwg.org/#feedback-from-the-protocol
       * @see https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.4
       */
      #onSocketClose() {
        let wasClean = this.#handler.closeState.has(sentCloseFrameState.SENT) && this.#handler.closeState.has(sentCloseFrameState.RECEIVED), code = 1005, reason = "", result = this.#parser?.closingInfo;
        result && !result.error && (code = result.code ?? 1005, reason = result.reason), this.#handler.readyState = states.CLOSED, this.#handler.closeState.has(sentCloseFrameState.RECEIVED) || (code = 1006, fireEvent("error", this, (type, init) => new ErrorEvent2(type, init), {
          error: new TypeError(reason)
        })), fireEvent("close", this, (type, init) => new CloseEvent2(type, init), {
          wasClean,
          code,
          reason
        }), channels.close.hasSubscribers && channels.close.publish({
          websocket: this,
          code,
          reason
        });
      }
      /**
       * @param {WebSocket} ws
       * @param {Buffer|undefined} buffer
       */
      static ping(ws, buffer) {
        if (Buffer.isBuffer(buffer)) {
          if (buffer.length > 125)
            throw new TypeError("A PING frame cannot have a body larger than 125 bytes.");
        } else if (buffer !== void 0)
          throw new TypeError("Expected buffer payload");
        let readyState = ws.#handler.readyState;
        if (isEstablished(readyState) && !isClosing(readyState) && !isClosed(readyState)) {
          let frame = new WebsocketFrameSend(buffer);
          ws.#handler.socket.write(frame.createFrame(opcodes.PING));
        }
      }
    }, { ping } = WebSocket;
    Reflect.deleteProperty(WebSocket, "ping");
    WebSocket.CONNECTING = WebSocket.prototype.CONNECTING = states.CONNECTING;
    WebSocket.OPEN = WebSocket.prototype.OPEN = states.OPEN;
    WebSocket.CLOSING = WebSocket.prototype.CLOSING = states.CLOSING;
    WebSocket.CLOSED = WebSocket.prototype.CLOSED = states.CLOSED;
    Object.defineProperties(WebSocket.prototype, {
      CONNECTING: staticPropertyDescriptors,
      OPEN: staticPropertyDescriptors,
      CLOSING: staticPropertyDescriptors,
      CLOSED: staticPropertyDescriptors,
      url: kEnumerableProperty,
      readyState: kEnumerableProperty,
      bufferedAmount: kEnumerableProperty,
      onopen: kEnumerableProperty,
      onerror: kEnumerableProperty,
      onclose: kEnumerableProperty,
      close: kEnumerableProperty,
      onmessage: kEnumerableProperty,
      binaryType: kEnumerableProperty,
      send: kEnumerableProperty,
      extensions: kEnumerableProperty,
      protocol: kEnumerableProperty,
      [Symbol.toStringTag]: {
        value: "WebSocket",
        writable: !1,
        enumerable: !1,
        configurable: !0
      }
    });
    Object.defineProperties(WebSocket, {
      CONNECTING: staticPropertyDescriptors,
      OPEN: staticPropertyDescriptors,
      CLOSING: staticPropertyDescriptors,
      CLOSED: staticPropertyDescriptors
    });
    webidl.converters["sequence<DOMString>"] = webidl.sequenceConverter(
      webidl.converters.DOMString
    );
    webidl.converters["DOMString or sequence<DOMString>"] = function(V, prefix, argument) {
      return webidl.util.Type(V) === webidl.util.Types.OBJECT && Symbol.iterator in V ? webidl.converters["sequence<DOMString>"](V) : webidl.converters.DOMString(V, prefix, argument);
    };
    webidl.converters.WebSocketInit = webidl.dictionaryConverter([
      {
        key: "protocols",
        converter: webidl.converters["DOMString or sequence<DOMString>"],
        defaultValue: /* @__PURE__ */ __name(() => [], "defaultValue")
      },
      {
        key: "dispatcher",
        converter: webidl.converters.any,
        defaultValue: /* @__PURE__ */ __name(() => getGlobalDispatcher2(), "defaultValue")
      },
      {
        key: "headers",
        converter: webidl.nullableConverter(webidl.converters.HeadersInit)
      }
    ]);
    webidl.converters["DOMString or sequence<DOMString> or WebSocketInit"] = function(V) {
      return webidl.util.Type(V) === webidl.util.Types.OBJECT && !(Symbol.iterator in V) ? webidl.converters.WebSocketInit(V) : { protocols: webidl.converters["DOMString or sequence<DOMString>"](V) };
    };
    webidl.converters.WebSocketSendData = function(V) {
      return webidl.util.Type(V) === webidl.util.Types.OBJECT && (webidl.is.Blob(V) || webidl.is.BufferSource(V)) ? V : webidl.converters.USVString(V);
    };
    module2.exports = {
      WebSocket,
      ping
    };
  }
});

// lib/web/eventsource/util.js
var require_util4 = __commonJS({
  "lib/web/eventsource/util.js"(exports2, module2) {
    "use strict";
    function isValidLastEventId(value) {
      return value.indexOf("\0") === -1;
    }
    __name(isValidLastEventId, "isValidLastEventId");
    function isASCIINumber(value) {
      if (value.length === 0) return !1;
      for (let i = 0; i < value.length; i++)
        if (value.charCodeAt(i) < 48 || value.charCodeAt(i) > 57) return !1;
      return !0;
    }
    __name(isASCIINumber, "isASCIINumber");
    module2.exports = {
      isValidLastEventId,
      isASCIINumber
    };
  }
});

// lib/web/eventsource/eventsource-stream.js
var require_eventsource_stream = __commonJS({
  "lib/web/eventsource/eventsource-stream.js"(exports2, module2) {
    "use strict";
    var { Transform } = require("node:stream"), { isASCIINumber, isValidLastEventId } = require_util4(), BOM = [239, 187, 191], LF = 10, CR = 13, COLON = 58, SPACE = 32, EventSourceStream = class extends Transform {
      static {
        __name(this, "EventSourceStream");
      }
      /**
       * @type {eventSourceSettings}
       */
      state;
      /**
       * Leading byte-order-mark check.
       * @type {boolean}
       */
      checkBOM = !0;
      /**
       * @type {boolean}
       */
      crlfCheck = !1;
      /**
       * @type {boolean}
       */
      eventEndCheck = !1;
      /**
       * @type {Buffer|null}
       */
      buffer = null;
      pos = 0;
      event = {
        data: void 0,
        event: void 0,
        id: void 0,
        retry: void 0
      };
      /**
       * @param {object} options
       * @param {boolean} [options.readableObjectMode]
       * @param {eventSourceSettings} [options.eventSourceSettings]
       * @param {(chunk: any, encoding?: BufferEncoding | undefined) => boolean} [options.push]
       */
      constructor(options = {}) {
        options.readableObjectMode = !0, super(options), this.state = options.eventSourceSettings || {}, options.push && (this.push = options.push);
      }
      /**
       * @param {Buffer} chunk
       * @param {string} _encoding
       * @param {Function} callback
       * @returns {void}
       */
      _transform(chunk, _encoding, callback) {
        if (chunk.length === 0) {
          callback();
          return;
        }
        if (this.buffer ? this.buffer = Buffer.concat([this.buffer, chunk]) : this.buffer = chunk, this.checkBOM)
          switch (this.buffer.length) {
            case 1:
              if (this.buffer[0] === BOM[0]) {
                callback();
                return;
              }
              this.checkBOM = !1, callback();
              return;
            case 2:
              if (this.buffer[0] === BOM[0] && this.buffer[1] === BOM[1]) {
                callback();
                return;
              }
              this.checkBOM = !1;
              break;
            case 3:
              if (this.buffer[0] === BOM[0] && this.buffer[1] === BOM[1] && this.buffer[2] === BOM[2]) {
                this.buffer = Buffer.alloc(0), this.checkBOM = !1, callback();
                return;
              }
              this.checkBOM = !1;
              break;
            default:
              this.buffer[0] === BOM[0] && this.buffer[1] === BOM[1] && this.buffer[2] === BOM[2] && (this.buffer = this.buffer.subarray(3)), this.checkBOM = !1;
              break;
          }
        for (; this.pos < this.buffer.length; ) {
          if (this.eventEndCheck) {
            if (this.crlfCheck) {
              if (this.buffer[this.pos] === LF) {
                this.buffer = this.buffer.subarray(this.pos + 1), this.pos = 0, this.crlfCheck = !1;
                continue;
              }
              this.crlfCheck = !1;
            }
            if (this.buffer[this.pos] === LF || this.buffer[this.pos] === CR) {
              this.buffer[this.pos] === CR && (this.crlfCheck = !0), this.buffer = this.buffer.subarray(this.pos + 1), this.pos = 0, (this.event.data !== void 0 || this.event.event || this.event.id !== void 0 || this.event.retry) && this.processEvent(this.event), this.clearEvent();
              continue;
            }
            this.eventEndCheck = !1;
            continue;
          }
          if (this.buffer[this.pos] === LF || this.buffer[this.pos] === CR) {
            this.buffer[this.pos] === CR && (this.crlfCheck = !0), this.parseLine(this.buffer.subarray(0, this.pos), this.event), this.buffer = this.buffer.subarray(this.pos + 1), this.pos = 0, this.eventEndCheck = !0;
            continue;
          }
          this.pos++;
        }
        callback();
      }
      /**
       * @param {Buffer} line
       * @param {EventSourceStreamEvent} event
       */
      parseLine(line, event) {
        if (line.length === 0)
          return;
        let colonPosition = line.indexOf(COLON);
        if (colonPosition === 0)
          return;
        let field = "", value = "";
        if (colonPosition !== -1) {
          field = line.subarray(0, colonPosition).toString("utf8");
          let valueStart = colonPosition + 1;
          line[valueStart] === SPACE && ++valueStart, value = line.subarray(valueStart).toString("utf8");
        } else
          field = line.toString("utf8"), value = "";
        switch (field) {
          case "data":
            event[field] === void 0 ? event[field] = value : event[field] += `
${value}`;
            break;
          case "retry":
            isASCIINumber(value) && (event[field] = value);
            break;
          case "id":
            isValidLastEventId(value) && (event[field] = value);
            break;
          case "event":
            value.length > 0 && (event[field] = value);
            break;
        }
      }
      /**
       * @param {EventSourceStreamEvent} event
       */
      processEvent(event) {
        event.retry && isASCIINumber(event.retry) && (this.state.reconnectionTime = parseInt(event.retry, 10)), event.id !== void 0 && isValidLastEventId(event.id) && (this.state.lastEventId = event.id), event.data !== void 0 && this.push({
          type: event.event || "message",
          options: {
            data: event.data,
            lastEventId: this.state.lastEventId,
            origin: this.state.origin
          }
        });
      }
      clearEvent() {
        this.event = {
          data: void 0,
          event: void 0,
          id: void 0,
          retry: void 0
        };
      }
    };
    module2.exports = {
      EventSourceStream
    };
  }
});

// lib/web/eventsource/eventsource.js
var require_eventsource = __commonJS({
  "lib/web/eventsource/eventsource.js"(exports2, module2) {
    "use strict";
    var { pipeline } = require("node:stream"), { fetching } = require_fetch(), { makeRequest } = require_request2(), { webidl } = require_webidl(), { EventSourceStream } = require_eventsource_stream(), { parseMIMEType } = require_data_url(), { createFastMessageEvent: createFastMessageEvent2 } = require_events(), { isNetworkError } = require_response(), { kEnumerableProperty } = require_util(), { environmentSettingsObject } = require_util2(), experimentalWarned = !1, defaultReconnectionTime = 3e3, CONNECTING = 0, OPEN = 1, CLOSED = 2, ANONYMOUS = "anonymous", USE_CREDENTIALS = "use-credentials", EventSource = class _EventSource extends EventTarget {
      static {
        __name(this, "EventSource");
      }
      #events = {
        open: null,
        error: null,
        message: null
      };
      #url;
      #withCredentials = !1;
      /**
       * @type {ReadyState}
       */
      #readyState = CONNECTING;
      #request = null;
      #controller = null;
      #dispatcher;
      /**
       * @type {import('./eventsource-stream').eventSourceSettings}
       */
      #state;
      /**
       * Creates a new EventSource object.
       * @param {string} url
       * @param {EventSourceInit} [eventSourceInitDict={}]
       * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface
       */
      constructor(url, eventSourceInitDict = {}) {
        super(), webidl.util.markAsUncloneable(this);
        let prefix = "EventSource constructor";
        webidl.argumentLengthCheck(arguments, 1, prefix), experimentalWarned || (experimentalWarned = !0, process.emitWarning("EventSource is experimental, expect them to change at any time.", {
          code: "UNDICI-ES"
        })), url = webidl.converters.USVString(url), eventSourceInitDict = webidl.converters.EventSourceInitDict(eventSourceInitDict, prefix, "eventSourceInitDict"), this.#dispatcher = eventSourceInitDict.node.dispatcher || eventSourceInitDict.dispatcher, this.#state = {
          lastEventId: "",
          reconnectionTime: eventSourceInitDict.node.reconnectionTime
        };
        let settings = environmentSettingsObject, urlRecord;
        try {
          urlRecord = new URL(url, settings.settingsObject.baseUrl), this.#state.origin = urlRecord.origin;
        } catch (e) {
          throw new DOMException(e, "SyntaxError");
        }
        this.#url = urlRecord.href;
        let corsAttributeState = ANONYMOUS;
        eventSourceInitDict.withCredentials === !0 && (corsAttributeState = USE_CREDENTIALS, this.#withCredentials = !0);
        let initRequest = {
          redirect: "follow",
          keepalive: !0,
          // @see https://html.spec.whatwg.org/multipage/urls-and-fetching.html#cors-settings-attributes
          mode: "cors",
          credentials: corsAttributeState === "anonymous" ? "same-origin" : "omit",
          referrer: "no-referrer"
        };
        initRequest.client = environmentSettingsObject.settingsObject, initRequest.headersList = [["accept", { name: "accept", value: "text/event-stream" }]], initRequest.cache = "no-store", initRequest.initiator = "other", initRequest.urlList = [new URL(this.#url)], this.#request = makeRequest(initRequest), this.#connect();
      }
      /**
       * Returns the state of this EventSource object's connection. It can have the
       * values described below.
       * @returns {ReadyState}
       * @readonly
       */
      get readyState() {
        return this.#readyState;
      }
      /**
       * Returns the URL providing the event stream.
       * @readonly
       * @returns {string}
       */
      get url() {
        return this.#url;
      }
      /**
       * Returns a boolean indicating whether the EventSource object was
       * instantiated with CORS credentials set (true), or not (false, the default).
       */
      get withCredentials() {
        return this.#withCredentials;
      }
      #connect() {
        if (this.#readyState === CLOSED) return;
        this.#readyState = CONNECTING;
        let fetchParams = {
          request: this.#request,
          dispatcher: this.#dispatcher
        }, processEventSourceEndOfBody = /* @__PURE__ */ __name((response) => {
          if (!isNetworkError(response))
            return this.#reconnect();
        }, "processEventSourceEndOfBody");
        fetchParams.processResponseEndOfBody = processEventSourceEndOfBody, fetchParams.processResponse = (response) => {
          if (isNetworkError(response))
            if (response.aborted) {
              this.close(), this.dispatchEvent(new Event("error"));
              return;
            } else {
              this.#reconnect();
              return;
            }
          let contentType = response.headersList.get("content-type", !0), mimeType = contentType !== null ? parseMIMEType(contentType) : "failure", contentTypeValid = mimeType !== "failure" && mimeType.essence === "text/event-stream";
          if (response.status !== 200 || contentTypeValid === !1) {
            this.close(), this.dispatchEvent(new Event("error"));
            return;
          }
          this.#readyState = OPEN, this.dispatchEvent(new Event("open")), this.#state.origin = response.urlList[response.urlList.length - 1].origin;
          let eventSourceStream = new EventSourceStream({
            eventSourceSettings: this.#state,
            push: /* @__PURE__ */ __name((event) => {
              this.dispatchEvent(createFastMessageEvent2(
                event.type,
                event.options
              ));
            }, "push")
          });
          pipeline(
            response.body.stream,
            eventSourceStream,
            (error) => {
              error?.aborted === !1 && (this.close(), this.dispatchEvent(new Event("error")));
            }
          );
        }, this.#controller = fetching(fetchParams);
      }
      /**
       * @see https://html.spec.whatwg.org/multipage/server-sent-events.html#sse-processing-model
       * @returns {void}
       */
      #reconnect() {
        this.#readyState !== CLOSED && (this.#readyState = CONNECTING, this.dispatchEvent(new Event("error")), setTimeout(() => {
          this.#readyState === CONNECTING && (this.#state.lastEventId.length && this.#request.headersList.set("last-event-id", this.#state.lastEventId, !0), this.#connect());
        }, this.#state.reconnectionTime)?.unref());
      }
      /**
       * Closes the connection, if any, and sets the readyState attribute to
       * CLOSED.
       */
      close() {
        webidl.brandCheck(this, _EventSource), this.#readyState !== CLOSED && (this.#readyState = CLOSED, this.#controller.abort(), this.#request = null);
      }
      get onopen() {
        return this.#events.open;
      }
      set onopen(fn) {
        this.#events.open && this.removeEventListener("open", this.#events.open);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("open", listener), this.#events.open = fn) : this.#events.open = null;
      }
      get onmessage() {
        return this.#events.message;
      }
      set onmessage(fn) {
        this.#events.message && this.removeEventListener("message", this.#events.message);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("message", listener), this.#events.message = fn) : this.#events.message = null;
      }
      get onerror() {
        return this.#events.error;
      }
      set onerror(fn) {
        this.#events.error && this.removeEventListener("error", this.#events.error);
        let listener = webidl.converters.EventHandlerNonNull(fn);
        listener !== null ? (this.addEventListener("error", listener), this.#events.error = fn) : this.#events.error = null;
      }
    }, constantsPropertyDescriptors = {
      CONNECTING: {
        __proto__: null,
        configurable: !1,
        enumerable: !0,
        value: CONNECTING,
        writable: !1
      },
      OPEN: {
        __proto__: null,
        configurable: !1,
        enumerable: !0,
        value: OPEN,
        writable: !1
      },
      CLOSED: {
        __proto__: null,
        configurable: !1,
        enumerable: !0,
        value: CLOSED,
        writable: !1
      }
    };
    Object.defineProperties(EventSource, constantsPropertyDescriptors);
    Object.defineProperties(EventSource.prototype, constantsPropertyDescriptors);
    Object.defineProperties(EventSource.prototype, {
      close: kEnumerableProperty,
      onerror: kEnumerableProperty,
      onmessage: kEnumerableProperty,
      onopen: kEnumerableProperty,
      readyState: kEnumerableProperty,
      url: kEnumerableProperty,
      withCredentials: kEnumerableProperty
    });
    webidl.converters.EventSourceInitDict = webidl.dictionaryConverter([
      {
        key: "withCredentials",
        converter: webidl.converters.boolean,
        defaultValue: /* @__PURE__ */ __name(() => !1, "defaultValue")
      },
      {
        key: "dispatcher",
        // undici only
        converter: webidl.converters.any
      },
      {
        key: "node",
        // undici only
        converter: webidl.dictionaryConverter([
          {
            key: "reconnectionTime",
            converter: webidl.converters["unsigned long"],
            defaultValue: /* @__PURE__ */ __name(() => defaultReconnectionTime, "defaultValue")
          },
          {
            key: "dispatcher",
            converter: webidl.converters.any
          }
        ]),
        defaultValue: /* @__PURE__ */ __name(() => ({}), "defaultValue")
      }
    ]);
    module2.exports = {
      EventSource,
      defaultReconnectionTime
    };
  }
});

// lib/api/readable.js
var require_readable = __commonJS({
  "lib/api/readable.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { Readable } = require("node:stream"), { RequestAbortedError, NotSupportedError, InvalidArgumentError, AbortError } = require_errors(), util = require_util(), { ReadableStreamFrom } = require_util(), kConsume = Symbol("kConsume"), kReading = Symbol("kReading"), kBody = Symbol("kBody"), kAbort = Symbol("kAbort"), kContentType = Symbol("kContentType"), kContentLength = Symbol("kContentLength"), kUsed = Symbol("kUsed"), kBytesRead = Symbol("kBytesRead"), noop = /* @__PURE__ */ __name(() => {
    }, "noop"), BodyReadable = class extends Readable {
      static {
        __name(this, "BodyReadable");
      }
      /**
       * @param {object} opts
       * @param {(this: Readable, size: number) => void} opts.resume
       * @param {() => (void | null)} opts.abort
       * @param {string} [opts.contentType = '']
       * @param {number} [opts.contentLength]
       * @param {number} [opts.highWaterMark = 64 * 1024]
       */
      constructor({
        resume,
        abort,
        contentType = "",
        contentLength,
        highWaterMark = 64 * 1024
        // Same as nodejs fs streams.
      }) {
        super({
          autoDestroy: !0,
          read: resume,
          highWaterMark
        }), this._readableState.dataEmitted = !1, this[kAbort] = abort, this[kConsume] = null, this[kBytesRead] = 0, this[kBody] = null, this[kUsed] = !1, this[kContentType] = contentType, this[kContentLength] = Number.isFinite(contentLength) ? contentLength : null, this[kReading] = !1;
      }
      /**
       * @param {Error|null} err
       * @param {(error:(Error|null)) => void} callback
       * @returns {void}
       */
      _destroy(err, callback) {
        !err && !this._readableState.endEmitted && (err = new RequestAbortedError()), err && this[kAbort](), this[kUsed] ? callback(err) : setImmediate(callback, err);
      }
      /**
       * @param {string|symbol} event
       * @param {(...args: any[]) => void} listener
       * @returns {this}
       */
      on(event, listener) {
        return (event === "data" || event === "readable") && (this[kReading] = !0, this[kUsed] = !0), super.on(event, listener);
      }
      /**
       * @param {string|symbol} event
       * @param {(...args: any[]) => void} listener
       * @returns {this}
       */
      addListener(event, listener) {
        return this.on(event, listener);
      }
      /**
       * @param {string|symbol} event
       * @param {(...args: any[]) => void} listener
       * @returns {this}
       */
      off(event, listener) {
        let ret = super.off(event, listener);
        return (event === "data" || event === "readable") && (this[kReading] = this.listenerCount("data") > 0 || this.listenerCount("readable") > 0), ret;
      }
      /**
       * @param {string|symbol} event
       * @param {(...args: any[]) => void} listener
       * @returns {this}
       */
      removeListener(event, listener) {
        return this.off(event, listener);
      }
      /**
       * @param {Buffer|null} chunk
       * @returns {boolean}
       */
      push(chunk) {
        return chunk && (this[kBytesRead] += chunk.length, this[kConsume]) ? (consumePush(this[kConsume], chunk), this[kReading] ? super.push(chunk) : !0) : super.push(chunk);
      }
      /**
       * Consumes and returns the body as a string.
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-text
       * @returns {Promise<string>}
       */
      text() {
        return consume(this, "text");
      }
      /**
       * Consumes and returns the body as a JavaScript Object.
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-json
       * @returns {Promise<unknown>}
       */
      json() {
        return consume(this, "json");
      }
      /**
       * Consumes and returns the body as a Blob
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-blob
       * @returns {Promise<Blob>}
       */
      blob() {
        return consume(this, "blob");
      }
      /**
       * Consumes and returns the body as an Uint8Array.
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-bytes
       * @returns {Promise<Uint8Array>}
       */
      bytes() {
        return consume(this, "bytes");
      }
      /**
       * Consumes and returns the body as an ArrayBuffer.
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-arraybuffer
       * @returns {Promise<ArrayBuffer>}
       */
      arrayBuffer() {
        return consume(this, "arrayBuffer");
      }
      /**
       * Not implemented
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-formdata
       * @throws {NotSupportedError}
       */
      async formData() {
        throw new NotSupportedError();
      }
      /**
       * Returns true if the body is not null and the body has been consumed.
       * Otherwise, returns false.
       *
       * @see https://fetch.spec.whatwg.org/#dom-body-bodyused
       * @readonly
       * @returns {boolean}
       */
      get bodyUsed() {
        return util.isDisturbed(this);
      }
      /**
       * @see https://fetch.spec.whatwg.org/#dom-body-body
       * @readonly
       * @returns {ReadableStream}
       */
      get body() {
        return this[kBody] || (this[kBody] = ReadableStreamFrom(this), this[kConsume] && (this[kBody].getReader(), assert(this[kBody].locked))), this[kBody];
      }
      /**
       * Dumps the response body by reading `limit` number of bytes.
       * @param {object} opts
       * @param {number} [opts.limit = 131072] Number of bytes to read.
       * @param {AbortSignal} [opts.signal] An AbortSignal to cancel the dump.
       * @returns {Promise<null>}
       */
      dump(opts) {
        let signal = opts?.signal;
        if (signal != null && (typeof signal != "object" || !("aborted" in signal)))
          return Promise.reject(new InvalidArgumentError("signal must be an AbortSignal"));
        let limit = opts?.limit && Number.isFinite(opts.limit) ? opts.limit : 128 * 1024;
        return signal?.aborted ? Promise.reject(signal.reason ?? new AbortError()) : this._readableState.closeEmitted ? Promise.resolve(null) : new Promise((resolve, reject) => {
          if ((this[kContentLength] && this[kContentLength] > limit || this[kBytesRead] > limit) && this.destroy(new AbortError()), signal) {
            let onAbort = /* @__PURE__ */ __name(() => {
              this.destroy(signal.reason ?? new AbortError());
            }, "onAbort");
            signal.addEventListener("abort", onAbort), this.on("close", function() {
              signal.removeEventListener("abort", onAbort), signal.aborted ? reject(signal.reason ?? new AbortError()) : resolve(null);
            });
          } else
            this.on("close", resolve);
          this.on("error", noop).on("data", () => {
            this[kBytesRead] > limit && this.destroy();
          }).resume();
        });
      }
      /**
       * @param {BufferEncoding} encoding
       * @returns {this}
       */
      setEncoding(encoding) {
        return Buffer.isEncoding(encoding) && (this._readableState.encoding = encoding), this;
      }
    };
    function isLocked(bodyReadable) {
      return bodyReadable[kBody]?.locked === !0 || bodyReadable[kConsume] !== null;
    }
    __name(isLocked, "isLocked");
    function isUnusable(bodyReadable) {
      return util.isDisturbed(bodyReadable) || isLocked(bodyReadable);
    }
    __name(isUnusable, "isUnusable");
    function consume(stream, type) {
      return assert(!stream[kConsume]), new Promise((resolve, reject) => {
        if (isUnusable(stream)) {
          let rState = stream._readableState;
          rState.destroyed && rState.closeEmitted === !1 ? stream.on("error", reject).on("close", () => {
            reject(new TypeError("unusable"));
          }) : reject(rState.errored ?? new TypeError("unusable"));
        } else
          queueMicrotask(() => {
            stream[kConsume] = {
              type,
              stream,
              resolve,
              reject,
              length: 0,
              body: []
            }, stream.on("error", function(err) {
              consumeFinish(this[kConsume], err);
            }).on("close", function() {
              this[kConsume].body !== null && consumeFinish(this[kConsume], new RequestAbortedError());
            }), consumeStart(stream[kConsume]);
          });
      });
    }
    __name(consume, "consume");
    function consumeStart(consume2) {
      if (consume2.body === null)
        return;
      let { _readableState: state } = consume2.stream;
      if (state.bufferIndex) {
        let start = state.bufferIndex, end = state.buffer.length;
        for (let n = start; n < end; n++)
          consumePush(consume2, state.buffer[n]);
      } else
        for (let chunk of state.buffer)
          consumePush(consume2, chunk);
      for (state.endEmitted ? consumeEnd(this[kConsume], this._readableState.encoding) : consume2.stream.on("end", function() {
        consumeEnd(this[kConsume], this._readableState.encoding);
      }), consume2.stream.resume(); consume2.stream.read() != null; )
        ;
    }
    __name(consumeStart, "consumeStart");
    function chunksDecode(chunks, length, encoding) {
      if (chunks.length === 0 || length === 0)
        return "";
      let buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length), bufferLength = buffer.length, start = bufferLength > 2 && buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191 ? 3 : 0;
      return !encoding || encoding === "utf8" || encoding === "utf-8" ? buffer.utf8Slice(start, bufferLength) : buffer.subarray(start, bufferLength).toString(encoding);
    }
    __name(chunksDecode, "chunksDecode");
    function chunksConcat(chunks, length) {
      if (chunks.length === 0 || length === 0)
        return new Uint8Array(0);
      if (chunks.length === 1)
        return new Uint8Array(chunks[0]);
      let buffer = new Uint8Array(Buffer.allocUnsafeSlow(length).buffer), offset = 0;
      for (let i = 0; i < chunks.length; ++i) {
        let chunk = chunks[i];
        buffer.set(chunk, offset), offset += chunk.length;
      }
      return buffer;
    }
    __name(chunksConcat, "chunksConcat");
    function consumeEnd(consume2, encoding) {
      let { type, body, resolve, stream, length } = consume2;
      try {
        type === "text" ? resolve(chunksDecode(body, length, encoding)) : type === "json" ? resolve(JSON.parse(chunksDecode(body, length, encoding))) : type === "arrayBuffer" ? resolve(chunksConcat(body, length).buffer) : type === "blob" ? resolve(new Blob(body, { type: stream[kContentType] })) : type === "bytes" && resolve(chunksConcat(body, length)), consumeFinish(consume2);
      } catch (err) {
        stream.destroy(err);
      }
    }
    __name(consumeEnd, "consumeEnd");
    function consumePush(consume2, chunk) {
      consume2.length += chunk.length, consume2.body.push(chunk);
    }
    __name(consumePush, "consumePush");
    function consumeFinish(consume2, err) {
      consume2.body !== null && (err ? consume2.reject(err) : consume2.resolve(), consume2.type = null, consume2.stream = null, consume2.resolve = null, consume2.reject = null, consume2.length = 0, consume2.body = null);
    }
    __name(consumeFinish, "consumeFinish");
    module2.exports = {
      Readable: BodyReadable,
      chunksDecode
    };
  }
});

// lib/api/api-request.js
var require_api_request = __commonJS({
  "lib/api/api-request.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { AsyncResource } = require("node:async_hooks"), { Readable } = require_readable(), { InvalidArgumentError, RequestAbortedError } = require_errors(), util = require_util();
    function noop() {
    }
    __name(noop, "noop");
    var RequestHandler = class extends AsyncResource {
      static {
        __name(this, "RequestHandler");
      }
      constructor(opts, callback) {
        if (!opts || typeof opts != "object")
          throw new InvalidArgumentError("invalid opts");
        let { signal, method, opaque, body, onInfo, responseHeaders, highWaterMark } = opts;
        try {
          if (typeof callback != "function")
            throw new InvalidArgumentError("invalid callback");
          if (highWaterMark && (typeof highWaterMark != "number" || highWaterMark < 0))
            throw new InvalidArgumentError("invalid highWaterMark");
          if (signal && typeof signal.on != "function" && typeof signal.addEventListener != "function")
            throw new InvalidArgumentError("signal must be an EventEmitter or EventTarget");
          if (method === "CONNECT")
            throw new InvalidArgumentError("invalid method");
          if (onInfo && typeof onInfo != "function")
            throw new InvalidArgumentError("invalid onInfo callback");
          super("UNDICI_REQUEST");
        } catch (err) {
          throw util.isStream(body) && util.destroy(body.on("error", noop), err), err;
        }
        this.method = method, this.responseHeaders = responseHeaders || null, this.opaque = opaque || null, this.callback = callback, this.res = null, this.abort = null, this.body = body, this.trailers = {}, this.context = null, this.onInfo = onInfo || null, this.highWaterMark = highWaterMark, this.reason = null, this.removeAbortListener = null, signal?.aborted ? this.reason = signal.reason ?? new RequestAbortedError() : signal && (this.removeAbortListener = util.addAbortListener(signal, () => {
          this.reason = signal.reason ?? new RequestAbortedError(), this.res ? util.destroy(this.res.on("error", noop), this.reason) : this.abort && this.abort(this.reason);
        }));
      }
      onConnect(abort, context) {
        if (this.reason) {
          abort(this.reason);
          return;
        }
        assert(this.callback), this.abort = abort, this.context = context;
      }
      onHeaders(statusCode, rawHeaders, resume, statusMessage) {
        let { callback, opaque, abort, context, responseHeaders, highWaterMark } = this, headers = responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders);
        if (statusCode < 200) {
          this.onInfo && this.onInfo({ statusCode, headers });
          return;
        }
        let parsedHeaders = responseHeaders === "raw" ? util.parseHeaders(rawHeaders) : headers, contentType = parsedHeaders["content-type"], contentLength = parsedHeaders["content-length"], res = new Readable({
          resume,
          abort,
          contentType,
          contentLength: this.method !== "HEAD" && contentLength ? Number(contentLength) : null,
          highWaterMark
        });
        if (this.removeAbortListener && (res.on("close", this.removeAbortListener), this.removeAbortListener = null), this.callback = null, this.res = res, callback !== null)
          try {
            this.runInAsyncScope(callback, null, null, {
              statusCode,
              headers,
              trailers: this.trailers,
              opaque,
              body: res,
              context
            });
          } catch (err) {
            this.res = null, util.destroy(res.on("error", noop), err), queueMicrotask(() => {
              throw err;
            });
          }
      }
      onData(chunk) {
        return this.res.push(chunk);
      }
      onComplete(trailers) {
        util.parseHeaders(trailers, this.trailers), this.res.push(null);
      }
      onError(err) {
        let { res, callback, body, opaque } = this;
        callback && (this.callback = null, queueMicrotask(() => {
          this.runInAsyncScope(callback, null, err, { opaque });
        })), res && (this.res = null, queueMicrotask(() => {
          util.destroy(res.on("error", noop), err);
        })), body && (this.body = null, util.isStream(body) && (body.on("error", noop), util.destroy(body, err))), this.removeAbortListener && (this.removeAbortListener(), this.removeAbortListener = null);
      }
    };
    function request(opts, callback) {
      if (callback === void 0)
        return new Promise((resolve, reject) => {
          request.call(this, opts, (err, data) => err ? reject(err) : resolve(data));
        });
      try {
        let handler = new RequestHandler(opts, callback);
        this.dispatch(opts, handler);
      } catch (err) {
        if (typeof callback != "function")
          throw err;
        let opaque = opts?.opaque;
        queueMicrotask(() => callback(err, { opaque }));
      }
    }
    __name(request, "request");
    module2.exports = request;
    module2.exports.RequestHandler = RequestHandler;
  }
});

// lib/api/abort-signal.js
var require_abort_signal = __commonJS({
  "lib/api/abort-signal.js"(exports2, module2) {
    "use strict";
    var { addAbortListener } = require_util(), { RequestAbortedError } = require_errors(), kListener = Symbol("kListener"), kSignal = Symbol("kSignal");
    function abort(self) {
      self.abort ? self.abort(self[kSignal]?.reason) : self.reason = self[kSignal]?.reason ?? new RequestAbortedError(), removeSignal(self);
    }
    __name(abort, "abort");
    function addSignal(self, signal) {
      if (self.reason = null, self[kSignal] = null, self[kListener] = null, !!signal) {
        if (signal.aborted) {
          abort(self);
          return;
        }
        self[kSignal] = signal, self[kListener] = () => {
          abort(self);
        }, addAbortListener(self[kSignal], self[kListener]);
      }
    }
    __name(addSignal, "addSignal");
    function removeSignal(self) {
      self[kSignal] && ("removeEventListener" in self[kSignal] ? self[kSignal].removeEventListener("abort", self[kListener]) : self[kSignal].removeListener("abort", self[kListener]), self[kSignal] = null, self[kListener] = null);
    }
    __name(removeSignal, "removeSignal");
    module2.exports = {
      addSignal,
      removeSignal
    };
  }
});

// lib/api/api-stream.js
var require_api_stream = __commonJS({
  "lib/api/api-stream.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { finished } = require("node:stream"), { AsyncResource } = require("node:async_hooks"), { InvalidArgumentError, InvalidReturnValueError } = require_errors(), util = require_util(), { addSignal, removeSignal } = require_abort_signal();
    function noop() {
    }
    __name(noop, "noop");
    var StreamHandler = class extends AsyncResource {
      static {
        __name(this, "StreamHandler");
      }
      constructor(opts, factory, callback) {
        if (!opts || typeof opts != "object")
          throw new InvalidArgumentError("invalid opts");
        let { signal, method, opaque, body, onInfo, responseHeaders } = opts;
        try {
          if (typeof callback != "function")
            throw new InvalidArgumentError("invalid callback");
          if (typeof factory != "function")
            throw new InvalidArgumentError("invalid factory");
          if (signal && typeof signal.on != "function" && typeof signal.addEventListener != "function")
            throw new InvalidArgumentError("signal must be an EventEmitter or EventTarget");
          if (method === "CONNECT")
            throw new InvalidArgumentError("invalid method");
          if (onInfo && typeof onInfo != "function")
            throw new InvalidArgumentError("invalid onInfo callback");
          super("UNDICI_STREAM");
        } catch (err) {
          throw util.isStream(body) && util.destroy(body.on("error", noop), err), err;
        }
        this.responseHeaders = responseHeaders || null, this.opaque = opaque || null, this.factory = factory, this.callback = callback, this.res = null, this.abort = null, this.context = null, this.trailers = null, this.body = body, this.onInfo = onInfo || null, util.isStream(body) && body.on("error", (err) => {
          this.onError(err);
        }), addSignal(this, signal);
      }
      onConnect(abort, context) {
        if (this.reason) {
          abort(this.reason);
          return;
        }
        assert(this.callback), this.abort = abort, this.context = context;
      }
      onHeaders(statusCode, rawHeaders, resume, statusMessage) {
        let { factory, opaque, context, responseHeaders } = this, headers = responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders);
        if (statusCode < 200) {
          this.onInfo && this.onInfo({ statusCode, headers });
          return;
        }
        if (this.factory = null, factory === null)
          return;
        let res = this.runInAsyncScope(factory, null, {
          statusCode,
          headers,
          opaque,
          context
        });
        if (!res || typeof res.write != "function" || typeof res.end != "function" || typeof res.on != "function")
          throw new InvalidReturnValueError("expected Writable");
        return finished(res, { readable: !1 }, (err) => {
          let { callback, res: res2, opaque: opaque2, trailers, abort } = this;
          this.res = null, (err || !res2?.readable) && util.destroy(res2, err), this.callback = null, this.runInAsyncScope(callback, null, err || null, { opaque: opaque2, trailers }), err && abort();
        }), res.on("drain", resume), this.res = res, (res.writableNeedDrain !== void 0 ? res.writableNeedDrain : res._writableState?.needDrain) !== !0;
      }
      onData(chunk) {
        let { res } = this;
        return res ? res.write(chunk) : !0;
      }
      onComplete(trailers) {
        let { res } = this;
        removeSignal(this), res && (this.trailers = util.parseHeaders(trailers), res.end());
      }
      onError(err) {
        let { res, callback, opaque, body } = this;
        removeSignal(this), this.factory = null, res ? (this.res = null, util.destroy(res, err)) : callback && (this.callback = null, queueMicrotask(() => {
          this.runInAsyncScope(callback, null, err, { opaque });
        })), body && (this.body = null, util.destroy(body, err));
      }
    };
    function stream(opts, factory, callback) {
      if (callback === void 0)
        return new Promise((resolve, reject) => {
          stream.call(this, opts, factory, (err, data) => err ? reject(err) : resolve(data));
        });
      try {
        let handler = new StreamHandler(opts, factory, callback);
        this.dispatch(opts, handler);
      } catch (err) {
        if (typeof callback != "function")
          throw err;
        let opaque = opts?.opaque;
        queueMicrotask(() => callback(err, { opaque }));
      }
    }
    __name(stream, "stream");
    module2.exports = stream;
  }
});

// lib/api/api-pipeline.js
var require_api_pipeline = __commonJS({
  "lib/api/api-pipeline.js"(exports2, module2) {
    "use strict";
    var {
      Readable,
      Duplex,
      PassThrough
    } = require("node:stream"), assert = require("node:assert"), { AsyncResource } = require("node:async_hooks"), {
      InvalidArgumentError,
      InvalidReturnValueError,
      RequestAbortedError
    } = require_errors(), util = require_util(), { addSignal, removeSignal } = require_abort_signal();
    function noop() {
    }
    __name(noop, "noop");
    var kResume = Symbol("resume"), PipelineRequest = class extends Readable {
      static {
        __name(this, "PipelineRequest");
      }
      constructor() {
        super({ autoDestroy: !0 }), this[kResume] = null;
      }
      _read() {
        let { [kResume]: resume } = this;
        resume && (this[kResume] = null, resume());
      }
      _destroy(err, callback) {
        this._read(), callback(err);
      }
    }, PipelineResponse = class extends Readable {
      static {
        __name(this, "PipelineResponse");
      }
      constructor(resume) {
        super({ autoDestroy: !0 }), this[kResume] = resume;
      }
      _read() {
        this[kResume]();
      }
      _destroy(err, callback) {
        !err && !this._readableState.endEmitted && (err = new RequestAbortedError()), callback(err);
      }
    }, PipelineHandler = class extends AsyncResource {
      static {
        __name(this, "PipelineHandler");
      }
      constructor(opts, handler) {
        if (!opts || typeof opts != "object")
          throw new InvalidArgumentError("invalid opts");
        if (typeof handler != "function")
          throw new InvalidArgumentError("invalid handler");
        let { signal, method, opaque, onInfo, responseHeaders } = opts;
        if (signal && typeof signal.on != "function" && typeof signal.addEventListener != "function")
          throw new InvalidArgumentError("signal must be an EventEmitter or EventTarget");
        if (method === "CONNECT")
          throw new InvalidArgumentError("invalid method");
        if (onInfo && typeof onInfo != "function")
          throw new InvalidArgumentError("invalid onInfo callback");
        super("UNDICI_PIPELINE"), this.opaque = opaque || null, this.responseHeaders = responseHeaders || null, this.handler = handler, this.abort = null, this.context = null, this.onInfo = onInfo || null, this.req = new PipelineRequest().on("error", noop), this.ret = new Duplex({
          readableObjectMode: opts.objectMode,
          autoDestroy: !0,
          read: /* @__PURE__ */ __name(() => {
            let { body } = this;
            body?.resume && body.resume();
          }, "read"),
          write: /* @__PURE__ */ __name((chunk, encoding, callback) => {
            let { req } = this;
            req.push(chunk, encoding) || req._readableState.destroyed ? callback() : req[kResume] = callback;
          }, "write"),
          destroy: /* @__PURE__ */ __name((err, callback) => {
            let { body, req, res, ret, abort } = this;
            !err && !ret._readableState.endEmitted && (err = new RequestAbortedError()), abort && err && abort(), util.destroy(body, err), util.destroy(req, err), util.destroy(res, err), removeSignal(this), callback(err);
          }, "destroy")
        }).on("prefinish", () => {
          let { req } = this;
          req.push(null);
        }), this.res = null, addSignal(this, signal);
      }
      onConnect(abort, context) {
        let { res } = this;
        if (this.reason) {
          abort(this.reason);
          return;
        }
        assert(!res, "pipeline cannot be retried"), this.abort = abort, this.context = context;
      }
      onHeaders(statusCode, rawHeaders, resume) {
        let { opaque, handler, context } = this;
        if (statusCode < 200) {
          if (this.onInfo) {
            let headers = this.responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders);
            this.onInfo({ statusCode, headers });
          }
          return;
        }
        this.res = new PipelineResponse(resume);
        let body;
        try {
          this.handler = null;
          let headers = this.responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders);
          body = this.runInAsyncScope(handler, null, {
            statusCode,
            headers,
            opaque,
            body: this.res,
            context
          });
        } catch (err) {
          throw this.res.on("error", noop), err;
        }
        if (!body || typeof body.on != "function")
          throw new InvalidReturnValueError("expected Readable");
        body.on("data", (chunk) => {
          let { ret, body: body2 } = this;
          !ret.push(chunk) && body2.pause && body2.pause();
        }).on("error", (err) => {
          let { ret } = this;
          util.destroy(ret, err);
        }).on("end", () => {
          let { ret } = this;
          ret.push(null);
        }).on("close", () => {
          let { ret } = this;
          ret._readableState.ended || util.destroy(ret, new RequestAbortedError());
        }), this.body = body;
      }
      onData(chunk) {
        let { res } = this;
        return res.push(chunk);
      }
      onComplete(trailers) {
        let { res } = this;
        res.push(null);
      }
      onError(err) {
        let { ret } = this;
        this.handler = null, util.destroy(ret, err);
      }
    };
    function pipeline(opts, handler) {
      try {
        let pipelineHandler = new PipelineHandler(opts, handler);
        return this.dispatch({ ...opts, body: pipelineHandler.req }, pipelineHandler), pipelineHandler.ret;
      } catch (err) {
        return new PassThrough().destroy(err);
      }
    }
    __name(pipeline, "pipeline");
    module2.exports = pipeline;
  }
});

// lib/api/api-upgrade.js
var require_api_upgrade = __commonJS({
  "lib/api/api-upgrade.js"(exports2, module2) {
    "use strict";
    var { InvalidArgumentError, SocketError } = require_errors(), { AsyncResource } = require("node:async_hooks"), assert = require("node:assert"), util = require_util(), { kHTTP2Stream } = require_symbols(), { addSignal, removeSignal } = require_abort_signal(), UpgradeHandler = class extends AsyncResource {
      static {
        __name(this, "UpgradeHandler");
      }
      constructor(opts, callback) {
        if (!opts || typeof opts != "object")
          throw new InvalidArgumentError("invalid opts");
        if (typeof callback != "function")
          throw new InvalidArgumentError("invalid callback");
        let { signal, opaque, responseHeaders } = opts;
        if (signal && typeof signal.on != "function" && typeof signal.addEventListener != "function")
          throw new InvalidArgumentError("signal must be an EventEmitter or EventTarget");
        super("UNDICI_UPGRADE"), this.responseHeaders = responseHeaders || null, this.opaque = opaque || null, this.callback = callback, this.abort = null, this.context = null, addSignal(this, signal);
      }
      onConnect(abort, context) {
        if (this.reason) {
          abort(this.reason);
          return;
        }
        assert(this.callback), this.abort = abort, this.context = null;
      }
      onHeaders() {
        throw new SocketError("bad upgrade", null);
      }
      onUpgrade(statusCode, rawHeaders, socket) {
        assert(socket[kHTTP2Stream] === !0 ? statusCode === 200 : statusCode === 101);
        let { callback, opaque, context } = this;
        removeSignal(this), this.callback = null;
        let headers = this.responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders);
        this.runInAsyncScope(callback, null, null, {
          headers,
          socket,
          opaque,
          context
        });
      }
      onError(err) {
        let { callback, opaque } = this;
        removeSignal(this), callback && (this.callback = null, queueMicrotask(() => {
          this.runInAsyncScope(callback, null, err, { opaque });
        }));
      }
    };
    function upgrade(opts, callback) {
      if (callback === void 0)
        return new Promise((resolve, reject) => {
          upgrade.call(this, opts, (err, data) => err ? reject(err) : resolve(data));
        });
      try {
        let upgradeHandler = new UpgradeHandler(opts, callback), upgradeOpts = {
          ...opts,
          method: opts.method || "GET",
          upgrade: opts.protocol || "Websocket"
        };
        this.dispatch(upgradeOpts, upgradeHandler);
      } catch (err) {
        if (typeof callback != "function")
          throw err;
        let opaque = opts?.opaque;
        queueMicrotask(() => callback(err, { opaque }));
      }
    }
    __name(upgrade, "upgrade");
    module2.exports = upgrade;
  }
});

// lib/api/api-connect.js
var require_api_connect = __commonJS({
  "lib/api/api-connect.js"(exports2, module2) {
    "use strict";
    var assert = require("node:assert"), { AsyncResource } = require("node:async_hooks"), { InvalidArgumentError, SocketError } = require_errors(), util = require_util(), { addSignal, removeSignal } = require_abort_signal(), ConnectHandler = class extends AsyncResource {
      static {
        __name(this, "ConnectHandler");
      }
      constructor(opts, callback) {
        if (!opts || typeof opts != "object")
          throw new InvalidArgumentError("invalid opts");
        if (typeof callback != "function")
          throw new InvalidArgumentError("invalid callback");
        let { signal, opaque, responseHeaders } = opts;
        if (signal && typeof signal.on != "function" && typeof signal.addEventListener != "function")
          throw new InvalidArgumentError("signal must be an EventEmitter or EventTarget");
        super("UNDICI_CONNECT"), this.opaque = opaque || null, this.responseHeaders = responseHeaders || null, this.callback = callback, this.abort = null, addSignal(this, signal);
      }
      onConnect(abort, context) {
        if (this.reason) {
          abort(this.reason);
          return;
        }
        assert(this.callback), this.abort = abort, this.context = context;
      }
      onHeaders() {
        throw new SocketError("bad connect", null);
      }
      onUpgrade(statusCode, rawHeaders, socket) {
        let { callback, opaque, context } = this;
        removeSignal(this), this.callback = null;
        let headers = rawHeaders;
        headers != null && (headers = this.responseHeaders === "raw" ? util.parseRawHeaders(rawHeaders) : util.parseHeaders(rawHeaders)), this.runInAsyncScope(callback, null, null, {
          statusCode,
          headers,
          socket,
          opaque,
          context
        });
      }
      onError(err) {
        let { callback, opaque } = this;
        removeSignal(this), callback && (this.callback = null, queueMicrotask(() => {
          this.runInAsyncScope(callback, null, err, { opaque });
        }));
      }
    };
    function connect(opts, callback) {
      if (callback === void 0)
        return new Promise((resolve, reject) => {
          connect.call(this, opts, (err, data) => err ? reject(err) : resolve(data));
        });
      try {
        let connectHandler = new ConnectHandler(opts, callback), connectOptions = { ...opts, method: "CONNECT" };
        this.dispatch(connectOptions, connectHandler);
      } catch (err) {
        if (typeof callback != "function")
          throw err;
        let opaque = opts?.opaque;
        queueMicrotask(() => callback(err, { opaque }));
      }
    }
    __name(connect, "connect");
    module2.exports = connect;
  }
});

// lib/api/index.js
var require_api = __commonJS({
  "lib/api/index.js"(exports2, module2) {
    "use strict";
    module2.exports.request = require_api_request();
    module2.exports.stream = require_api_stream();
    module2.exports.pipeline = require_api_pipeline();
    module2.exports.upgrade = require_api_upgrade();
    module2.exports.connect = require_api_connect();
  }
});

// index-fetch.js
var { getGlobalDispatcher, setGlobalDispatcher } = require_global2(), EnvHttpProxyAgent = require_env_http_proxy_agent(), fetchImpl = require_fetch().fetch;
module.exports.fetch = /* @__PURE__ */ __name(function(init, options = void 0) {
  return fetchImpl(init, options).catch((err) => {
    throw err && typeof err == "object" && Error.captureStackTrace(err), err;
  });
}, "fetch");
module.exports.FormData = require_formdata().FormData;
module.exports.Headers = require_headers().Headers;
module.exports.Response = require_response().Response;
module.exports.Request = require_request2().Request;
var { CloseEvent, ErrorEvent, MessageEvent, createFastMessageEvent } = require_events();
module.exports.WebSocket = require_websocket().WebSocket;
module.exports.CloseEvent = CloseEvent;
module.exports.ErrorEvent = ErrorEvent;
module.exports.MessageEvent = MessageEvent;
module.exports.createFastMessageEvent = createFastMessageEvent;
module.exports.EventSource = require_eventsource().EventSource;
var api = require_api(), Dispatcher = require_dispatcher();
Object.assign(Dispatcher.prototype, api);
module.exports.EnvHttpProxyAgent = EnvHttpProxyAgent;
module.exports.getGlobalDispatcher = getGlobalDispatcher;
module.exports.setGlobalDispatcher = setGlobalDispatcher;
/*! formdata-polyfill. MIT License. Jimmy Wärting <https://jimmy.warting.se/opensource> */
/*! ws. MIT License. Einar Otto Stangvik <einaros@gmail.com> */

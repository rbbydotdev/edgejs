'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Buffer } = require('node:buffer');
const { inspect } = require('node:util');

let EventTargetImpl = globalThis.EventTarget;
let EventImpl = globalThis.Event;
try {
  const eventTarget = require('internal/event_target');
  EventTargetImpl = EventTargetImpl || eventTarget.EventTarget;
  EventImpl = EventImpl || eventTarget.Event;
} catch {}

class SimpleEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class SimpleEventTarget {
  constructor() {
    this.__edgeListeners = Object.create(null);
  }
  addEventListener(type, listener) {
    if (listener == null) return;
    type = String(type);
    (this.__edgeListeners[type] ||= new Set()).add(listener);
  }
  removeEventListener(type, listener) {
    const listeners = this.__edgeListeners[String(type)];
    if (listeners) listeners.delete(listener);
  }
  dispatchEvent(event) {
    if (!event || typeof event.type !== 'string') {
      throw new TypeError('Invalid event');
    }
    try {
      event.target ??= this;
      event.currentTarget = this;
    } catch {}
    const handler = this[`on${event.type}`];
    if (typeof handler === 'function') {
      handler.call(this, event);
    }
    const listeners = this.__edgeListeners[event.type];
    if (listeners) {
      for (const listener of Array.from(listeners)) {
        if (typeof listener === 'function') {
          listener.call(this, event);
        } else if (listener && typeof listener.handleEvent === 'function') {
          listener.handleEvent(event);
        }
      }
    }
    return !event.defaultPrevented;
  }
}

EventImpl ||= SimpleEvent;
EventTargetImpl ||= SimpleEventTarget;

function queue(fn) {
  if (typeof queueMicrotask === 'function') queueMicrotask(fn);
  else Promise.resolve().then(fn);
}

function fire(target, event) {
  queue(() => target.dispatchEvent(event));
}

class MessageEvent extends EventImpl {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data ?? null;
    this.origin = init.origin ?? '';
    this.lastEventId = init.lastEventId ?? '';
    this.source = init.source ?? null;
    this.ports = Object.freeze(init.ports ?? []);
  }
  initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = '', lastEventId = '', source = null, ports = []) {
    return new MessageEvent(type, { bubbles, cancelable, data, origin, lastEventId, source, ports });
  }
}

class CloseEvent extends EventImpl {
  constructor(type, init = {}) {
    super(type, init);
    this.wasClean = !!init.wasClean;
    this.code = init.code ?? 0;
    this.reason = init.reason ?? '';
  }
}

class ErrorEvent extends EventImpl {
  constructor(type, init = {}) {
    super(type, init);
    this.message = init.message ?? '';
    this.filename = init.filename ?? '';
    this.lineno = init.lineno ?? 0;
    this.colno = init.colno ?? 0;
    this.error = init.error;
  }
}

Object.defineProperty(MessageEvent.prototype, Symbol.toStringTag, { value: 'MessageEvent', configurable: true });
Object.defineProperty(CloseEvent.prototype, Symbol.toStringTag, { value: 'CloseEvent', configurable: true });
Object.defineProperty(ErrorEvent.prototype, Symbol.toStringTag, { value: 'ErrorEvent', configurable: true });

function createFastMessageEvent(type, init) {
  return new MessageEvent(type, init);
}

const forbiddenHeaderNameChars = '()<>@,;:\\"/[]?={} \t';
function hasForbiddenHeaderNameChar(name) {
  for (let i = 0; i < name.length; i++) {
    if (forbiddenHeaderNameChars.includes(name[i])) return true;
  }
  return false;
}
function normalizeHeaderName(name) {
  name = String(name);
  if (name === '' || hasForbiddenHeaderNameChar(name) || /[\0-\x1f\x7f]/.test(name)) {
    throw new TypeError(`Invalid header name: ${name}`);
  }
  return name.toLowerCase();
}

function normalizeHeaderValue(value) {
  value = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  if (/[\0\r\n]/.test(value)) throw new TypeError(`Invalid header value: ${value}`);
  return value;
}

class Headers {
  constructor(init = undefined) {
    this.__headers = new Map();
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      for (const [name, value] of init) this.append(name, value);
    } else if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        if (!pair || pair.length !== 2) {
          throw new TypeError('Headers constructor: expected name/value pair to be length 2');
        }
        this.append(pair[0], pair[1]);
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) this.append(key, init[key]);
    } else {
      throw new TypeError('Headers constructor: invalid initializer');
    }
  }
  append(name, value) {
    const lower = normalizeHeaderName(name);
    value = normalizeHeaderValue(value);
    const entry = this.__headers.get(lower);
    if (entry) {
      entry.values.push(value);
    } else {
      this.__headers.set(lower, { name: String(name).toLowerCase(), values: [value] });
    }
  }
  delete(name) {
    this.__headers.delete(normalizeHeaderName(name));
  }
  get(name) {
    const entry = this.__headers.get(normalizeHeaderName(name));
    if (!entry) return null;
    return entry.values.join(', ');
  }
  getSetCookie() {
    const entry = this.__headers.get('set-cookie');
    return entry ? [...entry.values] : [];
  }
  has(name) {
    return this.__headers.has(normalizeHeaderName(name));
  }
  set(name, value) {
    const lower = normalizeHeaderName(name);
    this.__headers.set(lower, { name: String(name).toLowerCase(), values: [normalizeHeaderValue(value)] });
  }
  forEach(callback, thisArg = undefined) {
    for (const [name, value] of this) callback.call(thisArg, value, name, this);
  }
  *entries() {
    const entries = Array.from(this.__headers.values()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name === 'set-cookie') {
        for (const value of entry.values) yield [entry.name, value];
      } else {
        yield [entry.name, entry.values.join(', ')];
      }
    }
  }
  *keys() {
    for (const [name] of this) yield name;
  }
  *values() {
    for (const [, value] of this) yield value;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });

function headersToObject(headers) {
  const out = Object.create(null);
  for (const [name, value] of headers) out[name] = value;
  return out;
}

function headersFromRaw(rawHeaders) {
  const headers = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    headers.append(rawHeaders[i], rawHeaders[i + 1]);
  }
  return headers;
}

class FormData {
  constructor() {
    this.__entries = [];
  }
  append(name, value, filename = undefined) {
    this.__entries.push([String(name), value, filename]);
  }
  delete(name) {
    name = String(name);
    this.__entries = this.__entries.filter((entry) => entry[0] !== name);
  }
  get(name) {
    name = String(name);
    const found = this.__entries.find((entry) => entry[0] === name);
    return found ? found[1] : null;
  }
  getAll(name) {
    name = String(name);
    return this.__entries.filter((entry) => entry[0] === name).map((entry) => entry[1]);
  }
  has(name) {
    name = String(name);
    return this.__entries.some((entry) => entry[0] === name);
  }
  set(name, value, filename = undefined) {
    name = String(name);
    this.delete(name);
    this.append(name, value, filename);
  }
  *entries() {
    for (const [name, value] of this.__entries) yield [name, value];
  }
  *keys() {
    for (const [name] of this.__entries) yield name;
  }
  *values() {
    for (const [, value] of this.__entries) yield value;
  }
  forEach(callback, thisArg = undefined) {
    for (const [name, value] of this) callback.call(thisArg, value, name, this);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: 'FormData', configurable: true });

async function collectNodeStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function collectWebStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function bodyToBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof FormData) {
    const params = new URLSearchParams();
    for (const [name, value] of body) params.append(name, String(value));
    return Buffer.from(params.toString());
  }
  if (body instanceof Body) return body.__consume();
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  if (typeof body.getReader === 'function') return collectWebStream(body);
  if (typeof body.pipe === 'function' || typeof body[Symbol.asyncIterator] === 'function') {
    return collectNodeStream(body);
  }
  return Buffer.from(String(body));
}

class Body {
  constructor(body = null) {
    this.__body = body;
    this.__bodyUsed = false;
  }
  get bodyUsed() {
    return this.__bodyUsed;
  }
  get body() {
    if (this.__body == null) return null;
    if (typeof ReadableStream === 'function') {
      const body = this.__body;
      return new ReadableStream({
        async start(controller) {
          const bytes = await bodyToBuffer(body);
          if (bytes.length > 0) controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          controller.close();
        }
      });
    }
    return Readable.from([this.__body]);
  }
  async __consume() {
    if (this.__bodyUsed) throw new TypeError('Body is unusable');
    this.__bodyUsed = true;
    return bodyToBuffer(this.__body);
  }
  async arrayBuffer() {
    const buffer = await this.__consume();
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async bytes() {
    return new Uint8Array(await this.arrayBuffer());
  }
  async text() {
    return (await this.__consume()).toString();
  }
  async json() {
    return JSON.parse(await this.text());
  }
  async blob() {
    const bytes = await this.bytes();
    if (typeof Blob === 'function') return new Blob([bytes]);
    return bytes;
  }
  async formData() {
    const text = await this.text();
    const out = new FormData();
    const params = new URLSearchParams(text);
    for (const [name, value] of params) out.append(name, value);
    return out;
  }
}

class Request extends Body {
  constructor(input, init = undefined) {
    init ??= {};
    const inputIsRequest = input instanceof Request;
    const url = inputIsRequest ? input.url : new URL(String(input)).href;
    const method = String(init.method || (inputIsRequest ? input.method : 'GET')).toUpperCase();
    const body = init.body !== undefined ? init.body : (inputIsRequest ? input.__body : null);
    if ((method === 'GET' || method === 'HEAD') && body != null) {
      throw new TypeError('Request with GET/HEAD method cannot have body');
    }
    super(body);
    this.method = method;
    this.url = url;
    this.headers = new Headers(init.headers || (inputIsRequest ? input.headers : undefined));
    this.redirect = init.redirect || (inputIsRequest ? input.redirect : 'follow');
    this.signal = init.signal || (inputIsRequest ? input.signal : undefined);
    this.dispatcher = init.dispatcher || (inputIsRequest ? input.dispatcher : undefined);
  }
  clone() {
    if (this.bodyUsed) throw new TypeError('Body is unusable');
    return new Request(this);
  }
}
Object.defineProperty(Request.prototype, Symbol.toStringTag, { value: 'Request', configurable: true });

class Response extends Body {
  constructor(body = null, init = undefined) {
    init ??= {};
    super(body);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? http.STATUS_CODES[this.status] ?? '';
    this.headers = new Headers(init.headers);
    this.url = init.url ?? '';
    this.redirected = !!init.redirected;
    this.type = init.type ?? 'default';
  }
  get ok() {
    return this.status >= 200 && this.status <= 299;
  }
  clone() {
    if (this.bodyUsed) throw new TypeError('Body is unusable');
    return new Response(this.__body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers,
      url: this.url,
      redirected: this.redirected,
      type: this.type,
    });
  }
  static error() {
    return new Response(null, { status: 0, statusText: '', type: 'error' });
  }
  static json(data, init = undefined) {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), { ...init, headers });
  }
  static redirect(url, status = 302) {
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError(`Invalid status code ${status}`);
    return new Response(null, { status, headers: { location: new URL(url).href } });
  }
}
Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });

class UndiciError extends Error {
  constructor(message = 'Undici error', options = undefined) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = this.constructor.code || 'UND_ERR';
  }
}
UndiciError.code = 'UND_ERR';
function makeError(name, code, defaultMessage) {
  return class extends UndiciError {
    static code = code;
    constructor(message = defaultMessage, options = undefined) {
      super(message, options);
      this.name = name;
      this.code = code;
    }
  };
}

const errors = {
  UndiciError,
  ConnectTimeoutError: makeError('ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'),
  HeadersTimeoutError: makeError('HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT', 'Headers Timeout Error'),
  HeadersOverflowError: makeError('HeadersOverflowError', 'UND_ERR_HEADERS_OVERFLOW', 'Headers Overflow Error'),
  BodyTimeoutError: makeError('BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'Body Timeout Error'),
  RequestContentLengthMismatchError: makeError('RequestContentLengthMismatchError', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'Request body length does not match content-length header'),
  ResponseContentLengthMismatchError: makeError('ResponseContentLengthMismatchError', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'Response body length does not match content-length header'),
  InvalidArgumentError: makeError('InvalidArgumentError', 'UND_ERR_INVALID_ARG', 'Invalid Argument Error'),
  InvalidReturnValueError: makeError('InvalidReturnValueError', 'UND_ERR_INVALID_RETURN_VALUE', 'Invalid Return Value Error'),
  RequestAbortedError: makeError('AbortError', 'UND_ERR_ABORTED', 'Request aborted'),
  ClientDestroyedError: makeError('ClientDestroyedError', 'UND_ERR_DESTROYED', 'The client is destroyed'),
  ClientClosedError: makeError('ClientClosedError', 'UND_ERR_CLOSED', 'The client is closed'),
  SocketError: makeError('SocketError', 'UND_ERR_SOCKET', 'Socket error'),
  InformationalError: makeError('InformationalError', 'UND_ERR_INFO', 'Request information'),
  ResponseStatusCodeError: makeError('ResponseStatusCodeError', 'UND_ERR_RESPONSE_STATUS_CODE', 'Response status code error'),
  HTTPParserError: makeError('HTTPParserError', 'HPE_INVALID_CONSTANT', 'Response does not match the HTTP/1.1 protocol'),
  ResponseExceededMaxSizeError: makeError('ResponseExceededMaxSizeError', 'UND_ERR_RES_EXCEEDED_MAX_SIZE', 'Response content exceeded max size'),
  BalancedPoolMissingUpstreamError: makeError('BalancedPoolMissingUpstreamError', 'UND_ERR_BPL_MISSING_UPSTREAM', 'BalancedPool missing upstream'),
  ResponseError: makeError('ResponseError', 'UND_ERR_RESPONSE', 'Response error'),
};

function abortError(reason) {
  if (reason) return reason;
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function networkError(err) {
  return new TypeError('fetch failed', { cause: err });
}

function envProxy(protocol) {
  const env = process.env;
  if (protocol === 'https:' || protocol === 'wss:') {
    return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY || '';
  }
  return env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY || '';
}

function noProxyMatches(url) {
  const raw = process.env.no_proxy || process.env.NO_PROXY || '';
  if (!raw) return false;
  if (raw.trim() === '*') return true;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  for (const token of raw.split(',')) {
    const item = token.trim().toLowerCase();
    if (!item) continue;
    const [ruleHost, rulePort] = item.split(':');
    if (rulePort && rulePort !== port) continue;
    if (ruleHost.startsWith('.') && host.endsWith(ruleHost)) return true;
    if (host === ruleHost || host.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

class Dispatcher {
  dispatch(options, handler) {
    const origin = options.origin || '';
    const path = options.path || '/';
    const url = new URL(path, origin);
    fetch(url, { ...options, dispatcher: this }).then(async (response) => {
      handler?.onConnect?.(() => {}, null);
      const rawHeaders = [];
      for (const [name, value] of response.headers) {
        rawHeaders.push(Buffer.from(name), Buffer.from(value));
      }
      const resume = () => {};
      handler?.onHeaders?.(response.status, rawHeaders, resume, response.statusText);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > 0) handler?.onData?.(body);
      handler?.onComplete?.([]);
    }, (err) => handler?.onError?.(err));
    return true;
  }
  close(callback) {
    if (callback) queue(callback);
    return Promise.resolve();
  }
  destroy(err, callback) {
    if (callback) queue(() => callback(err));
    return Promise.resolve();
  }
  request(opts, handler) { return this.dispatch(opts, handler); }
  stream(opts, handler) { return this.dispatch(opts, handler); }
  pipeline(opts, handler) { return this.dispatch(opts, handler); }
  connect(opts, handler) { return this.dispatch({ ...opts, method: 'CONNECT' }, handler); }
  upgrade(opts, handler) { return this.dispatch(opts, handler); }
}

class Agent extends Dispatcher {
  constructor(options = {}) {
    super();
    this.options = options;
    this.connect = options.connect || {};
  }
}
class Client extends Agent {}
class Pool extends Agent {}
class BalancedPool extends Agent {}
class RoundRobinPool extends Agent {}
class RetryAgent extends Agent {
  constructor(dispatcher, options = {}) {
    super(options);
    this.dispatcher = dispatcher;
  }
}
class H2CClient extends Client {}
class DecoratorHandler {
  constructor(handler) { this.handler = handler; }
}
class RedirectHandler extends DecoratorHandler {}
class RetryHandler extends DecoratorHandler {}

class ProxyAgent extends Agent {
  constructor(options = {}) {
    if (typeof options === 'string' || options instanceof URL) options = { uri: String(options) };
    super(options);
    this.uri = options.uri || options.proxy || '';
    this.connect = options.connect || {};
  }
  getProxyForUrl() {
    return this.uri;
  }
}

class EnvHttpProxyAgent extends Agent {
  constructor(options = {}) {
    super(options);
    this.connect = options.connect || {};
  }
  getProxyForUrl(url) {
    const parsed = url instanceof URL ? url : new URL(String(url));
    if (noProxyMatches(parsed)) return '';
    return envProxy(parsed.protocol);
  }
}

let globalDispatcher = new Agent();
function setGlobalDispatcher(dispatcher) {
  if (!dispatcher || typeof dispatcher.dispatch !== 'function') throw new TypeError('Invalid dispatcher');
  globalDispatcher = dispatcher;
}
function getGlobalDispatcher() {
  return globalDispatcher;
}

function proxyFor(url, dispatcher) {
  dispatcher ||= globalDispatcher;
  if (dispatcher && typeof dispatcher.getProxyForUrl === 'function') return dispatcher.getProxyForUrl(url);
  return '';
}

function connectTunnel(targetUrl, dispatcher) {
  return new Promise((resolve, reject) => {
    const proxy = proxyFor(targetUrl, dispatcher);
    if (!proxy) {
      const port = targetUrl.port || (targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:' ? 443 : 80);
      if (targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:') {
        const socket = tls.connect({
          host: targetUrl.hostname,
          port,
          servername: targetUrl.hostname,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: dispatcher?.connect?.rejectUnauthorized,
        }, () => resolve(socket));
        socket.once('error', reject);
      } else {
        const socket = net.connect(port, targetUrl.hostname, () => resolve(socket));
        socket.once('error', reject);
      }
      return;
    }

    const proxyUrl = new URL(proxy);
    const proxyPort = proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80);
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:' ? 443 : 80);
    const targetHost = `${targetUrl.hostname}:${targetPort}`;
    const socket = net.connect(proxyPort, proxyUrl.hostname);
    let settled = false;
    let buffered = Buffer.alloc(0);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      let headers =
        `CONNECT ${targetHost} HTTP/1.1\r\n` +
        `Host: ${targetHost}\r\n` +
        'Connection: close\r\n' +
        'Proxy-Connection: keep-alive\r\n';
      if (proxyUrl.username || proxyUrl.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64');
        headers += `Proxy-Authorization: Basic ${auth}\r\n`;
      }
      socket.write(headers + '\r\n');
    });
    socket.on('data', function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString();
      const rest = buffered.subarray(end + 4);
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) {
        const err = new Error(`Failed to establish proxy tunnel: ${head.split('\r\n')[0] || 'invalid response'}`);
        err.code = 'ERR_PROXY_TUNNEL';
        fail(err);
        return;
      }
      if (rest.length) socket.unshift(rest);
      settled = true;
      socket.off('error', fail);
      if (targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:') {
        const tlsSocket = tls.connect({
          socket,
          servername: targetUrl.hostname,
          ALPNProtocols: ['http/1.1'],
          rejectUnauthorized: dispatcher?.connect?.rejectUnauthorized,
        }, () => resolve(tlsSocket));
        tlsSocket.once('error', reject);
      } else {
        resolve(socket);
      }
    });
  });
}

async function performHttpRequest(request, redirectCount = 0) {
  const url = new URL(request.url);
  if (url.protocol === 'data:') {
    const comma = url.href.indexOf(',');
    const meta = url.href.slice(5, comma);
    const data = url.href.slice(comma + 1);
    const body = meta.endsWith(';base64') ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data));
    return new Response(body, { status: 200, statusText: 'OK', url: url.href });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`fetch failed`);
  }

  const body = await bodyToBuffer(request.__body);
  const headers = headersToObject(request.headers);
  if (body.length > 0 && !request.headers.has('content-length')) headers['content-length'] = String(body.length);
  if (!request.headers.has('connection')) headers.connection = 'close';

  const dispatcher = request.dispatcher || globalDispatcher;
  const useProxy = !!proxyFor(url, dispatcher);
  const transport = url.protocol === 'https:' ? https : http;
  const socket = useProxy ? await connectTunnel(url, dispatcher) : null;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (socket) {
        try { socket.destroy(); } catch {}
      }
    };
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: request.method,
      headers,
      agent: false,
      rejectUnauthorized: dispatcher?.connect?.rejectUnauthorized,
    };
    if (socket) options.createConnection = () => socket;

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        let responseBody = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding === 'gzip' || encoding === 'x-gzip') responseBody = zlib.gunzipSync(responseBody);
          else if (encoding === 'deflate') responseBody = zlib.inflateSync(responseBody);
          else if (encoding === 'br') responseBody = zlib.brotliDecompressSync(responseBody);
        } catch {}
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (request.redirect !== 'manual' && location && [301, 302, 303, 307, 308].includes(status)) {
          cleanup();
          if (redirectCount >= 20) {
            reject(new TypeError('redirect count exceeded'));
            return;
          }
          const nextUrl = new URL(location, url);
          const nextInit = {
            method: request.method,
            headers: request.headers,
            body: request.__body,
            redirect: request.redirect,
            signal: request.signal,
            dispatcher,
          };
          if (status === 303 || ((status === 301 || status === 302) && request.method === 'POST')) {
            nextInit.method = 'GET';
            nextInit.body = null;
            nextInit.headers = new Headers(request.headers);
            nextInit.headers.delete('content-length');
            nextInit.headers.delete('content-type');
          }
          performHttpRequest(new Request(nextUrl, nextInit), redirectCount + 1).then(resolve, reject);
          return;
        }
        settled = true;
        cleanup();
        resolve(new Response(responseBody, {
          status,
          statusText: res.statusMessage || http.STATUS_CODES[status] || '',
          headers: headersFromRaw(res.rawHeaders || []),
          url: url.href,
          redirected: redirectCount > 0,
        }));
      });
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    if (request.signal) {
      if (request.signal.aborted) {
        req.destroy();
        cleanup();
        reject(abortError(request.signal.reason));
        return;
      }
      request.signal.addEventListener('abort', () => {
        req.destroy();
        cleanup();
        reject(abortError(request.signal.reason));
      }, { once: true });
    }
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function fetch(input, init = undefined) {
  let request;
  try {
    request = new Request(input, init);
  } catch (err) {
    return Promise.reject(err);
  }
  if (request.signal?.aborted) return Promise.reject(abortError(request.signal.reason));
  return performHttpRequest(request).catch((err) => {
    if (err && err.name === 'AbortError') throw err;
    throw networkError(err);
  });
}

async function request(url, opts = undefined) {
  const response = await fetch(url, opts);
  const body = Buffer.from(await response.arrayBuffer());
  return {
    statusCode: response.status,
    headers: headersToObject(response.headers),
    trailers: {},
    opaque: null,
    body: Readable.from([body]),
    context: null,
  };
}
const stream = request;
const pipeline = request;
const connect = request;
const upgrade = request;

class WebSocket extends EventTargetImpl {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, protocols = [], options = undefined) {
    if (protocols && !Array.isArray(protocols) && typeof protocols === 'object') {
      options = protocols;
      protocols = [];
    }
    super();
    this.url = new URL(String(url)).href;
    this.protocol = Array.isArray(protocols) ? protocols[0] || '' : String(protocols || '');
    this.readyState = WebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.extensions = '';
    this.binaryType = 'blob';
    this.__socket = null;
    this.__options = options || {};
    queue(() => this.__connect());
  }
  async __connect() {
    const url = new URL(this.url);
    try {
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('Invalid WebSocket protocol');
      const dispatcher = this.__options.dispatcher || globalDispatcher;
      const socket = await connectTunnel(new URL((url.protocol === 'wss:' ? 'https:' : 'http:') + url.href.slice(url.protocol.length)), dispatcher);
      this.__socket = socket;
      const key = crypto.randomBytes(16).toString('base64');
      const path = `${url.pathname || '/'}${url.search || ''}`;
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        (this.protocol ? `Sec-WebSocket-Protocol: ${this.protocol}\r\n` : '') +
        '\r\n'
      );
      let header = Buffer.alloc(0);
      const onData = (chunk) => {
        if (this.readyState !== WebSocket.CONNECTING) {
          this.__handleFrame(chunk);
          return;
        }
        header = Buffer.concat([header, Buffer.from(chunk)]);
        const end = header.indexOf('\r\n\r\n');
        if (end === -1) return;
        const text = header.subarray(0, end).toString();
        const rest = header.subarray(end + 4);
        if (!/^HTTP\/1\.[01] 101\b/.test(text)) {
          this.__fail(new Error(text.split('\r\n')[0] || 'WebSocket upgrade failed'));
          return;
        }
        this.readyState = WebSocket.OPEN;
        fire(this, new EventImpl('open'));
        if (rest.length) this.__handleFrame(rest);
      };
      socket.on('data', onData);
      socket.on('error', (err) => this.__fail(err));
      socket.on('close', () => {
        if (this.readyState !== WebSocket.CLOSED) {
          this.readyState = WebSocket.CLOSED;
          fire(this, new CloseEvent('close', { wasClean: true, code: 1000 }));
        }
      });
    } catch (err) {
      this.__fail(err);
    }
  }
  __handleFrame(chunk) {
    if (!chunk || chunk.length < 2) return;
    const opcode = chunk[0] & 0x0f;
    let length = chunk[1] & 0x7f;
    let offset = 2;
    if (length === 126 && chunk.length >= 4) {
      length = chunk.readUInt16BE(2);
      offset = 4;
    }
    if (opcode === 1 || opcode === 2) {
      const data = chunk.subarray(offset, offset + length);
      fire(this, new MessageEvent('message', { data: opcode === 1 ? data.toString() : data }));
    } else if (opcode === 8) {
      this.readyState = WebSocket.CLOSED;
      this.__socket?.end();
      fire(this, new CloseEvent('close', { wasClean: true, code: 1000 }));
    }
  }
  __fail(err) {
    this.readyState = WebSocket.CLOSED;
    fire(this, new ErrorEvent('error', { error: err, message: err?.message || String(err) }));
  }
  send(data) {
    if (this.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (payload.length > 125) throw new Error('Large WebSocket frames are not implemented');
    const mask = crypto.randomBytes(4);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x81;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
    this.__socket.write(frame);
  }
  close(code = 1000, reason = '') {
    if (this.readyState === WebSocket.CLOSED || this.readyState === WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    try {
      const reasonBuffer = Buffer.from(String(reason));
      const payload = Buffer.alloc(2 + reasonBuffer.length);
      payload.writeUInt16BE(code, 0);
      reasonBuffer.copy(payload, 2);
      const frame = Buffer.from([0x88, payload.length, ...payload]);
      this.__socket?.write(frame);
    } catch {}
    this.__socket?.end();
    this.readyState = WebSocket.CLOSED;
    fire(this, new CloseEvent('close', { wasClean: true, code, reason }));
  }
}
WebSocket.prototype.CONNECTING = WebSocket.CONNECTING;
WebSocket.prototype.OPEN = WebSocket.OPEN;
WebSocket.prototype.CLOSING = WebSocket.CLOSING;
WebSocket.prototype.CLOSED = WebSocket.CLOSED;
Object.defineProperty(WebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });

class EventSource extends EventTargetImpl {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url, init = {}) {
    super();
    this.url = new URL(String(url)).href;
    this.withCredentials = !!init.withCredentials;
    this.readyState = EventSource.CONNECTING;
    this.__closed = false;
    queue(() => this.__connect(init));
  }
  async __connect(init) {
    try {
      const response = await fetch(this.url, { headers: { accept: 'text/event-stream' }, dispatcher: init.dispatcher });
      if (this.__closed) return;
      this.readyState = EventSource.OPEN;
      fire(this, new EventImpl('open'));
      const text = await response.text();
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) fire(this, new MessageEvent('message', { data, origin: new URL(this.url).origin }));
      }
    } catch (err) {
      if (!this.__closed) fire(this, new ErrorEvent('error', { error: err, message: err?.message || String(err) }));
    }
  }
  close() {
    this.__closed = true;
    this.readyState = EventSource.CLOSED;
  }
}
Object.defineProperty(EventSource.prototype, Symbol.toStringTag, { value: 'EventSource', configurable: true });

function parseMIMEType(input) {
  const value = String(input).split(';')[0].trim().toLowerCase();
  if (!value || !value.includes('/')) return null;
  const [type, subtype] = value.split('/');
  return { type, subtype, parameters: new Map(), essence: `${type}/${subtype}` };
}
function serializeAMimeType(mimeType) {
  if (!mimeType) return 'application/octet-stream';
  if (typeof mimeType === 'string') return mimeType;
  return mimeType.essence || `${mimeType.type}/${mimeType.subtype}`;
}
function parseCookie(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}
function getCookies(headers) { return parseCookie(new Headers(headers).get('cookie') || ''); }
function getSetCookies(headers) { return new Headers(headers).getSetCookie(); }
function setCookie(headers, cookie) {
  const target = headers instanceof Headers ? headers : new Headers(headers);
  const value = typeof cookie === 'string' ? cookie : Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ');
  target.append('set-cookie', value);
}
function deleteCookie(headers, name) { setCookie(headers, `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT`); }

class MemoryCacheStore {
  constructor() { this.store = new Map(); }
  get(key) { return Promise.resolve(this.store.get(key)); }
  set(key, value) { this.store.set(key, value); return Promise.resolve(); }
  delete(key) { this.store.delete(key); return Promise.resolve(); }
}
class SqliteCacheStore extends MemoryCacheStore {}
class CacheStorage {}

class MockAgent extends Agent {}
class MockClient extends Client {}
class MockPool extends Pool {}
class SnapshotAgent extends Agent {}
class MockCallHistory {}
class MockCallHistoryLog {}

function identityInterceptor() {
  return (dispatcher) => dispatcher;
}
const interceptors = {
  redirect: identityInterceptor,
  responseError: identityInterceptor,
  retry: identityInterceptor,
  dump: identityInterceptor,
  dns: identityInterceptor,
  cache: identityInterceptor,
  decompress: identityInterceptor,
  deduplicate: identityInterceptor,
};

function buildConnector(options = {}) {
  return function connector(opts, callback) {
    const url = new URL(`${opts.protocol || 'http:'}//${opts.hostname || opts.host}:${opts.port || ''}`);
    connectTunnel(url, { connect: options }).then((socket) => callback(null, socket), callback);
  };
}

function install() {
  globalThis.fetch = fetch;
  globalThis.Headers = Headers;
  globalThis.Response = Response;
  globalThis.Request = Request;
  globalThis.FormData = FormData;
  globalThis.WebSocket = WebSocket;
  globalThis.CloseEvent = CloseEvent;
  globalThis.ErrorEvent = ErrorEvent;
  globalThis.MessageEvent = MessageEvent;
  globalThis.EventSource = EventSource;
}

function ping(ws, payload) {
  if (ws && typeof ws.send === 'function') ws.send(payload || '');
}

const util = {
  parseHeaders(headers) {
    const out = {};
    for (let i = 0; i < headers.length; i += 2) out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    return out;
  },
  headerNameToString(name) {
    return String(name).toLowerCase();
  },
};

const undici = {
  Dispatcher,
  Client,
  Pool,
  BalancedPool,
  RoundRobinPool,
  Agent,
  ProxyAgent,
  EnvHttpProxyAgent,
  RetryAgent,
  H2CClient,
  RetryHandler,
  DecoratorHandler,
  RedirectHandler,
  interceptors,
  cacheStores: { MemoryCacheStore, SqliteCacheStore },
  buildConnector,
  errors,
  util,
  setGlobalDispatcher,
  getGlobalDispatcher,
  fetch,
  Headers,
  Response,
  Request,
  FormData,
  setGlobalOrigin(origin) { globalThis[Symbol.for('undici.globalOrigin.1')] = origin == null ? undefined : new URL(String(origin)); },
  getGlobalOrigin() { return globalThis[Symbol.for('undici.globalOrigin.1')]; },
  caches: new CacheStorage(),
  deleteCookie,
  getCookies,
  getSetCookies,
  setCookie,
  parseCookie,
  parseMIMEType,
  serializeAMimeType,
  WebSocket,
  CloseEvent,
  ErrorEvent,
  MessageEvent,
  ping,
  WebSocketStream: class WebSocketStream {},
  WebSocketError: class WebSocketError extends Error {},
  request,
  stream,
  pipeline,
  connect,
  upgrade,
  MockClient,
  MockCallHistory,
  MockCallHistoryLog,
  MockPool,
  MockAgent,
  SnapshotAgent,
  mockErrors: {},
  EventSource,
  install,
  createFastMessageEvent,
};

Object.defineProperty(undici.fetch, 'name', { value: 'fetch', configurable: true });
Object.defineProperty(undici, inspect.custom, { value: () => undici, configurable: true });
module.exports = undici;

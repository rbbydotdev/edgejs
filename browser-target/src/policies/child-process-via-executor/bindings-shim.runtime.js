// =====================================================================
// P3.5: process_wrap, pipe_wrap, stream_wrap binding shims.
//
// Replaces the wholesale cp.spawn/exec/execFile/fork overrides with
// binding-level intercepts so lib's native ChildProcess (and getValidStdio,
// setupChannel, ref/unref, spawnfile/spawnargs, child.stdio[] array,
// shell:true, argv0, detached/uid/gid pass-through) ALL work as Node
// intends. The host-worker executor RPC underneath is unchanged.
// =====================================================================
(function installAsyncSpawnBindingShims() {
  function getG() {
    return (typeof globalThis !== 'undefined' && globalThis) ||
           (typeof global !== 'undefined' && global);
  }
  var g = getG();
  /* __EDGE_EVENT_KIND_PRELUDE__ */ // policy TS replaces with `var EK = {...};`

  // --- stream_wrap shim (provides streamBaseState typed array + indices) ---
  var streamWrapBinding;
  try { streamWrapBinding = internalBinding('stream_wrap'); } catch (_e) { void _e; }
  if (!streamWrapBinding) return;
  // Edge.js already populates stream_wrap with streamBaseState (Int32Array
  // over a SAB-backed ArrayBuffer), kReadBytesOrError/etc. indices, and
  // WriteWrap/ShutdownWrap constructors. We MUST NOT replace these --
  // some lib modules (notably internal/stream_base_commons via net.js)
  // destructure them at module-load time, and edge's bootstrap order
  // means those modules may load BEFORE our PRE_PATCH fires. Replacing
  // the instance leaves those modules holding edge's original, while
  // OUR Pipe writes to a different one. Just READ what edge provides
  // and use it directly.
  var streamBaseState = streamWrapBinding.streamBaseState;
  var kReadBytesOrError = (typeof streamWrapBinding.kReadBytesOrError === 'number') ? streamWrapBinding.kReadBytesOrError : 0;
  var kArrayBufferOffset = (typeof streamWrapBinding.kArrayBufferOffset === 'number') ? streamWrapBinding.kArrayBufferOffset : 1;
  var kBytesWritten = (typeof streamWrapBinding.kBytesWritten === 'number') ? streamWrapBinding.kBytesWritten : 2;
  var kLastWriteWasAsync = (typeof streamWrapBinding.kLastWriteWasAsync === 'number') ? streamWrapBinding.kLastWriteWasAsync : 3;
  // Sanity: if streamBaseState is missing entirely (older edge build),
  // install a fallback. Otherwise edge's array is the canonical one.
  if (!streamBaseState) {
    streamBaseState = new Int32Array(4);
    streamWrapBinding.streamBaseState = streamBaseState;
    streamWrapBinding.kReadBytesOrError = kReadBytesOrError;
    streamWrapBinding.kArrayBufferOffset = kArrayBufferOffset;
    streamWrapBinding.kBytesWritten = kBytesWritten;
    streamWrapBinding.kLastWriteWasAsync = kLastWriteWasAsync;
  }
  if (typeof streamWrapBinding.WriteWrap !== 'function') {
    streamWrapBinding.WriteWrap = function WriteWrap() {};
  }
  if (typeof streamWrapBinding.ShutdownWrap !== 'function') {
    streamWrapBinding.ShutdownWrap = function ShutdownWrap() {};
  }

  // --- Per-child Process map + event buffer (race-safe handoff) ---
  var processesByChildId = new Map();
  var pendingEventBuffer = new Map();

  g.__edgeChildProcessAsyncEvent = function(childId, kind, payload) {
    var proc = processesByChildId.get(childId);
    if (proc) { proc._handleEvent(kind, payload); return; }
    var buf = pendingEventBuffer.get(childId);
    if (!buf) { buf = []; pendingEventBuffer.set(childId, buf); }
    buf.push([kind, payload]);
  };
  function registerProcess(childId, proc) {
    processesByChildId.set(childId, proc);
    var buffered = pendingEventBuffer.get(childId);
    if (buffered) {
      pendingEventBuffer.delete(childId);
      for (var i = 0; i < buffered.length; i++) {
        proc._handleEvent(buffered[i][0], buffered[i][1]);
      }
    }
  }
  function deregisterProcess(childId) { processesByChildId.delete(childId); }

  // --- Loop keepalive: refed setInterval, ref-counted per pinned handle ---
  var keepaliveTimer = null;
  var keepaliveRefCount = 0;
  function keepaliveAcquire() {
    keepaliveRefCount++;
    if (keepaliveTimer == null) keepaliveTimer = setInterval(function() {}, 50);
  }
  function keepaliveRelease() {
    if (keepaliveRefCount > 0) keepaliveRefCount--;
    if (keepaliveRefCount === 0 && keepaliveTimer != null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  var nextAsyncId = 1;
  // Read UV errno constants from edge.js's binding so they match what
  // lib's UV_* constants resolve to. Our wasi-libc-based env has DIFFERENT
  // numeric values than canonical libuv (e.g. UV_ENOENT is -44 here, not
  // -2 -- because util.getSystemErrorName needs that mapping to produce
  // 'ENOENT'). Hardcoding the canonical libuv numbers makes lib's onexit
  // fire 'error' with the WRONG err.code string.
  var uvBinding = {};
  try { uvBinding = internalBinding('uv'); } catch (_e) { void _e; }
  var UV_EOF = (typeof uvBinding.UV_EOF === 'number') ? uvBinding.UV_EOF : -4095;
  var UV_EPIPE = (typeof uvBinding.UV_EPIPE === 'number') ? uvBinding.UV_EPIPE : -32;
  var UV_ENOSYS = (typeof uvBinding.UV_ENOSYS === 'number') ? uvBinding.UV_ENOSYS : -38;
  var UV_ENOENT = (typeof uvBinding.UV_ENOENT === 'number') ? uvBinding.UV_ENOENT : -2;
  var UV_ESRCH = (typeof uvBinding.UV_ESRCH === 'number') ? uvBinding.UV_ESRCH : -3;
  var UV_EINVAL = (typeof uvBinding.UV_EINVAL === 'number') ? uvBinding.UV_EINVAL : -22;

  // --- EdgePipe: shim for internalBinding('pipe_wrap').Pipe.
  // Satisfies net.Socket({handle, ...}) and lib's setupChannel(ipc).
  // For type=SOCKET, lib wraps us in net.Socket; for IPC, lib reads
  // bytes via onread (json-deframed by serialization.js).
  function EdgePipe(type) {
    this._type = type;
    this._isIpc = type === 2;
    this._closed = false;
    this._reading = false;
    this.reading = false;
    this._asyncId = nextAsyncId++;
    this._bufferedReads = [];
    this.onread = null;
    this.pendingHandle = null;
    this.buffering = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._childId = null;
    this._fdIndex = -1;
    // _refed mirrors libuv handle.unref()/.ref() semantics: a refed
    // handle pins the event loop; an unrefed one allows it to exit
    // even if the handle is still alive. We DO NOT acquire keepalive
    // on pipe construction -- that would double-count with the per-
    // child acquire EdgeProcess.spawn() already does. Pipe-level
    // ref/unref only takes effect AFTER the user explicitly toggles
    // it, and we balance acquire/release strictly on those transitions.
    // Audit fix P1.5: pre-fix, pipe started _refed=true but never
    // called keepaliveAcquire(); a user calling .unref().ref() would
    // do an unmatched acquire and pin the loop forever, and pipe.close()
    // while _refed=true would do an unmatched release.
    this._refed = true;
    this._heldKeepalive = false; // becomes true after a .ref() that acquired
    this._endedRead = false;
  }
  EdgePipe.prototype.getAsyncId = function() { return this._asyncId; };
  EdgePipe.prototype.ref = function() {
    if (this._refed) return;
    this._refed = true;
    if (!this._heldKeepalive) {
      this._heldKeepalive = true;
      keepaliveAcquire();
    }
  };
  EdgePipe.prototype.unref = function() {
    if (!this._refed) return;
    this._refed = false;
    if (this._heldKeepalive) {
      this._heldKeepalive = false;
      keepaliveRelease();
    }
  };
  EdgePipe.prototype.readStart = function() {
    this._reading = true;
    this.reading = true;
    while (this._bufferedReads.length > 0 && this._reading) {
      this._deliverReadNow(this._bufferedReads.shift());
    }
    if (this._endedRead && this._reading) this._deliverEof();
    return 0;
  };
  EdgePipe.prototype.readStop = function() {
    this._reading = false;
    this.reading = false;
    return 0;
  };
  EdgePipe.prototype._deliverRead = function(bytes) {
    if (!this._reading || !this.onread) {
      this._bufferedReads.push(bytes);
      return;
    }
    this._deliverReadNow(bytes);
  };
  EdgePipe.prototype._deliverReadNow = function(bytes) {
    this.bytesRead += bytes.byteLength;
    streamBaseState[kReadBytesOrError] = bytes.byteLength;
    streamBaseState[kArrayBufferOffset] = bytes.byteOffset;
    this.onread(bytes.buffer);
  };
  EdgePipe.prototype._deliverEof = function() {
    if (!this.onread) return;
    streamBaseState[kReadBytesOrError] = UV_EOF;
    streamBaseState[kArrayBufferOffset] = 0;
    this.onread(undefined);
  };
  EdgePipe.prototype._endRead = function() {
    if (this._endedRead) return;
    this._endedRead = true;
    if (this._reading) this._deliverEof();
  };
  EdgePipe.prototype._writeBytes = function(_req, buf) {
    if (this._closed || this._childId == null) {
      streamBaseState[kBytesWritten] = 0;
      streamBaseState[kLastWriteWasAsync] = 0;
      return UV_EPIPE;
    }
    if (this._isIpc) {
      // IPC: forward raw bytes (lib already framed as "JSON\n"). Host
      // accumulates, splits on \n, parses, calls executor.opts.ipc.on('message').
      var ipcSend = g.__edgeChildProcessIpcSend;
      if (typeof ipcSend !== 'function') return UV_EPIPE;
      var asString = '';
      // Decode buf bytes to UTF-8 string for the existing IPC RPC shape
      // (legacy: takes a JSON string). Host will detect framing.
      try { asString = new TextDecoder('utf-8').decode(buf); }
      catch (e) { void e; return UV_EPIPE; }
      var status = ipcSend(this._childId, asString);
      if (status !== 0) return UV_EPIPE;
      this.bytesWritten += buf.length;
      streamBaseState[kBytesWritten] = buf.length;
      streamBaseState[kLastWriteWasAsync] = 0;
      return 0;
    }
    var writer = g.__edgeChildProcessStdioWrite;
    if (typeof writer !== 'function') return UV_EPIPE;
    var st = writer(this._childId, this._fdIndex, buf);
    if (st !== 0) return UV_EPIPE;
    this.bytesWritten += buf.length;
    streamBaseState[kBytesWritten] = buf.length;
    streamBaseState[kLastWriteWasAsync] = 0;
    return 0;
  };
  EdgePipe.prototype.writev = function(req, chunks, allBuffers) {
    var collected = [];
    var total = 0;
    if (allBuffers) {
      for (var i = 0; i < chunks.length; i++) {
        collected.push(chunks[i]);
        total += chunks[i].length;
      }
    } else {
      for (var j = 0; j < chunks.length; j += 2) {
        var chunk = chunks[j];
        var enc = chunks[j + 1];
        var b = Buffer.isBuffer(chunk) ? chunk
          : (typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8')
              : Buffer.from(chunk));
        collected.push(b);
        total += b.length;
      }
    }
    return this._writeBytes(req, Buffer.concat(collected, total));
  };
  EdgePipe.prototype.writeBuffer = function(req, buf) { return this._writeBytes(req, buf); };
  EdgePipe.prototype.writeUtf8String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'utf8')); };
  EdgePipe.prototype.writeAsciiString = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'ascii')); };
  EdgePipe.prototype.writeLatin1String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'latin1')); };
  EdgePipe.prototype.writeUcs2String = function(req, str) { return this._writeBytes(req, Buffer.from(String(str), 'ucs2')); };
  EdgePipe.prototype.shutdown = function(req) {
    if (this._childId == null) return UV_EPIPE;
    if (this._isIpc) {
      var d = g.__edgeChildProcessIpcDisconnect;
      if (typeof d === 'function') d(this._childId);
    } else {
      var e = g.__edgeChildProcessStdioEnd;
      if (typeof e === 'function') e(this._childId, this._fdIndex);
    }
    process.nextTick(function() {
      if (req && typeof req.oncomplete === 'function') req.oncomplete(0);
    });
    return 0;
  };
  EdgePipe.prototype.close = function(cb) {
    if (this._closed) { if (cb) process.nextTick(cb); return; }
    this._closed = true;
    this._refed = false;
    // Only release keepalive if we actually held one (i.e. user called
    // .ref() after a prior .unref() that acquired it). Pipe-level
    // keepalive is opt-in -- the per-child Process keepalive is the
    // baseline. Pre-P1.5 fix this always called release on initial
    // close, even though we'd never called acquire, double-counting
    // against EdgeProcess's keepalive.
    if (this._heldKeepalive) {
      this._heldKeepalive = false;
      keepaliveRelease();
    }
    if (cb) process.nextTick(cb);
  };
  EdgePipe.prototype.setNoDelay = function() {};
  EdgePipe.prototype.setKeepAlive = function() {};

  // --- EdgeProcess: shim for internalBinding('process_wrap').Process.
  // Drives the async-spawn host RPC. Lib's ChildProcess wraps us and
  // provides all the user-facing semantics (ref/unref, .pid, .stdio[],
  // .spawnfile, .spawnargs, IPC channel via setupChannel, ...).
  function EdgeProcess() {
    this._closed = false;
    this._childId = null;
    this.pid = 0;
    this.onexit = null;
    this._stdioPipes = [];
    this._ipcPipe = null;
    this._refed = true;
    this._exited = false;
  }
  EdgeProcess.prototype.spawn = function(options) {
    var startAsync = g.__edgeChildProcessSpawnAsync;
    if (typeof startAsync !== 'function') return UV_ENOSYS;
    var stdio = options.stdio || [];
    var hasIpc = false;
    for (var i = 0; i < stdio.length; i++) {
      var entry = stdio[i];
      if (entry && entry.handle && entry.handle instanceof EdgePipe) {
        entry.handle._fdIndex = i;
        this._stdioPipes[i] = entry.handle;
        if (entry.ipc || entry.handle._isIpc) {
          hasIpc = true;
          this._ipcPipe = entry.handle;
        }
      }
    }
    var envMap;
    if (Array.isArray(options.envPairs)) {
      envMap = {};
      for (var k = 0; k < options.envPairs.length; k++) {
        var kv = String(options.envPairs[k]);
        var eq = kv.indexOf('=');
        if (eq > 0) envMap[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    var headerObj = {
      command: String(options.file || ''),
      args: Array.isArray(options.args) ? options.args.slice(1).map(String) : [],
      env: envMap,
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
      ipc: hasIpc,
      ipcAdvanced: hasIpc && options.serialization === 'advanced',
      // P4.3: opt-in hard kill via {killable:'hard'}. Runs the
      // executor in a dedicated Worker; kill() terminate()s the
      // worker -- halts runaway loops that ignore opts.signal.
      // V1: no streaming/IPC/stdin on the killable path.
      killable: options.killable === 'hard' ? 'hard' : undefined,
    };
    var headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
    var reqBuf = new Uint8Array(4 + headerBytes.byteLength + 4);
    var dv = new DataView(reqBuf.buffer);
    dv.setUint32(0, headerBytes.byteLength, true);
    reqBuf.set(headerBytes, 4);
    dv.setUint32(4 + headerBytes.byteLength, 0, true);

    var started = startAsync(reqBuf);
    if (started.status !== 0) {
      // started.status is our protocol's own value (negative libuv-style
      // but using OUR shim's negative numbers, not edge's env's). Just
      // map "spawn rejected" cases to ENOENT, anything else to EINVAL.
      return started.status === -2 ? UV_ENOENT : UV_EINVAL;
    }
    this._childId = started.childId;
    this.pid = started.childId;
    for (var n = 0; n < this._stdioPipes.length; n++) {
      var p = this._stdioPipes[n];
      if (p) p._childId = this._childId;
    }
    keepaliveAcquire();
    registerProcess(this._childId, this);
    return 0;
  };
  EdgeProcess.prototype._handleEvent = function(kind, payload) {
    if (this._exited) return;
    if (kind === EK.SPAWNED) return; // pid already set in spawn()
    if (kind === EK.STDOUT) {
      var so = this._stdioPipes[1];
      if (so) so._deliverRead(payload);
      return;
    }
    if (kind === EK.STDERR) {
      var se = this._stdioPipes[2];
      if (se) se._deliverRead(payload);
      return;
    }
    if (kind === EK.IPC_MESSAGE) {
      if (!this._ipcPipe) return;
      // Host emits JSON (no newline). Lib's json deframer splits on \n,
      // so we append one. parseChannelMessages then JSON.parses cleanly.
      var withNl = new Uint8Array(payload.byteLength + 1);
      withNl.set(payload, 0);
      withNl[payload.byteLength] = 0x0A;
      this._ipcPipe._deliverRead(withNl);
      return;
    }
    if (kind === EK.IPC_DISCONNECT) {
      if (this._ipcPipe) this._ipcPipe._endRead();
      return;
    }
    if (kind === EK.STDIO_FDN) {
      if (payload.byteLength < 4) return;
      var dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      var fdIdx = dv.getUint32(0, true);
      var bytes = payload.subarray(4);
      var pipe = this._stdioPipes[fdIdx];
      if (pipe) {
        if (bytes.byteLength === 0) pipe._endRead();
        else pipe._deliverRead(bytes);
      }
      return;
    }
    if (kind === EK.ERROR) {
      // Spawn-time error: lib treats negative exitCode in onexit as the
      // spawn-failure error path (emits 'error' event with ErrnoException).
      // Also EOF all read-side pipes so the wrapping net.Sockets close
      // and lib's maybeClose() can fire 'close' on the ChildProcess.
      for (var i3 = 0; i3 < this._stdioPipes.length; i3++) {
        var sp3 = this._stdioPipes[i3];
        if (sp3 && i3 !== 0) sp3._endRead();
      }
      this._exited = true;
      if (this.onexit) this.onexit(UV_ENOENT, null);
      if (this._refed) { this._refed = false; keepaliveRelease(); }
      deregisterProcess(this._childId);
      return;
    }
    if (kind === EK.EXIT) {
      var dv2 = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      var codeRaw = dv2.getInt32(0, true);
      var sigLen = dv2.getUint32(4, true);
      var sig = sigLen > 0
        ? new TextDecoder().decode(payload.subarray(8, 8 + sigLen))
        : null;
      var code = (codeRaw === -1 && sig != null) ? 0 : codeRaw;
      // EOF on all read-side pipes (stdout, stderr, extras, IPC).
      for (var i2 = 0; i2 < this._stdioPipes.length; i2++) {
        var sp = this._stdioPipes[i2];
        if (sp && i2 !== 0) sp._endRead();
      }
      this._exited = true;
      if (this.onexit) this.onexit(code, sig);
      if (this._refed) { this._refed = false; keepaliveRelease(); }
      deregisterProcess(this._childId);
      return;
    }
  };
  EdgeProcess.prototype.kill = function(signal) {
    if (this._childId == null) return UV_ESRCH;
    var killer = g.__edgeChildProcessKillAsync;
    if (typeof killer !== 'function') return 0; // best-effort; no-op
    // Map numeric signal to name for our host RPC. Lib gives us numeric
    // signal (via convertToValidSignal). Our host expects a string.
    var SIG_NUM_TO_NAME = {
      1:'SIGHUP', 2:'SIGINT', 3:'SIGQUIT', 4:'SIGILL', 5:'SIGTRAP',
      6:'SIGABRT', 7:'SIGBUS', 8:'SIGFPE', 9:'SIGKILL', 10:'SIGUSR1',
      11:'SIGSEGV', 12:'SIGUSR2', 13:'SIGPIPE', 14:'SIGALRM', 15:'SIGTERM',
      17:'SIGCHLD', 18:'SIGCONT', 19:'SIGSTOP', 20:'SIGTSTP',
    };
    var sigName;
    if (signal === 0) sigName = '0'; // signal 0 == "is alive?" probe
    else if (typeof signal === 'number') sigName = SIG_NUM_TO_NAME[signal] || ('SIG' + signal);
    else sigName = signal || 'SIGTERM';
    try { killer(this._childId, String(sigName)); } catch (e) { void e; }
    // Always return 0 so lib doesn't throw or emit 'error'. Our executor
    // may not honor the signal (no real OS process), but the kill API
    // contract returns "delivered successfully to the kernel" -- which
    // for us means "the abort signal was forwarded to the executor."
    return 0;
  };
  EdgeProcess.prototype.close = function() { this._closed = true; };
  EdgeProcess.prototype.ref = function() {
    if (!this._refed) { this._refed = true; keepaliveAcquire(); }
  };
  EdgeProcess.prototype.unref = function() {
    if (this._refed) { this._refed = false; keepaliveRelease(); }
  };

  // --- Install bindings (idempotent) ---
  var pipeWrapBinding;
  try { pipeWrapBinding = internalBinding('pipe_wrap'); } catch (_e) { void _e; }
  if (pipeWrapBinding && !pipeWrapBinding.__edgePipeInstalled) {
    pipeWrapBinding.__edgePipeInstalled = true;
    pipeWrapBinding.constants = { SOCKET: 0, SERVER: 1, IPC: 2, UV_READABLE: 1, UV_WRITABLE: 2 };
    pipeWrapBinding.Pipe = EdgePipe;
    pipeWrapBinding.PipeConnectWrap = function PipeConnectWrap() {};
  }
  var processWrapBinding;
  try { processWrapBinding = internalBinding('process_wrap'); } catch (_e) { void _e; }
  if (processWrapBinding && !processWrapBinding.__edgeProcessInstalled) {
    processWrapBinding.__edgeProcessInstalled = true;
    processWrapBinding.Process = EdgeProcess;
  }

  // --- serdes binding: lib/v8.js destructures Serializer/Deserializer
  // from internalBinding('serdes'). When IPC setupChannel triggers a
  // require of lib's serialization.js (which requires v8), v8.js does
  // \`class DefaultSerializer extends Serializer\` at module load -- if
  // Serializer is undefined we get "Cannot read properties of undefined
  // (reading 'prototype')".
  //
  // We provide a JSON-backed Serializer/Deserializer that satisfies the
  // protocol lib uses (writeHeader/writeValue/writeRawBytes/writeUint32/
  // releaseBuffer + read counterparts). Values round-trip losslessly for
  // JSON-compatible types (string/number/bool/null/plain object/array).
  //
  // #!~debt child-process-ipc-advanced-serialization-types: Map, Set,
  // Date, ArrayBuffer/TypedArray round-trip lossy under 'advanced' mode
  // because our backing is JSON. Real V8 structured-clone (binary V8
  // protocol with type tags + transferable handles) would require a
  // ~thousand-line serializer; deferred. JSON mode (the default for
  // child_process IPC) is unaffected and supports the same value subset.
  var serdesBinding;
  try { serdesBinding = internalBinding('serdes'); } catch (_e) { void _e; }
  if (serdesBinding && typeof serdesBinding.Serializer !== 'function') {
    function JsonSerializer() {
      this._chunks = [];  // ordered list of (length-prefixed) byte segments
    }
    JsonSerializer.prototype._writeHostObject = function(obj) {
      // Lib's ChildProcessSerializer calls this for non-stringifiable
      // host objects (typed arrays etc.). Override semantics: write a
      // length-prefixed JSON of {host: ...stringifiable view}.
      this.writeValue(obj);
    };
    JsonSerializer.prototype.writeHeader = function() {
      this._chunks.push(new Uint8Array([0xFF])); // 1-byte format marker
    };
    JsonSerializer.prototype.writeValue = function(v) {
      var json = JSON.stringify(v);
      var bytes = new TextEncoder().encode(json);
      var lenBytes = new Uint8Array(4);
      new DataView(lenBytes.buffer).setUint32(0, bytes.byteLength, true);
      this._chunks.push(lenBytes);
      this._chunks.push(bytes);
    };
    JsonSerializer.prototype.writeUint32 = function(n) {
      var b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      this._chunks.push(b);
    };
    JsonSerializer.prototype.writeRawBytes = function(b) {
      this._chunks.push(b instanceof Uint8Array ? b : new Uint8Array(b));
    };
    JsonSerializer.prototype.transferArrayBuffer = function() {};
    // v8.DefaultSerializer constructor calls this; no-op for json mode.
    JsonSerializer.prototype._setTreatArrayBufferViewsAsHostObjects = function() {};
    JsonSerializer.prototype.releaseBuffer = function() {
      var total = 0;
      for (var i = 0; i < this._chunks.length; i++) total += this._chunks[i].byteLength;
      var out = Buffer.allocUnsafe(total);
      var off = 0;
      for (var j = 0; j < this._chunks.length; j++) {
        out.set(this._chunks[j], off);
        off += this._chunks[j].byteLength;
      }
      return out;
    };
    function JsonDeserializer(buf) {
      this._buf = buf instanceof Uint8Array ? buf
        : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length || 0);
      this._off = 0;
    }
    JsonDeserializer.prototype._readHostObject = function() {
      return this.readValue();
    };
    JsonDeserializer.prototype.readHeader = function() {
      if (this._off < this._buf.byteLength) this._off++; // skip 0xFF marker
    };
    JsonDeserializer.prototype.readValue = function() {
      if (this._off + 4 > this._buf.byteLength) return undefined;
      var dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.byteLength);
      var len = dv.getUint32(this._off, true);
      this._off += 4;
      if (this._off + len > this._buf.byteLength) return undefined;
      var bytes = this._buf.subarray(this._off, this._off + len);
      this._off += len;
      try { return JSON.parse(new TextDecoder('utf-8').decode(bytes)); }
      catch (e) { void e; return undefined; }
    };
    JsonDeserializer.prototype.readUint32 = function() {
      if (this._off + 4 > this._buf.byteLength) return 0;
      var dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.byteLength);
      var n = dv.getUint32(this._off, true);
      this._off += 4;
      return n;
    };
    JsonDeserializer.prototype.transferArrayBuffer = function() {};
    serdesBinding.Serializer = JsonSerializer;
    serdesBinding.Deserializer = JsonDeserializer;
  }
})();

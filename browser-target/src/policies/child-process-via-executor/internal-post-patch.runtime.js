(function installSpawnSyncErrorPostPatch() {
  if (!module || !module.exports || typeof module.exports.spawnSync !== 'function') return;
  if (module.exports.__edgeSpawnSyncWrapped) return;
  var orig = module.exports.spawnSync;
  module.exports.spawnSync = function(options) {
    var r = orig.call(this, options);
    if (r && r.__edgeError) {
      var info = r.__edgeError;
      var err = new Error(info.message || ('spawn ' + info.code));
      err.code = info.code;
      err.errno = 0;
      err.syscall = info.syscall || 'spawnSync';
      if (options && options.file) err.path = options.file;
      if (options && Array.isArray(options.args)) {
        err.spawnargs = options.args.slice(1);
      }
      r.error = err;
      delete r.__edgeError;
    }
    return r;
  };
  module.exports.__edgeSpawnSyncWrapped = true;
})();

(function installAdvancedIpcOverride() {
  // P3.9: when ChildProcess is constructed with options.serialization='advanced'
  // AND an IPC channel, replace the byte-stream send/'message' path that
  // lib's setupChannel installs with a MessageChannel-backed structured-clone
  // path. wasm-side child.send(msg) -> port.postMessage(msg) -> full V8
  // structured-clone (Map, Set, Date, ArrayBuffer, circular refs) ->
  // host-side opts.ipc.on('message', cb) with the cloned value. JSON mode
  // (the default) keeps the existing byte-stream RPC path; no behavior
  // change there.
  var CP = module.exports.ChildProcess;
  if (!CP || !CP.prototype || typeof CP.prototype.spawn !== 'function') return;
  if (CP.__edgeAdvancedIpcWrapped) return;
  CP.__edgeAdvancedIpcWrapped = true;
  var g = (typeof globalThis !== 'undefined' && globalThis) ||
          (typeof global !== 'undefined' && global);
  var origSpawn = CP.prototype.spawn;
  CP.prototype.spawn = function(options) {
    var err = origSpawn.call(this, options);
    if (err !== 0 && err !== undefined) return err;
    var advanced = options && options.serialization === 'advanced';
    var hasChannel = !!(this.channel);
    if (!advanced || !hasChannel) return err;
    var register = g.__edgeChildProcessIpcStructuredRegister;
    var sender = g.__edgeChildProcessIpcStructuredSend;
    var disconnecter = g.__edgeChildProcessIpcStructuredDisconnect;
    var unregister = g.__edgeChildProcessIpcStructuredUnregister;
    if (typeof register !== 'function' || typeof sender !== 'function') return err;
    // childId is our Process binding's pid (set in EdgeProcess.spawn).
    var childId = this.pid;
    var self = this;
    // Register inbound: when host->wasm message arrives via port,
    // emit 'message' on the ChildProcess (bypassing setupChannel's
    // byte parser entirely).
    register(childId, function(msg) {
      // Match Node: 'message' event fires async via nextTick so user
      // listeners get a clean stack. If our send-side wrapped a
      // transferable sendHandle (P4.5), unpack the envelope and emit
      // 'message' with two args (msg, handle) the way Node does.
      // The EdgeProcess._isAdvancedIpc flag suppresses lib's UV_EOF
      // channel-null on EXIT for advanced-mode children, so the
      // `if (self.channel)` guard stays meaningful (user-called
      // disconnect still nulls channel; we don't fire post-disconnect).
      process.nextTick(function() {
        if (!self.channel) return;
        if (msg && typeof msg === 'object' && msg.__edgeSendHandle === true) {
          self.emit('message', msg.msg, msg.handle);
        } else {
          self.emit('message', msg);
        }
      });
    }, function() {
      if (self.channel) {
        self.channel = null;
        self.connected = false;
        process.nextTick(function() { self.emit('disconnect'); });
      }
    });
    // Replace outbound: target.send uses structured-clone via port.
    // P4.1: respect opts.transferList -- thread it through to
    // postMessage so ArrayBuffer / MessagePort / TypedArray ownership
    // transfers (zero-copy) instead of cloning. Sender's references
    // detach after the call, matching native postMessage semantics.
    // (Not a Node-native option name; this is an edge.js extension
    // since lib's target.send signature accepts an opts object but
    // Node uses it for {keepOpen, swallowErrors} only.)
    self.send = function(message, sendHandle, opts, callback) {
      if (typeof sendHandle === 'function') { callback = sendHandle; sendHandle = undefined; opts = undefined; }
      else if (typeof opts === 'function') { callback = opts; opts = undefined; }
      var transferList = (opts && Array.isArray(opts.transferList)) ? opts.transferList.slice() : null;
      var outboundMessage = message;
      // P4.5 sendHandle: real Node passes OS fds via SCM_RIGHTS (Unix) /
      // DuplicateHandle (Windows); we have no kernel and can't fake that
      // for net.Server / net.Socket -- those still get the warn-once and
      // dropped. For Transferable handles (MessagePort, ReadableStream,
      // WritableStream, ArrayBuffer) we have a real in-browser primitive:
      // wrap the value in an {__edgeSendHandle, msg, handle} envelope and
      // add the handle to the transferList so postMessage transfers
      // ownership. The receive side unwraps and emits ('message', msg,
      // handle). NOT a cluster.js substitute -- cluster shares listening
      // sockets, which is structurally impossible without an OS -- but
      // it does enable Transferable-based handle-sharing patterns.
      if (sendHandle != null) {
        // Supported handles:
        //   * ArrayBuffer -- natively transferable, ships directly.
        //   * MessagePort (edge.js shim) -- bridged via NativePortBridge:
        //     edge.js's MessagePort instances aren't recognized as
        //     transferable by the host port's postMessage ("Value at
        //     index 0 does not have a transferable type"), so we create
        //     a NATIVE MessageChannel pair, proxy messages bidirectionally
        //     between the user's edge.js port and our native local port,
        //     and transfer the native remote port across the wire. The
        //     receiver gets a real native MessagePort that works for
        //     postMessage on its side.
        // Unsupported:
        //   * net.Server / net.Socket -- need OS fd-passing (no kernel).
        //   * Readable/Writable streams -- same shim divergence as
        //     MessagePort but no equivalent native-transferable to bridge to.
        var nativeMessageChannel = (typeof globalThis !== 'undefined') && globalThis.__edgeNativeMessageChannel;
        var isEdgePort = nativeMessageChannel && sendHandle != null
          && typeof sendHandle === 'object'
          && typeof sendHandle.postMessage === 'function'
          && typeof sendHandle.on === 'function'
          && typeof sendHandle.start === 'function';
        if (sendHandle instanceof ArrayBuffer) {
          outboundMessage = { __edgeSendHandle: true, msg: message, handle: sendHandle };
          if (!transferList) transferList = [];
          if (transferList.indexOf(sendHandle) === -1) transferList.push(sendHandle);
        } else if (isEdgePort) {
          // NativePortBridge: pair edge.js port <-> native channel.
          var bridge = new nativeMessageChannel();
          var localNative = bridge.port1;
          var remoteNative = bridge.port2;
          // edge.js port -> local native (user's port emits 'message' on
          // outgoing, we forward to native side).
          sendHandle.on('message', function(payload) {
            try { localNative.postMessage(payload); } catch (e) { void e; }
          });
          // local native -> edge.js port (incoming on native side, fan
          // back to user's port). Setting onmessage auto-starts dispatch.
          localNative.onmessage = function(e) {
            try { sendHandle.postMessage(e.data); } catch (e2) { void e2; }
          };
          // Best-effort teardown: when user closes the edge.js port,
          // close the native local side too. (No 'close' event in Node
          // MessagePort but listening doesn't hurt; teardown also happens
          // naturally when the user code GCs the bridge.)
          if (typeof sendHandle.on === 'function') {
            sendHandle.on('close', function() {
              try { localNative.close(); } catch (e3) { void e3; }
            });
          }
          outboundMessage = { __edgeSendHandle: true, msg: message, handle: remoteNative };
          if (!transferList) transferList = [];
          transferList.push(remoteNative);
        } else {
          try {
            if (!self._edgeSendHandleWarned) {
              self._edgeSendHandleWarned = true;
              console.warn('[child-process-via-executor] child.send(msg, handle): supported handles are ArrayBuffer (direct transfer) and MessagePort (bridged to a native MessageChannel). net.Server / net.Socket -- the only handles Node itself supports here -- need OS fd-passing (SCM_RIGHTS / DuplicateHandle), which has no in-browser equivalent. Tracked as #!~debt child-process-ipc-sendhandle.');
            }
          } catch (_w) { void _w; }
        }
      }
      if (!self.channel || !self.connected) {
        var errc = new Error('Channel closed');
        errc.code = 'ERR_IPC_CHANNEL_CLOSED';
        if (typeof callback === 'function') process.nextTick(function() { callback(errc); });
        return false;
      }
      try { sender(childId, outboundMessage, transferList); }
      catch (e) {
        if (typeof callback === 'function') process.nextTick(function() { callback(e); });
        return false;
      }
      if (typeof callback === 'function') process.nextTick(function() { callback(null); });
      return true;
    };
    // Replace disconnect: notify host via port + clean up.
    var origDisconnect = self.disconnect;
    self.disconnect = function() {
      if (!self.connected) return;
      self.connected = false;
      try { disconnecter(childId); } catch (e) { void e; }
      unregister(childId);
      process.nextTick(function() { self.emit('disconnect'); });
      // Don't call origDisconnect -- it'd try to close the byte-stream
      // channel handle which we've bypassed.
      void origDisconnect;
    };
    // Cleanup on exit: lib's onexit closes channel, but we have our
    // own registration to drop too.
    self.once('exit', function() { try { unregister(childId); } catch (e) { void e; } });
    return err;
  };
})();

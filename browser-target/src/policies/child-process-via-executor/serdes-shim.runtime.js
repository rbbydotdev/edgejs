// Structured-clone-style serdes for internalBinding('serdes'). Installed
// as a pre-patch on BOTH lib/v8.js and lib/internal/child_process.js so
// the Serializer/Deserializer class destructures work whichever module
// is required first. Idempotent (returns early if already installed).
//
// We provide a Serializer/Deserializer that round-trips Map, Set, Date,
// BigInt, RegExp, ArrayBuffer, TypedArray, primitives, plain object/array,
// and back-references for cyclic graphs. Wire format is OUR OWN custom
// binary -- NOT V8-compatible, so serialized bytes can't be deserialized
// by Node.js v8.deserialize. (Real V8-format requires emitting their
// SerializationTag opcodes, varint lengths, host-object hooks, and an
// unreasonable amount of edge-case fidelity; if cross-runtime interop
// ever matters we'd vendor a published js-structured-clone implementation.)
//
// Format: header(1B 0xFE) then type-tagged values.
//   TAG_UNDEFINED 0x00
//   TAG_NULL      0x01
//   TAG_FALSE     0x02
//   TAG_TRUE      0x03
//   TAG_INT32     0x04 + i32 LE
//   TAG_DOUBLE    0x05 + f64 LE
//   TAG_STRING    0x06 + u32 byteLen + utf8 bytes
//   TAG_BIGINT    0x07 + u8 sign + u32 byteLen + bytes (big-endian magnitude)
//   TAG_MAP       0x08 + u32 size + [k v] * size
//   TAG_SET       0x09 + u32 size + v * size
//   TAG_DATE      0x0A + f64 ms LE
//   TAG_ARRAY     0x0B + u32 len + v * len
//   TAG_OBJECT    0x0C + u32 size + [str-key v] * size
//   TAG_ARRAYBUF  0x0D + u32 byteLen + bytes
//   TAG_TYPED_ARR 0x0E + u8 ctorIdx + u32 byteOffset + u32 length + v (its buffer)
//   TAG_REGEX     0x0F + str source + str flags
//   TAG_REF       0x10 + u32 refId  (back-reference to previously-seen object)
(function installSerdesShim() {
  var serdesBinding;
  try { serdesBinding = internalBinding('serdes'); } catch (_e) { void _e; return; }
  if (!serdesBinding || typeof serdesBinding.Serializer === 'function') return;

  var TAG_UNDEFINED = 0x00;
  var TAG_NULL = 0x01;
  var TAG_FALSE = 0x02;
  var TAG_TRUE = 0x03;
  var TAG_INT32 = 0x04;
  var TAG_DOUBLE = 0x05;
  var TAG_STRING = 0x06;
  var TAG_BIGINT = 0x07;
  var TAG_MAP = 0x08;
  var TAG_SET = 0x09;
  var TAG_DATE = 0x0A;
  var TAG_ARRAY = 0x0B;
  var TAG_OBJECT = 0x0C;
  var TAG_ARRAYBUF = 0x0D;
  var TAG_TYPED_ARR = 0x0E;
  var TAG_REGEX = 0x0F;
  var TAG_REF = 0x10;

  // TypedArray ctor index map. Lazy because edge.js mutates the
  // TypedArray globals mid-bootstrap; reading them eagerly at IIFE
  // load triggers a TDZ "Cannot access 'Uint8Array' before
  // initialization". See [[project-globalthis-mutation]].
  var _typedArrayCtors = null;
  function getTypedArrayCtors() {
    if (_typedArrayCtors === null) {
      _typedArrayCtors = [
        Int8Array, Uint8Array, Uint8ClampedArray,
        Int16Array, Uint16Array,
        Int32Array, Uint32Array,
        Float32Array, Float64Array,
        BigInt64Array, BigUint64Array,
        DataView,
      ];
    }
    return _typedArrayCtors;
  }
  function typedArrayCtorIndex(view) {
    var ctors = getTypedArrayCtors();
    for (var i = 0; i < ctors.length; i++) {
      if (view instanceof ctors[i]) return i;
    }
    return -1;
  }

  function Serializer() {
    this._chunks = [];
    this._refs = new Map(); // object -> refId
  }
  Serializer.prototype._setTreatArrayBufferViewsAsHostObjects = function() {};
  Serializer.prototype.transferArrayBuffer = function() {};
  Serializer.prototype._writeHostObject = function(v) {
    // lib's DefaultSerializer._writeHostObject calls writeUint32(typeIdx),
    // writeUint32(byteLen), writeRawBytes(bytes). Our writeValue already
    // handles TypedArrays + Buffer via TAG_TYPED_ARR, so the host hook
    // shouldn't normally fire -- but DefaultSerializer constructor sets
    // treatArrayBufferViewsAsHostObjects, and V8 would call this for
    // them. We trampoline back to writeValue so the type tag is
    // preserved either way.
    this.writeValue(v);
  };
  Serializer.prototype._push = function(buf) {
    this._chunks.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  };
  Serializer.prototype._pushU8 = function(n) {
    this._push(new Uint8Array([n & 0xff]));
  };
  Serializer.prototype._pushU32 = function(n) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this._push(b);
  };
  Serializer.prototype._pushI32 = function(n) {
    var b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n | 0, true);
    this._push(b);
  };
  Serializer.prototype._pushF64 = function(n) {
    var b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, +n, true);
    this._push(b);
  };
  Serializer.prototype._pushString = function(s) {
    var bytes = new TextEncoder().encode(String(s));
    this._pushU32(bytes.byteLength);
    this._push(bytes);
  };
  Serializer.prototype.writeHeader = function() {
    this._push(new Uint8Array([0xFE]));
  };
  Serializer.prototype.writeUint32 = function(n) { this._pushU32(n); };
  Serializer.prototype.writeRawBytes = function(b) {
    this._push(b instanceof Uint8Array ? b
      : new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength || b.length || 0));
  };
  Serializer.prototype.writeValue = function(v) {
    if (v === undefined) { this._pushU8(TAG_UNDEFINED); return; }
    if (v === null)      { this._pushU8(TAG_NULL); return; }
    if (v === false)     { this._pushU8(TAG_FALSE); return; }
    if (v === true)      { this._pushU8(TAG_TRUE); return; }
    var t = typeof v;
    if (t === 'number') {
      // Int32 fast path; otherwise double.
      if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
        this._pushU8(TAG_INT32); this._pushI32(v); return;
      }
      this._pushU8(TAG_DOUBLE); this._pushF64(v); return;
    }
    if (t === 'string') {
      this._pushU8(TAG_STRING); this._pushString(v); return;
    }
    if (t === 'bigint') {
      var sign = v < 0n ? 1 : 0;
      var abs = sign ? -v : v;
      // Pack into bytes, big-endian magnitude.
      var hex = abs.toString(16);
      if (hex.length % 2 === 1) hex = '0' + hex;
      var bytes = new Uint8Array(hex.length / 2);
      for (var i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      this._pushU8(TAG_BIGINT); this._pushU8(sign); this._pushU32(bytes.byteLength); this._push(bytes);
      return;
    }
    if (t !== 'object') {
      // function/symbol -> serialize as undefined (matches structuredClone
      // throwing DataCloneError, but we soft-fail to avoid breaking IPC).
      this._pushU8(TAG_UNDEFINED); return;
    }
    // Object/array/Map/Set/Date/RegExp/ArrayBuffer/TypedArray. Ref-track.
    var existingRef = this._refs.get(v);
    if (existingRef !== undefined) {
      this._pushU8(TAG_REF); this._pushU32(existingRef);
      return;
    }
    var refId = this._refs.size;
    this._refs.set(v, refId);
    if (v instanceof Date) {
      this._pushU8(TAG_DATE); this._pushF64(v.getTime()); return;
    }
    if (v instanceof RegExp) {
      this._pushU8(TAG_REGEX); this._pushString(v.source); this._pushString(v.flags); return;
    }
    if (v instanceof Map) {
      this._pushU8(TAG_MAP); this._pushU32(v.size);
      var mIter = v.entries(); var mE;
      while (!(mE = mIter.next()).done) {
        this.writeValue(mE.value[0]);
        this.writeValue(mE.value[1]);
      }
      return;
    }
    if (v instanceof Set) {
      this._pushU8(TAG_SET); this._pushU32(v.size);
      var sIter = v.values(); var sE;
      while (!(sE = sIter.next()).done) this.writeValue(sE.value);
      return;
    }
    if (v instanceof ArrayBuffer) {
      this._pushU8(TAG_ARRAYBUF); this._pushU32(v.byteLength);
      this._push(new Uint8Array(v));
      return;
    }
    var ctorIdx = typedArrayCtorIndex(v);
    if (ctorIdx >= 0) {
      this._pushU8(TAG_TYPED_ARR);
      this._pushU8(ctorIdx);
      this._pushU32(v.byteOffset);
      this._pushU32(v instanceof DataView ? v.byteLength : v.length);
      // Re-write the underlying buffer (will get its own refId).
      this.writeValue(v.buffer);
      return;
    }
    if (Array.isArray(v)) {
      this._pushU8(TAG_ARRAY); this._pushU32(v.length);
      for (var ai = 0; ai < v.length; ai++) this.writeValue(v[ai]);
      return;
    }
    // Plain object: enumerable own string keys (skip symbols + non-enumerable
    // to match JSON.stringify-ish surface; matches what structuredClone does
    // for own enumerable props).
    var keys = Object.keys(v);
    this._pushU8(TAG_OBJECT); this._pushU32(keys.length);
    for (var ki = 0; ki < keys.length; ki++) {
      this._pushString(keys[ki]);
      this.writeValue(v[keys[ki]]);
    }
  };
  Serializer.prototype.releaseBuffer = function() {
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
  // Lazy because Error global may not be initialized at PRE_PATCH time
  // when this runs on v8.js boot. See [[project-globalthis-mutation]].
  Object.defineProperty(Serializer.prototype, "_getDataCloneError", {
    configurable: true,
    get: function() { return Error; },
  });

  function Deserializer(buf) {
    // lib's DefaultDeserializer._readHostObject reads
    //   this.buffer.byteOffset + byteOffset
    // so `.buffer` must be a TypedArray-like (Buffer/Uint8Array). Keep
    // both buffer (typed-array) and _u8 (Uint8Array view) for our own use.
    if (buf instanceof Uint8Array) {
      this.buffer = buf;
      this._u8 = buf;
    } else {
      var u8 = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length || 0);
      this.buffer = buf;
      this._u8 = u8;
    }
    this._off = 0;
    this._refs = [];
  }
  Deserializer.prototype._readHostObject = function() {
    // Mirror writeValue: just call readValue. (lib's DefaultDeserializer
    // _readHostObject expects the wire shape produced by its own
    // _writeHostObject -- but we never produce that shape since our
    // writeValue handles TypedArrays directly. Defensive trampoline.)
    return this.readValue();
  };
  Deserializer.prototype.transferArrayBuffer = function() {};
  Deserializer.prototype._readU8 = function() {
    if (this._off >= this._u8.byteLength) return 0;
    return this._u8[this._off++];
  };
  Deserializer.prototype._readU32 = function() {
    if (this._off + 4 > this._u8.byteLength) return 0;
    var dv = new DataView(this._u8.buffer, this._u8.byteOffset, this._u8.byteLength);
    var n = dv.getUint32(this._off, true);
    this._off += 4;
    return n;
  };
  Deserializer.prototype._readI32 = function() {
    if (this._off + 4 > this._u8.byteLength) return 0;
    var dv = new DataView(this._u8.buffer, this._u8.byteOffset, this._u8.byteLength);
    var n = dv.getInt32(this._off, true);
    this._off += 4;
    return n;
  };
  Deserializer.prototype._readF64 = function() {
    if (this._off + 8 > this._u8.byteLength) return 0;
    var dv = new DataView(this._u8.buffer, this._u8.byteOffset, this._u8.byteLength);
    var n = dv.getFloat64(this._off, true);
    this._off += 8;
    return n;
  };
  Deserializer.prototype._readString = function() {
    var len = this._readU32();
    if (this._off + len > this._u8.byteLength) return '';
    var s = new TextDecoder('utf-8').decode(this._u8.subarray(this._off, this._off + len));
    this._off += len;
    return s;
  };
  Deserializer.prototype._readBytes = function(len) {
    if (this._off + len > this._u8.byteLength) return new Uint8Array(0);
    var copy = new Uint8Array(len);
    copy.set(this._u8.subarray(this._off, this._off + len));
    this._off += len;
    return copy;
  };
  Deserializer.prototype._readRawBytes = function(len) {
    // lib's DefaultDeserializer expects an OFFSET INTO this.buffer
    // (a byte offset relative to buffer's start). Used in conjunction
    // with this.buffer.byteOffset. Advance our cursor too.
    if (this._off + len > this._u8.byteLength) return 0;
    // Compute offset relative to .buffer (which is the user-supplied
    // Buffer/TypedArray, not our _u8 view -- match v8.js usage).
    var off = this._off;
    if (this.buffer && this.buffer !== this._u8) {
      // _u8 was constructed at (buffer.byteOffset, buffer.byteLength);
      // the offset we return is relative to buffer's start.
      off = (this.buffer.byteOffset || 0) + this._off - (this._u8.byteOffset || 0);
    }
    this._off += len;
    return off;
  };
  Deserializer.prototype.readHeader = function() {
    if (this._off < this._u8.byteLength && this._u8[this._off] === 0xFE) this._off++;
  };
  Deserializer.prototype.readUint32 = function() { return this._readU32(); };
  Deserializer.prototype.readValue = function() {
    if (this._off >= this._u8.byteLength) return undefined;
    var tag = this._readU8();
    switch (tag) {
      case TAG_UNDEFINED: return undefined;
      case TAG_NULL:      return null;
      case TAG_FALSE:     return false;
      case TAG_TRUE:      return true;
      case TAG_INT32:     return this._readI32();
      case TAG_DOUBLE:    return this._readF64();
      case TAG_STRING:    return this._readString();
      case TAG_BIGINT: {
        var sign = this._readU8();
        var len = this._readU32();
        var bytes = this._readBytes(len);
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
          var h = bytes[i].toString(16);
          if (h.length === 1) h = '0' + h;
          hex += h;
        }
        var bi = hex.length === 0 ? 0n : BigInt('0x' + hex);
        return sign ? -bi : bi;
      }
      case TAG_DATE: {
        var d = new Date(this._readF64());
        this._refs.push(d);
        return d;
      }
      case TAG_REGEX: {
        var src = this._readString();
        var flags = this._readString();
        var rx = new RegExp(src, flags);
        this._refs.push(rx);
        return rx;
      }
      case TAG_MAP: {
        var m = new Map();
        this._refs.push(m);
        var msize = this._readU32();
        for (var mi = 0; mi < msize; mi++) {
          var k = this.readValue();
          var val = this.readValue();
          m.set(k, val);
        }
        return m;
      }
      case TAG_SET: {
        var st = new Set();
        this._refs.push(st);
        var ssize = this._readU32();
        for (var si = 0; si < ssize; si++) st.add(this.readValue());
        return st;
      }
      case TAG_ARRAYBUF: {
        var ablen = this._readU32();
        var ab = new ArrayBuffer(ablen);
        new Uint8Array(ab).set(this._readBytes(ablen));
        this._refs.push(ab);
        return ab;
      }
      case TAG_TYPED_ARR: {
        var ctorIdx = this._readU8();
        var byteOffset = this._readU32();
        var length = this._readU32();
        var ab2 = this.readValue();
        var Ctor = getTypedArrayCtors()[ctorIdx] || Uint8Array;
        var ta = Ctor === DataView
          ? new DataView(ab2, byteOffset, length)
          : new Ctor(ab2, byteOffset, length);
        this._refs.push(ta);
        return ta;
      }
      case TAG_ARRAY: {
        var alen = this._readU32();
        var arr = new Array(alen);
        this._refs.push(arr);
        for (var ai = 0; ai < alen; ai++) arr[ai] = this.readValue();
        return arr;
      }
      case TAG_OBJECT: {
        var o = {};
        this._refs.push(o);
        var osize = this._readU32();
        for (var oi = 0; oi < osize; oi++) {
          var ok = this._readString();
          o[ok] = this.readValue();
        }
        return o;
      }
      case TAG_REF: {
        var rid = this._readU32();
        return this._refs[rid];
      }
      default:
        return undefined;
    }
  };
  serdesBinding.Serializer = Serializer;
  serdesBinding.Deserializer = Deserializer;
})();

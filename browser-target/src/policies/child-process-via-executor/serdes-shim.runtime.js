// V8-wire-format serdes for internalBinding('serdes'). Installed
// as a pre-patch on BOTH lib/v8.js and lib/internal/child_process.js so
// the Serializer/Deserializer class destructures work whichever module
// is required first. Idempotent (returns early if already installed).
//
// Wire format matches V8's ValueSerializer/ValueDeserializer exactly,
// so bytes produced here are byte-for-byte interchangeable with Node.js
// `v8.serialize()` output -- a webpack persistent cache (`.pack` file)
// written in browser-target can be read by Node, and vice versa.
//
// Spec reference: deps/v8/src/objects/value-serializer.cc, in particular
// the SerializationTag enum (lines 117-235) and the WriteVarint /
// WriteZigZag / WriteDouble helpers. Format version = 15 (V8 current).
//
// What this DOES NOT support yet:
//   - SharedArrayBuffer transfer (kSharedArrayBuffer 'u', kSharedObject 'p')
//   - Wasm modules / memory transfers (kWasmModuleTransfer 'w',
//     kWasmMemoryTransfer 'm')
//   - Error subtypes (kError 'r' subtags) -- emitted as plain object
//   - JSPrimitiveWrapper objects (Number/Boolean/String boxed) --
//     deserialize works, serialize emits as primitive
//   - Host objects via kHostObject '\\' -- relies on _writeHostObject hook
// These cover the long tail; the 80% of cases real build-tool caches
// use (Int32, Double, String, Map, Set, Date, BigInt, ArrayBuffer,
// TypedArray, Object, Array, RegExp, refs/cycles, primitives) are
// handled with full V8 fidelity.
(function installSerdesShim() {
  var serdesBinding;
  try { serdesBinding = internalBinding('serdes'); } catch (_e) { void _e; return; }
  if (!serdesBinding || typeof serdesBinding.Serializer === 'function') return;

  // SerializationTag enum -- single ASCII byte each. Copied verbatim
  // from deps/v8/src/objects/value-serializer.cc:117 so cross-checking
  // the spec is mechanical. Renamed kFoo → TAG_FOO for JS style.
  var TAG_VERSION = 0xFF;
  var TAG_THE_HOLE = 0x2D; // '-'
  var TAG_UNDEFINED = 0x5F; // '_'
  var TAG_NULL = 0x30; // '0'
  var TAG_TRUE = 0x54; // 'T'
  var TAG_FALSE = 0x46; // 'F'
  var TAG_INT32 = 0x49; // 'I'  zigzag-varint
  var TAG_UINT32 = 0x55; // 'U'  varint
  var TAG_DOUBLE = 0x4E; // 'N'  8 bytes host-endian (LE on browser/x64/arm)
  var TAG_BIGINT = 0x5A; // 'Z'
  var TAG_UTF8_STRING = 0x53; // 'S'  varint(len) + utf8 bytes
  var TAG_ONE_BYTE_STRING = 0x22; // '"'  varint(len) + latin1 bytes
  var TAG_TWO_BYTE_STRING = 0x63; // 'c'  varint(byteLen) + UTF-16 bytes
  var TAG_OBJECT_REFERENCE = 0x5E; // '^'  varint(objectId)
  var TAG_BEGIN_OBJECT = 0x6F; // 'o'
  var TAG_END_OBJECT = 0x7B; // '{'  varint(numProperties)
  var TAG_BEGIN_SPARSE_ARRAY = 0x61; // 'a'
  var TAG_END_SPARSE_ARRAY = 0x40; // '@'  varint(numProperties) varint(length)
  var TAG_BEGIN_DENSE_ARRAY = 0x41; // 'A'  varint(length)
  var TAG_END_DENSE_ARRAY = 0x24; // '$'  varint(numProperties) varint(length)
  var TAG_DATE = 0x44; // 'D'  double(ms)
  var TAG_TRUE_OBJECT = 0x79; // 'y'
  var TAG_FALSE_OBJECT = 0x78; // 'x'
  var TAG_NUMBER_OBJECT = 0x6E; // 'n'  double
  var TAG_BIGINT_OBJECT = 0x7A; // 'z'
  var TAG_STRING_OBJECT = 0x73; // 's'
  var TAG_REGEXP = 0x52; // 'R'  string(source) varint(flags)
  var TAG_BEGIN_MAP = 0x3B; // ';'
  var TAG_END_MAP = 0x3A; // ':'  varint(length)
  var TAG_BEGIN_SET = 0x27; // "'"
  var TAG_END_SET = 0x2C; // ','  varint(length)
  var TAG_ARRAY_BUFFER = 0x42; // 'B'  varint(byteLen) + bytes
  var TAG_ARRAY_BUFFER_VIEW = 0x56; // 'V'  subtag + varint(byteOffset) + varint(byteLen) + flags
  var TAG_HOST_OBJECT = 0x5C; // '\\'  delegate-managed

  // ArrayBufferView subtags (deps/v8/include/v8-value-serializer.h:25).
  // Order matters -- these are wire indices.
  var VIEW_INT8 = 0x62;     // 'b'
  var VIEW_UINT8 = 0x42;    // 'B'
  var VIEW_UINT8_CLAMPED = 0x43; // 'C'
  var VIEW_INT16 = 0x77;    // 'w'
  var VIEW_UINT16 = 0x57;   // 'W'
  var VIEW_INT32 = 0x64;    // 'd'
  var VIEW_UINT32 = 0x44;   // 'D'
  var VIEW_FLOAT16 = 0x68;  // 'h'
  var VIEW_FLOAT32 = 0x66;  // 'f'
  var VIEW_FLOAT64 = 0x46;  // 'F'
  var VIEW_BIGINT64 = 0x71; // 'q'
  var VIEW_BIGUINT64 = 0x51; // 'Q'
  var VIEW_DATA_VIEW = 0x3F; // '?'

  var WIRE_VERSION = 15; // V8's kLatestVersion (must match deps/v8/.../value-serializer.cc)

  // TypedArray ctor index map. Lazy because edge.js mutates the
  // TypedArray globals mid-bootstrap; reading them eagerly at IIFE
  // load triggers a TDZ "Cannot access 'Uint8Array' before
  // initialization". See [[project-globalthis-mutation]].
  var _typedArrayCtors = null;
  function getTypedArrayCtors() {
    if (_typedArrayCtors === null) {
      // [tag, ctor, bytesPerElement]
      _typedArrayCtors = [
        [VIEW_INT8, Int8Array, 1],
        [VIEW_UINT8, Uint8Array, 1],
        [VIEW_UINT8_CLAMPED, Uint8ClampedArray, 1],
        [VIEW_INT16, Int16Array, 2],
        [VIEW_UINT16, Uint16Array, 2],
        [VIEW_INT32, Int32Array, 4],
        [VIEW_UINT32, Uint32Array, 4],
        [VIEW_FLOAT32, Float32Array, 4],
        [VIEW_FLOAT64, Float64Array, 8],
        [VIEW_BIGINT64, BigInt64Array, 8],
        [VIEW_BIGUINT64, BigUint64Array, 8],
        [VIEW_DATA_VIEW, DataView, 1],
      ];
    }
    return _typedArrayCtors;
  }
  function viewTagOf(view) {
    var ctors = getTypedArrayCtors();
    for (var i = 0; i < ctors.length; i++) {
      if (view instanceof ctors[i][1]) return ctors[i];
    }
    return null;
  }
  function ctorByTag(tag) {
    var ctors = getTypedArrayCtors();
    for (var i = 0; i < ctors.length; i++) {
      if (ctors[i][0] === tag) return ctors[i];
    }
    return null;
  }

  // ===== Serializer =====
  //
  // Buffer grows as Uint8Array chunks; releaseBuffer concatenates into a
  // single Node Buffer at the end. _refs maps already-seen objects to
  // their object-id (0-based) for back-references / cycle handling.
  function Serializer() {
    this._chunks = [];
    this._byteLen = 0;
    this._refs = new Map();
    this._nextRefId = 0;
  }
  Serializer.prototype._setTreatArrayBufferViewsAsHostObjects = function() {};
  Serializer.prototype.transferArrayBuffer = function() {};
  Serializer.prototype._writeHostObject = function(v) {
    // Default: trampoline back to writeValue so we still emit the value
    // via standard tags. lib's DefaultSerializer overrides this to emit
    // a (type-index, byteLength, bytes) triple via writeUint32 +
    // writeRawBytes. That subclass-overridden path still produces
    // V8-shape bytes because writeUint32/writeRawBytes call our varint
    // / raw helpers.
    this.writeValue(v);
  };
  // Lazy because Error global may not be initialized at PRE_PATCH time
  // when this runs on v8.js boot. See [[project-globalthis-mutation]].
  Object.defineProperty(Serializer.prototype, '_getDataCloneError', {
    configurable: true,
    get: function() { return Error; },
  });
  Serializer.prototype._pushBytes = function(buf) {
    this._chunks.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    this._byteLen += buf.byteLength;
  };
  Serializer.prototype._pushU8 = function(b) {
    this._pushBytes(new Uint8Array([b & 0xff]));
  };
  // Unsigned varint (base-128). V8: value-serializer.cc:334.
  Serializer.prototype._writeVarint = function(value) {
    // Allow values up to 2^53 (JS safe int). For larger BigInt cases
    // we use a separate path (BigInt magnitude written as raw digits).
    var bytes = [];
    var v = value;
    do {
      bytes.push((v & 0x7F) | 0x80);
      // Shift right by 7. JS bitwise ops are 32-bit so use Math.floor
      // for safe-int values > 2^32. We never exceed 2^53 in practice.
      v = (v >= 0x100000000) ? Math.floor(v / 128) : (v >>> 7);
    } while (v);
    bytes[bytes.length - 1] &= 0x7F;
    this._pushBytes(new Uint8Array(bytes));
  };
  // ZigZag-encoded signed int32 → unsigned varint. V8: WriteZigZag:352.
  Serializer.prototype._writeZigZagInt32 = function(value) {
    var u = ((value << 1) ^ (value >> 31)) >>> 0;
    this._writeVarint(u);
  };
  // Host-endian double (8 bytes). Browser is LE on all current targets;
  // matches V8 on x64/arm64. V8: WriteDouble:368 -- explicit warning
  // about endianness in V8 source.
  Serializer.prototype._writeDouble = function(value) {
    var buf = new Uint8Array(8);
    new DataView(buf.buffer).setFloat64(0, value, true /* little-endian */);
    this._pushBytes(buf);
  };
  Serializer.prototype.writeHeader = function() {
    this._pushU8(TAG_VERSION);
    this._writeVarint(WIRE_VERSION);
  };
  Serializer.prototype.writeUint32 = function(n) { this._writeVarint(n >>> 0); };
  Serializer.prototype.writeUint64 = function(hi, lo) {
    // hi/lo are u32 halves. Reconstruct as JS number if safe; else
    // fallback to BigInt math. Most callers (lib v8.js) pass 0 for hi.
    var v = hi * 0x100000000 + (lo >>> 0);
    this._writeVarint(v);
  };
  Serializer.prototype.writeDouble = function(n) { this._writeDouble(n); };
  Serializer.prototype.writeRawBytes = function(b) {
    this._pushBytes(b instanceof Uint8Array ? b
      : new Uint8Array(b.buffer || b, b.byteOffset || 0, b.byteLength || b.length || 0));
  };
  // Write a JS string in the smallest applicable encoding (matches V8's
  // strategy of picking OneByte if all chars < 256, else TwoByte).
  Serializer.prototype._writeString = function(s) {
    var str = String(s);
    var allLatin1 = true;
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0xFF) { allLatin1 = false; break; }
    }
    if (allLatin1) {
      this._pushU8(TAG_ONE_BYTE_STRING);
      this._writeVarint(str.length);
      var b1 = new Uint8Array(str.length);
      for (var j = 0; j < str.length; j++) b1[j] = str.charCodeAt(j);
      this._pushBytes(b1);
    } else {
      this._pushU8(TAG_TWO_BYTE_STRING);
      var byteLen = str.length * 2;
      this._writeVarint(byteLen);
      var b2 = new Uint8Array(byteLen);
      var dv = new DataView(b2.buffer);
      for (var k = 0; k < str.length; k++) {
        dv.setUint16(k * 2, str.charCodeAt(k), true /* LE */);
      }
      this._pushBytes(b2);
    }
  };
  Serializer.prototype._writeBigInt = function(bi) {
    // V8 format: bitfield:varint, then raw digits (LE 64-bit words).
    // Bitfield layout (deps/v8/src/objects/bigint.h):
    //   bit 0      = sign (1 = negative)
    //   bits 1..31 = length in 64-bit digits
    var sign = bi < 0n ? 1 : 0;
    var abs = sign ? -bi : bi;
    // Pack into 64-bit digits (LE bytes within each digit).
    var digits = [];
    var rem = abs;
    while (rem > 0n) {
      digits.push(rem & 0xFFFFFFFFFFFFFFFFn);
      rem >>= 64n;
    }
    if (digits.length === 0) digits.push(0n);
    var bitfield = (digits.length << 1) | sign;
    this._writeVarint(bitfield);
    // Each digit is 8 bytes LE.
    var buf = new Uint8Array(digits.length * 8);
    var dv = new DataView(buf.buffer);
    for (var i = 0; i < digits.length; i++) {
      dv.setBigUint64(i * 8, digits[i], true /* LE */);
    }
    this._pushBytes(buf);
  };
  Serializer.prototype.writeValue = function(v) {
    if (v === undefined) { this._pushU8(TAG_UNDEFINED); return; }
    if (v === null)      { this._pushU8(TAG_NULL); return; }
    if (v === true)      { this._pushU8(TAG_TRUE); return; }
    if (v === false)     { this._pushU8(TAG_FALSE); return; }
    var t = typeof v;
    if (t === 'number') {
      // Int32 fast path (ZigZag-varint); else Double.
      if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
        this._pushU8(TAG_INT32);
        this._writeZigZagInt32(v);
        return;
      }
      this._pushU8(TAG_DOUBLE);
      this._writeDouble(v);
      return;
    }
    if (t === 'string') {
      this._writeString(v);
      return;
    }
    if (t === 'bigint') {
      this._pushU8(TAG_BIGINT);
      this._writeBigInt(v);
      return;
    }
    if (t !== 'object') {
      // function / symbol -- soft-fail as undefined (V8 would throw
      // DataCloneError, but our IPC use case prefers silent drop).
      this._pushU8(TAG_UNDEFINED);
      return;
    }
    // Object types -- consult ref table first for cycle/back-ref.
    var existingRef = this._refs.get(v);
    if (existingRef !== undefined) {
      this._pushU8(TAG_OBJECT_REFERENCE);
      this._writeVarint(existingRef);
      return;
    }
    // Assign refId BEFORE writing nested content (so nested refs to
    // self resolve).
    var refId = this._nextRefId++;
    this._refs.set(v, refId);

    if (v instanceof Date) {
      this._pushU8(TAG_DATE);
      this._writeDouble(v.getTime());
      return;
    }
    if (v instanceof RegExp) {
      this._pushU8(TAG_REGEXP);
      this._writeString(v.source);
      // V8 regexp flags bitfield (deps/v8/src/regexp/regexp-flags.h):
      //   global=1, ignoreCase=2, multiline=4, sticky=8, unicode=16,
      //   dotAll=32, unicodeSets=64, hasIndices=128
      var f = 0;
      if (v.global)      f |= 1;
      if (v.ignoreCase)  f |= 2;
      if (v.multiline)   f |= 4;
      if (v.sticky)      f |= 8;
      if (v.unicode)     f |= 16;
      if (v.dotAll)      f |= 32;
      if (v.unicodeSets) f |= 64;
      if (v.hasIndices)  f |= 128;
      this._writeVarint(f);
      return;
    }
    if (v instanceof Map) {
      this._pushU8(TAG_BEGIN_MAP);
      var mCount = 0;
      var mIter = v.entries();
      var mE;
      while (!(mE = mIter.next()).done) {
        this.writeValue(mE.value[0]);
        this.writeValue(mE.value[1]);
        mCount += 2;
      }
      this._pushU8(TAG_END_MAP);
      this._writeVarint(mCount);
      return;
    }
    if (v instanceof Set) {
      this._pushU8(TAG_BEGIN_SET);
      var sCount = 0;
      var sIter = v.values();
      var sE;
      while (!(sE = sIter.next()).done) {
        this.writeValue(sE.value);
        sCount++;
      }
      this._pushU8(TAG_END_SET);
      this._writeVarint(sCount);
      return;
    }
    if (v instanceof ArrayBuffer) {
      this._pushU8(TAG_ARRAY_BUFFER);
      this._writeVarint(v.byteLength);
      this._pushBytes(new Uint8Array(v));
      return;
    }
    var viewMeta = viewTagOf(v);
    if (viewMeta) {
      // V8 quirk (value-serializer.cc:191-196): ArrayBufferView is
      // ALWAYS preceded by its underlying ArrayBuffer (or ObjectReference
      // to one) in the byte stream. We write the buffer first, THEN
      // the view tag.
      this.writeValue(v.buffer);
      this._pushU8(TAG_ARRAY_BUFFER_VIEW);
      this._pushU8(viewMeta[0]); // subtag
      this._writeVarint(v.byteOffset);
      this._writeVarint(v.byteLength);
      // Flags field added in version 14: bit 0 = isLengthTracking (for
      // resizable AB). Always 0 here.
      this._writeVarint(0);
      return;
    }
    if (Array.isArray(v)) {
      // Use dense array encoding. V8 also supports sparse with property
      // pairs; for plain JS arrays without sparse holes, dense is simpler
      // and round-trips correctly.
      this._pushU8(TAG_BEGIN_DENSE_ARRAY);
      this._writeVarint(v.length);
      for (var ai = 0; ai < v.length; ai++) this.writeValue(v[ai]);
      // Own enumerable string-keyed properties beyond array indices
      // (rare; e.g. `arr.foo = 1`). Count + emit as k,v pairs.
      var arrProps = [];
      var arrKeys = Object.keys(v);
      for (var aki = 0; aki < arrKeys.length; aki++) {
        var ak = arrKeys[aki];
        if (!/^\d+$/.test(ak) || Number(ak) >= v.length) arrProps.push(ak);
      }
      for (var apj = 0; apj < arrProps.length; apj++) {
        this._writeString(arrProps[apj]);
        this.writeValue(v[arrProps[apj]]);
      }
      this._pushU8(TAG_END_DENSE_ARRAY);
      this._writeVarint(arrProps.length);
      this._writeVarint(v.length);
      return;
    }
    // Plain object: own enumerable string-keyed properties.
    this._pushU8(TAG_BEGIN_OBJECT);
    var keys = Object.keys(v);
    var oCount = 0;
    for (var ki = 0; ki < keys.length; ki++) {
      this._writeString(keys[ki]);
      this.writeValue(v[keys[ki]]);
      oCount += 2;
    }
    this._pushU8(TAG_END_OBJECT);
    this._writeVarint(oCount);
  };
  Serializer.prototype.releaseBuffer = function() {
    var out = Buffer.allocUnsafe(this._byteLen);
    var off = 0;
    for (var i = 0; i < this._chunks.length; i++) {
      out.set(this._chunks[i], off);
      off += this._chunks[i].byteLength;
    }
    return out;
  };

  // ===== Deserializer =====
  //
  // Reads from a Buffer/Uint8Array. this.buffer must be the user-supplied
  // typed-array (lib's DefaultDeserializer reads this.buffer.byteOffset
  // when interpreting _readRawBytes() return values).
  function Deserializer(buf) {
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
    this._version = 0;
  }
  Deserializer.prototype._readHostObject = function() {
    return this.readValue();
  };
  Deserializer.prototype.transferArrayBuffer = function() {};
  Deserializer.prototype._readU8 = function() {
    if (this._off >= this._u8.byteLength) return 0;
    return this._u8[this._off++];
  };
  Deserializer.prototype._peekU8 = function() {
    if (this._off >= this._u8.byteLength) return -1;
    return this._u8[this._off];
  };
  Deserializer.prototype._readVarint = function() {
    var result = 0;
    var shift = 0;
    for (;;) {
      if (this._off >= this._u8.byteLength) return 0;
      var b = this._u8[this._off++];
      if (shift < 32) {
        // Stay in u32 range as long as we can.
        result = (result | ((b & 0x7F) << shift)) >>> 0;
      } else {
        // Switch to floating-point math for values > 2^32.
        result += (b & 0x7F) * Math.pow(2, shift);
      }
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  Deserializer.prototype._readZigZagInt32 = function() {
    var u = this._readVarint() >>> 0;
    // Reverse zigzag: (u >>> 1) XOR -(u & 1)
    return (u >>> 1) ^ -(u & 1);
  };
  Deserializer.prototype._readDouble = function() {
    if (this._off + 8 > this._u8.byteLength) return 0;
    var dv = new DataView(this._u8.buffer, this._u8.byteOffset + this._off, 8);
    var n = dv.getFloat64(0, true /* LE */);
    this._off += 8;
    return n;
  };
  Deserializer.prototype._readBytes = function(len) {
    if (this._off + len > this._u8.byteLength) return new Uint8Array(0);
    var copy = new Uint8Array(len);
    copy.set(this._u8.subarray(this._off, this._off + len));
    this._off += len;
    return copy;
  };
  Deserializer.prototype._readRawBytes = function(len) {
    // lib's DefaultDeserializer expects an offset INTO this.buffer (the
    // user-supplied typed-array, not our _u8 view). Used with
    // this.buffer.byteOffset to build a Buffer slice.
    if (this._off + len > this._u8.byteLength) return 0;
    var off = this._off;
    if (this.buffer && this.buffer !== this._u8) {
      off = (this.buffer.byteOffset || 0) + this._off - (this._u8.byteOffset || 0);
    }
    this._off += len;
    return off;
  };
  Deserializer.prototype.readHeader = function() {
    if (this._peekU8() === TAG_VERSION) {
      this._off++;
      this._version = this._readVarint();
    } else {
      this._version = 0;
    }
    return true;
  };
  Deserializer.prototype.readUint32 = function() { return this._readVarint() >>> 0; };
  Deserializer.prototype.readUint64 = function() {
    var v = this._readVarint();
    var hi = Math.floor(v / 0x100000000) >>> 0;
    var lo = (v >>> 0);
    return [hi, lo];
  };
  Deserializer.prototype.readDouble = function() { return this._readDouble(); };
  Deserializer.prototype.getWireFormatVersion = function() { return this._version; };
  Deserializer.prototype._readStringTagged = function(tag) {
    var len = this._readVarint();
    if (tag === TAG_ONE_BYTE_STRING) {
      var b = this._u8.subarray(this._off, this._off + len);
      this._off += len;
      var s = '';
      for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
      return s;
    }
    if (tag === TAG_TWO_BYTE_STRING) {
      // byteLen, NOT charLen.
      var byteLen = len;
      var charLen = byteLen >>> 1;
      var dv = new DataView(this._u8.buffer, this._u8.byteOffset + this._off, byteLen);
      var s2 = '';
      for (var k = 0; k < charLen; k++) {
        s2 += String.fromCharCode(dv.getUint16(k * 2, true /* LE */));
      }
      this._off += byteLen;
      return s2;
    }
    if (tag === TAG_UTF8_STRING) {
      var bytes = this._u8.subarray(this._off, this._off + len);
      this._off += len;
      return new TextDecoder('utf-8').decode(bytes);
    }
    return '';
  };
  Deserializer.prototype._readString = function() {
    var t = this._readU8();
    return this._readStringTagged(t);
  };
  Deserializer.prototype._readBigInt = function() {
    var bitfield = this._readVarint();
    var sign = bitfield & 1;
    var numDigits = bitfield >>> 1;
    var byteLen = numDigits * 8;
    if (this._off + byteLen > this._u8.byteLength) return 0n;
    var dv = new DataView(this._u8.buffer, this._u8.byteOffset + this._off, byteLen);
    var result = 0n;
    for (var i = numDigits - 1; i >= 0; i--) {
      result = (result << 64n) | dv.getBigUint64(i * 8, true /* LE */);
    }
    this._off += byteLen;
    return sign ? -result : result;
  };
  Deserializer.prototype.readValue = function() {
    var tag = this._readU8();
    switch (tag) {
      case TAG_UNDEFINED:   return undefined;
      case TAG_NULL:        return null;
      case TAG_TRUE:        return true;
      case TAG_FALSE:       return false;
      case TAG_TRUE_OBJECT: return Object(true);
      case TAG_FALSE_OBJECT: return Object(false);
      case TAG_INT32:       return this._readZigZagInt32();
      case TAG_UINT32:      return this._readVarint() >>> 0;
      case TAG_DOUBLE:      return this._readDouble();
      case TAG_NUMBER_OBJECT: return Object(this._readDouble());
      case TAG_BIGINT:      return this._readBigInt();
      case TAG_BIGINT_OBJECT: return Object(this._readBigInt());
      case TAG_ONE_BYTE_STRING:
      case TAG_TWO_BYTE_STRING:
      case TAG_UTF8_STRING:
        return this._readStringTagged(tag);
      case TAG_STRING_OBJECT: return Object(this._readString());
      case TAG_DATE: {
        var d = new Date(this._readDouble());
        this._refs.push(d);
        return d;
      }
      case TAG_REGEXP: {
        var src = this._readString();
        var fbits = this._readVarint();
        var fstr = '';
        if (fbits & 1)   fstr += 'g';
        if (fbits & 2)   fstr += 'i';
        if (fbits & 4)   fstr += 'm';
        if (fbits & 8)   fstr += 'y';
        if (fbits & 16)  fstr += 'u';
        if (fbits & 32)  fstr += 's';
        if (fbits & 64)  fstr += 'v';
        if (fbits & 128) fstr += 'd';
        var rx = new RegExp(src, fstr);
        this._refs.push(rx);
        return rx;
      }
      case TAG_BEGIN_MAP: {
        var m = new Map();
        this._refs.push(m);
        while (this._peekU8() !== TAG_END_MAP) {
          var mk = this.readValue();
          var mv = this.readValue();
          m.set(mk, mv);
        }
        this._readU8(); // consume end tag
        this._readVarint(); // length (= 2 * size)
        return m;
      }
      case TAG_BEGIN_SET: {
        var st = new Set();
        this._refs.push(st);
        while (this._peekU8() !== TAG_END_SET) {
          st.add(this.readValue());
        }
        this._readU8(); // consume end tag
        this._readVarint(); // length
        return st;
      }
      case TAG_BEGIN_OBJECT: {
        var o = {};
        this._refs.push(o);
        while (this._peekU8() !== TAG_END_OBJECT) {
          var ok = this._readString();
          o[ok] = this.readValue();
        }
        this._readU8(); // consume end tag
        this._readVarint(); // numProperties
        return o;
      }
      case TAG_BEGIN_DENSE_ARRAY: {
        var alen = this._readVarint();
        var arr = new Array(alen);
        this._refs.push(arr);
        for (var ai = 0; ai < alen; ai++) arr[ai] = this.readValue();
        // Then sparse properties until END_DENSE_ARRAY.
        while (this._peekU8() !== TAG_END_DENSE_ARRAY) {
          var pk = this._readString();
          arr[pk] = this.readValue();
        }
        this._readU8(); // consume end tag
        this._readVarint(); // numProperties
        this._readVarint(); // length
        return arr;
      }
      case TAG_BEGIN_SPARSE_ARRAY: {
        var sLen = this._readVarint();
        var sArr = new Array(sLen);
        this._refs.push(sArr);
        while (this._peekU8() !== TAG_END_SPARSE_ARRAY) {
          var spk = this._readString();
          sArr[spk] = this.readValue();
        }
        this._readU8();
        this._readVarint();
        this._readVarint();
        return sArr;
      }
      case TAG_ARRAY_BUFFER: {
        var ablen = this._readVarint();
        var ab = new ArrayBuffer(ablen);
        new Uint8Array(ab).set(this._readBytes(ablen));
        this._refs.push(ab);
        // Look ahead: ArrayBufferView tag immediately following an
        // ArrayBuffer rebinds the ref to the view (V8 quirk).
        if (this._peekU8() === TAG_ARRAY_BUFFER_VIEW) {
          this._readU8();
          return this._readArrayBufferView(ab);
        }
        return ab;
      }
      case TAG_ARRAY_BUFFER_VIEW: {
        // View without preceding buffer: previous ref must be an AB.
        var prevAb = this._refs[this._refs.length - 1];
        return this._readArrayBufferView(prevAb);
      }
      case TAG_OBJECT_REFERENCE: {
        var rid = this._readVarint();
        return this._refs[rid];
      }
      case TAG_THE_HOLE: return undefined;
      case TAG_HOST_OBJECT: return this._readHostObject();
      default:
        return undefined;
    }
  };
  Deserializer.prototype._readArrayBufferView = function(ab) {
    var subtag = this._readU8();
    var byteOffset = this._readVarint();
    var byteLength = this._readVarint();
    // Flags field, version 14+.
    this._readVarint();
    var meta = ctorByTag(subtag);
    if (!meta) return ab;
    var Ctor = meta[1];
    var bpe = meta[2];
    var view;
    if (Ctor === DataView) {
      view = new DataView(ab, byteOffset, byteLength);
    } else {
      view = new Ctor(ab, byteOffset, byteLength / bpe);
    }
    this._refs.push(view);
    return view;
  };
  serdesBinding.Serializer = Serializer;
  serdesBinding.Deserializer = Deserializer;
})();

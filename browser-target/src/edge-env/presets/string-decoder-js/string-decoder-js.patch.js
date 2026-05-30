// Pre-patch on lib/string_decoder.js: replace internalBinding('string_decoder')
// decode/flush with pure-JS implementations.
//
// THE BUG
//
// Edge's native `internalBinding('string_decoder').decode` ultimately runs
// through `Buffer.from(bytes).toString(encoding)` in edge_string_decoder.cc
// (the "First try" path at line 216).  For:
//
//   - UTF-8 with invalid sequences (e.g. C9 B5 A9 41) we get back garbage
//     surrogate-paired output instead of the documented U+0275 U+FFFD A.
//   - base64 the wasm-side encoder/decoder truncates trailing bytes on
//     certain inputs (same root cause buffer-base64 preset works around
//     via the vendored unenv decoder).
//
// THE FIX
//
// Replace decode/flush at the binding layer with JS impls that:
//   - For utf8: use a hand-rolled WHATWG-style UTF-8 decoder that emits
//     U+FFFD per ill-formed sequence, matching Node's invalid-byte handling.
//   - For utf16le: build a u16string from byte pairs.
//   - For base64/base64url: route the full accumulated input through
//     globalThis.__edgeDecodeBase64 (vendored unenv decoder) then decode
//     the resulting bytes as Latin1 chars (placeholder — base64 decode
//     output bytes are NOT meant to be re-encoded; we hand back exactly
//     the bytes Node's Buffer.toString('base64'/'base64url') would produce
//     when given the original bytes, NOT decode-then-re-encode).
//
// Actually the wire protocol is different.  Re-read the C++ impl.  The
// `decode(state, buf)` binding takes raw input BYTES and returns the
// DECODED STRING.  For UTF-8 in: bytes; out: string.  For base64 in:
// bytes; out: bytes encoded AS base64-string.  In other words, "decode"
// here means "render bytes into a string using the encoding's lossless
// representation".  So for utf8 it's a UTF-8 decoder; for base64 it's
// a base64 ENCODER (bytes → base64 string).  For utf16le it's a UTF-16LE
// decoder (bytes → JS string).
//
// State management mirrors C++ DecodeBinding semantics:
//   - state[0..3]: incomplete bytes carried across writes
//   - state[4] (kMissingBytes): bytes still needed to finish carryover
//   - state[5] (kBufferedBytes): bytes currently held in [0..3]
//   - state[6] (kEncodingField): encoding ID
//
// Encoding IDs (from src/edge_encoding_ids.h):
//   kEncAscii=0, kEncUtf8=1, kEncBase64=2, kEncBase64Url=3,
//   kEncUtf16Le=4, kEncHex=5, kEncBuffer=6, kEncLatin1=7

;(function patchStringDecoderBinding() {
  if (typeof internalBinding !== "function") return;
  var b;
  try { b = internalBinding("string_decoder"); } catch (_e) { return; }
  if (!b) return;
  if (b.__edgeStringDecoderJsPatched) return;

  var kIncompleteStart = 0;
  var kMissingBytes = 4;
  var kBufferedBytes = 5;
  var kEncodingField = 6;

  var ENC_ASCII = 0;
  var ENC_UTF8 = 1;
  var ENC_BASE64 = 2;
  var ENC_BASE64_URL = 3;
  var ENC_UTF16LE = 4;
  var ENC_HEX = 5;
  var ENC_LATIN1 = 7;

  // ----- helpers shared by all encodings -----

  // Decode `data[off..off+len]` as UTF-8 to a JS string, replacing every
  // ill-formed byte sequence with U+FFFD.  Mirrors the C++ MakeStringFromBytes
  // UTF-8 path which itself follows WHATWG's UTF-8 decoder.
  function decodeUtf8(data, off, len) {
    var s = "";
    var i = 0;
    while (i < len) {
      var b0 = data[off + i];
      if (b0 < 0x80) {
        s += String.fromCharCode(b0);
        i++;
        continue;
      }
      var needed, cp, minCp;
      if (b0 >= 0xC2 && b0 <= 0xDF) { needed = 1; cp = b0 & 0x1F; minCp = 0x80; }
      else if (b0 >= 0xE0 && b0 <= 0xEF) { needed = 2; cp = b0 & 0x0F; minCp = 0x800; }
      else if (b0 >= 0xF0 && b0 <= 0xF4) { needed = 3; cp = b0 & 0x07; minCp = 0x10000; }
      else { s += "�"; i++; continue; }

      var j = 1;
      for (; j <= needed && i + j < len; j++) {
        var bx = data[off + i + j];
        if ((bx & 0xC0) !== 0x80) break;
        cp = (cp << 6) | (bx & 0x3F);
      }

      if (j <= needed) {
        // Incomplete or invalid continuation.  Emit one U+FFFD and
        // advance one byte — but check the special "early-reject"
        // ranges for the second byte that V8/WHATWG require.
        s += "�";
        var prefixInvalid = false;
        if (j > 1) {
          var b1 = data[off + i + 1];
          if (needed === 2 && b0 === 0xE0 && b1 < 0xA0) prefixInvalid = true;
          if (needed === 2 && b0 === 0xED && b1 > 0x9F) prefixInvalid = true;
          if (needed === 3 && b0 === 0xF0 && b1 < 0x90) prefixInvalid = true;
          if (needed === 3 && b0 === 0xF4 && b1 > 0x8F) prefixInvalid = true;
        }
        if (prefixInvalid) { i++; }
        else { i += j; }
        continue;
      }

      var valid = true;
      if (cp < minCp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) valid = false;
      var b1b = data[off + i + 1];
      if (needed === 2 && b0 === 0xE0 && b1b < 0xA0) valid = false;
      if (needed === 2 && b0 === 0xED && b1b > 0x9F) valid = false;
      if (needed === 3 && b0 === 0xF0 && b1b < 0x90) valid = false;
      if (needed === 3 && b0 === 0xF4 && b1b > 0x8F) valid = false;

      if (!valid) { s += "�"; i++; continue; }

      if (cp <= 0xFFFF) {
        s += String.fromCharCode(cp);
      } else {
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + ((cp >> 10) & 0x3FF),
                                 0xDC00 + (cp & 0x3FF));
      }
      i += needed + 1;
    }
    return s;
  }

  function decodeUtf16Le(data, off, len) {
    var s = "";
    var n = len >> 1;
    for (var i = 0; i < n; i++) {
      s += String.fromCharCode(data[off + 2 * i] | (data[off + 2 * i + 1] << 8));
    }
    return s;
  }

  function decodeAscii(data, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(data[off + i] & 0x7F);
    return s;
  }

  function decodeLatin1(data, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
    return s;
  }

  var kHex = "0123456789abcdef";
  function decodeHex(data, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) {
      var b = data[off + i];
      s += kHex.charAt((b >> 4) & 0xF) + kHex.charAt(b & 0xF);
    }
    return s;
  }

  var kStdB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var kUrlB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function encodeBase64(data, off, len, isUrl) {
    var table = isUrl ? kUrlB64 : kStdB64;
    var s = "";
    var i = 0;
    for (; i + 2 < len; i += 3) {
      var n = (data[off + i] << 16) | (data[off + i + 1] << 8) | data[off + i + 2];
      s += table.charAt((n >> 18) & 0x3F)
         + table.charAt((n >> 12) & 0x3F)
         + table.charAt((n >> 6) & 0x3F)
         + table.charAt(n & 0x3F);
    }
    if (i < len) {
      var a = data[off + i];
      var hasB = (i + 1 < len);
      var bb = hasB ? data[off + i + 1] : 0;
      s += table.charAt((a >> 2) & 0x3F)
         + table.charAt(((a & 0x03) << 4) | ((bb >> 4) & 0x0F));
      if (hasB) {
        s += table.charAt((bb & 0x0F) << 2);
        if (!isUrl) s += "=";
      } else if (!isUrl) {
        s += "==";
      }
    }
    return s;
  }

  function renderBytes(data, off, len, enc) {
    if (enc === ENC_UTF8) return decodeUtf8(data, off, len);
    if (enc === ENC_UTF16LE) return decodeUtf16Le(data, off, len);
    if (enc === ENC_ASCII) return decodeAscii(data, off, len);
    if (enc === ENC_LATIN1) return decodeLatin1(data, off, len);
    if (enc === ENC_HEX) return decodeHex(data, off, len);
    if (enc === ENC_BASE64) return encodeBase64(data, off, len, false);
    if (enc === ENC_BASE64_URL) return encodeBase64(data, off, len, true);
    // Buffer / unknown: utf8 fallback (matches the C++ fallthrough).
    return decodeUtf8(data, off, len);
  }

  // ----- streaming carry-over (mirrors DecodeBinding) -----

  function readView(view) {
    // `view` is a Buffer/TypedArray/DataView passed from JS land.  Read
    // its underlying bytes as a Uint8Array.
    if (view instanceof Uint8Array) {
      return view;
    }
    // Don't use `instanceof ArrayBuffer` — under our wasm-aliased Buffer
    // model the underlying buffer may be a SharedArrayBuffer (or a
    // subclass not recognized by realm-local ArrayBuffer).  Duck-type
    // on `.buffer` + numeric `byteLength`/`byteOffset` instead.
    if (view && view.buffer && typeof view.byteLength === "number") {
      return new Uint8Array(view.buffer, view.byteOffset || 0, view.byteLength);
    }
    // Last resort: copy element-by-element as bytes (lossy for >1-byte
    // element types, but matches the C++ "treat as raw" fallback).
    return new Uint8Array(view);
  }

  function jsDecode(state, buf) {
    var enc = state[kEncodingField];
    var src = readView(buf);
    var data = src;
    var off = 0;
    var nread = src.length;

    var variable = (enc === ENC_UTF8 || enc === ENC_UTF16LE ||
                    enc === ENC_BASE64 || enc === ENC_BASE64_URL);
    if (!variable) {
      return renderBytes(data, off, nread, enc);
    }

    var prepend = "";
    var hasPrepend = false;

    if (state[kMissingBytes] > 0) {
      if (enc === ENC_UTF8) {
        // Bail-out: input doesn't actually continue the incomplete char.
        for (var i = 0; i < nread && i < state[kMissingBytes]; i++) {
          if ((data[off + i] & 0xC0) !== 0x80) {
            state[kMissingBytes] = 0;
            for (var k = 0; k < i; k++) {
              state[kIncompleteStart + state[kBufferedBytes] + k] = data[off + k];
            }
            state[kBufferedBytes] = state[kBufferedBytes] + i;
            off += i;
            nread -= i;
            break;
          }
        }
      }

      var found = Math.min(nread, state[kMissingBytes]);
      for (var m = 0; m < found; m++) {
        state[kIncompleteStart + state[kBufferedBytes] + m] = data[off + m];
      }
      off += found;
      nread -= found;
      state[kMissingBytes] = state[kMissingBytes] - found;
      state[kBufferedBytes] = state[kBufferedBytes] + found;

      if (state[kMissingBytes] === 0) {
        prepend = renderBytes(state, kIncompleteStart, state[kBufferedBytes], enc);
        hasPrepend = true;
        state[kBufferedBytes] = 0;
      }
    }

    if (nread === 0) {
      return hasPrepend ? prepend : "";
    }

    if (enc === ENC_UTF8 && (data[off + nread - 1] & 0x80)) {
      var p = nread - 1;
      while (true) {
        state[kBufferedBytes] = state[kBufferedBytes] + 1;
        if ((data[off + p] & 0xC0) === 0x80) {
          if (state[kBufferedBytes] >= 4 || p === 0) {
            state[kBufferedBytes] = 0;
            break;
          }
        } else {
          if ((data[off + p] & 0xE0) === 0xC0) state[kMissingBytes] = 2;
          else if ((data[off + p] & 0xF0) === 0xE0) state[kMissingBytes] = 3;
          else if ((data[off + p] & 0xF8) === 0xF0) state[kMissingBytes] = 4;
          else { state[kBufferedBytes] = 0; break; }
          if (state[kBufferedBytes] >= state[kMissingBytes]) {
            state[kMissingBytes] = 0;
            state[kBufferedBytes] = 0;
          } else {
            state[kMissingBytes] = state[kMissingBytes] - state[kBufferedBytes];
          }
          break;
        }
        if (p === 0) break;
        p--;
      }
    } else if (enc === ENC_UTF16LE) {
      if ((nread % 2) === 1) {
        state[kBufferedBytes] = 1;
        state[kMissingBytes] = 1;
      } else if ((data[off + nread - 1] & 0xFC) === 0xD8) {
        state[kBufferedBytes] = 2;
        state[kMissingBytes] = 2;
      }
    } else if (enc === ENC_BASE64 || enc === ENC_BASE64_URL) {
      state[kBufferedBytes] = nread % 3;
      if (state[kBufferedBytes] > 0) state[kMissingBytes] = 3 - state[kBufferedBytes];
    }

    if (state[kBufferedBytes] > 0) {
      nread -= state[kBufferedBytes];
      for (var c = 0; c < state[kBufferedBytes]; c++) {
        state[kIncompleteStart + c] = data[off + nread + c];
      }
    }

    var body = renderBytes(data, off, nread, enc);
    return hasPrepend ? prepend + body : body;
  }

  function jsFlush(state) {
    var enc = state[kEncodingField];
    if (enc === ENC_UTF16LE && (state[kBufferedBytes] % 2) === 1) {
      state[kMissingBytes] = state[kMissingBytes] - 1;
      state[kBufferedBytes] = state[kBufferedBytes] - 1;
    }
    if (state[kBufferedBytes] === 0) return "";
    var ret = renderBytes(state, kIncompleteStart, state[kBufferedBytes], enc);
    state[kMissingBytes] = 0;
    state[kBufferedBytes] = 0;
    return ret;
  }

  try {
    Object.defineProperty(b, "decode", { configurable: true, writable: true, value: jsDecode });
    Object.defineProperty(b, "flush", { configurable: true, writable: true, value: jsFlush });
    Object.defineProperty(b, "__edgeStringDecoderJsPatched", {
      configurable: true, writable: true, value: true,
    });
  } catch (_e) {
    b.decode = jsDecode;
    b.flush = jsFlush;
    b.__edgeStringDecoderJsPatched = true;
  }

  // Silence-unused for ENC_ASCII / ENC_LATIN1 / etc. tracker — they're
  // used by renderBytes.
  void ENC_ASCII; void ENC_LATIN1; void ENC_HEX;

  // ----- ALSO patch internalBinding('buffer').utf8Slice -----
  //
  // The test-string-decoder-end.js assertions compare
  // `StringDecoder.write/end` against `buf.toString(encoding)`.  Even
  // with our fixed JS decoder, the comparison fails because
  // `Buffer.prototype.toString('utf8')` ultimately calls
  // `internalBinding('buffer').utf8Slice` which has the same wasm-side
  // UTF-8 bug (emits \x00 for naked continuation bytes instead of
  // U+FFFD).  Replace it with the same JS UTF-8 decoder.
  //
  // We also patch base64Slice / base64urlSlice / hexSlice / latin1Slice
  // / asciiSlice / ucs2Slice for total parity — cheap and keeps the
  // decoder/encoder pair coherent.
  var bufB;
  try { bufB = internalBinding("buffer"); } catch (_e2) { return; }
  if (!bufB || bufB.__edgeBufferSliceJsPatched) return;

  function viewBytes(thisArg, start, end) {
    var u8;
    if (thisArg instanceof Uint8Array) {
      u8 = thisArg;
    } else if (thisArg && thisArg.buffer && typeof thisArg.byteLength === "number") {
      // Duck-type — under wasm-aliased Buffer model the underlying
      // buffer may not be `instanceof ArrayBuffer`.
      u8 = new Uint8Array(thisArg.buffer, thisArg.byteOffset || 0, thisArg.byteLength);
    } else {
      u8 = new Uint8Array(thisArg);
    }
    var s = start | 0;
    var e = (end == null) ? u8.length : (end | 0);
    if (s < 0) s = 0;
    if (e > u8.length) e = u8.length;
    if (e < s) e = s;
    return { u8: u8, off: s, len: e - s };
  }

  function utf8Slice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return decodeUtf8(v.u8, v.off, v.len);
  }
  function ucs2Slice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return decodeUtf16Le(v.u8, v.off, v.len);
  }
  function asciiSlice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return decodeAscii(v.u8, v.off, v.len);
  }
  function latin1Slice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return decodeLatin1(v.u8, v.off, v.len);
  }
  function hexSlice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return decodeHex(v.u8, v.off, v.len);
  }
  function base64Slice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return encodeBase64(v.u8, v.off, v.len, false);
  }
  function base64urlSlice(thisArg, start, end) {
    var v = viewBytes(thisArg, start, end);
    return encodeBase64(v.u8, v.off, v.len, true);
  }

  function setProp(name, value) {
    try {
      Object.defineProperty(bufB, name, { configurable: true, writable: true, value: value });
    } catch (_e3) {
      bufB[name] = value;
    }
  }
  setProp("utf8Slice", utf8Slice);
  setProp("ucs2Slice", ucs2Slice);
  setProp("asciiSlice", asciiSlice);
  setProp("latin1Slice", latin1Slice);
  setProp("hexSlice", hexSlice);
  setProp("base64Slice", base64Slice);
  setProp("base64urlSlice", base64urlSlice);
  setProp("__edgeBufferSliceJsPatched", true);
})();

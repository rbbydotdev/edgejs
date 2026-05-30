// @ts-nocheck
// Vendored from unenv (MIT) — DO NOT EDIT. Re-vendor from upstream.
// Upstream: https://github.com/unjs/unenv/blob/f89b7ccb5c05da70b946319783acf1fa1f113e22/src/runtime/node/internal/buffer/buffer.ts (extracted: INVALID_BASE64_RE + base64clean, lines ~2292-2308)
// License:  MIT (https://github.com/unjs/unenv/blob/f89b7ccb5c05da70b946319783acf1fa1f113e22/LICENSE)
//
// Source: https://github.com/feross/buffer/blob/795bbb5bda1b39f1370ebd784bea6107b087e3a7/index.js

const INVALID_BASE64_RE = /[^\w+/-]/g;

function base64clean(str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split("=")[0];
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, "");
  // Node converts strings with length < 2 to ''
  if (str.length < 2) {
    return "";
  }
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + "=";
  }
  return str;
}

export { base64clean };

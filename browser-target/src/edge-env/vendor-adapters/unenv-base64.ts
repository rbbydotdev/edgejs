// Facade over vendored unenv base64 helpers.
//
// This is the SOLE importer of `vendor/unenv/base64*.ts`. All other code in the
// project consumes the typed API exported here, so swapping the vendored
// implementation only requires updating this single file.
//
// See vendor/unenv/README.md for upstream / licensing details.

import { toByteArray } from "../../../vendor/unenv/base64";
import { base64clean } from "../../../vendor/unenv/base64clean";

/**
 * Decode a base64 (or URL-safe base64) string to bytes, matching Node's
 * `Buffer.from(str, "base64")` tolerance: ignores whitespace and invalid
 * characters, treats `=` as end-of-input, and auto-pads short inputs.
 */
export function decodeBase64(input: string): Uint8Array {
  const cleaned = base64clean(input);
  if (cleaned.length === 0) {
    return new Uint8Array(0);
  }
  // `toByteArray` returns a `Uint8Array` when `Uint8Array` is available
  // (always true in our target environments).
  return toByteArray(cleaned) as Uint8Array;
}

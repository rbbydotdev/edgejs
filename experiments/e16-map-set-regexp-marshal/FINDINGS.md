# E16: Map / Set / RegExp marshaling — findings

**Date:** 2026-05-24
**Worktree (deleted):** `agent-adcbb162221c1ee6f` (port 5191)
**Result:** Three new by-value tags shipped (13/14/15).  10/10 marshal
probes pass in the F-9 sweep + 5 dedicated edge cases in a standalone
Node probe.  Suite unchanged at 32/0/3.

## Tags added (wire format)

All multi-byte fields little-endian.  Map and Set both register
themselves in the per-frame `seen` / `byFrameId` map (each consumes
one frame id) so circular references through them resolve.  RegExp
also consumes one frame id, mirroring how Date is handled.

| Tag | Value  | Payload                                              | Size |
|----:|--------|------------------------------------------------------|------|
|  13 | Map    | `[u32 size][repeated: packed-key, packed-value]`     | 5 + Σ entries |
|  14 | Set    | `[u32 size][repeated: packed-value]`                 | 5 + Σ values |
|  15 | RegExp | `[u32 sourceLen][utf-8 source bytes][u8 flagsBits]`  | 6 + sourceLen |

RegExp `flagsBits`:
- bit 0: g (global)
- bit 1: i (ignoreCase)
- bit 2: m (multiline)
- bit 3: s (dotAll)
- bit 4: u (unicode)
- bit 5: y (sticky)
- bit 6: d (hasIndices)
- bit 7: v (unicodeSets)

## Implementation

- `browser-target/src/host-worker/cross-context-marshal.ts` — +181 / -2
  lines.  Header doc table extended with rows 13/14/15; LIMITATIONS
  section updated (drops TODO, gains explicit note on `lastIndex`
  non-preservation); three new tag constants + RegExp flag bit
  constants + `regexpFlagsToBits` / `regexpBitsToFlags` helpers;
  encoder branches for RegExp / Map / Set in `packValueWith` (placed
  before Array/plain-object so they don't bleed through); decoder
  cases each call `frame.byFrameId.push(...)` BEFORE recursing into
  entries so circular back-refs resolve to the in-progress container.
- `browser-target/src/main.ts` — +19 lines.  Extended `deepEq` with
  RegExp / Map / Set arms; three new probe cases (`marshal: map`,
  `marshal: set`, `marshal: regexp`).

## Probe results

**Browser f9-sweep — 10/10 marshal probes pass** (7 existing + 3 new):
```
f9-sweep: ok marshal: plain-obj          roundtrip ok
f9-sweep: ok marshal: nested-obj         roundtrip ok
f9-sweep: ok marshal: array-of-obj       roundtrip ok
f9-sweep: ok marshal: date               roundtrip ok
f9-sweep: ok marshal: uint8array         roundtrip ok
f9-sweep: ok marshal: arraybuffer        roundtrip ok
f9-sweep: ok marshal: circular-self-ref  roundtrip ok
f9-sweep: ok marshal: map                roundtrip ok   ← new
f9-sweep: ok marshal: set                roundtrip ok   ← new
f9-sweep: ok marshal: regexp             roundtrip ok   ← new
```

**Standalone Node probe** (worktree-only):
15/15 pass — the 10 above plus 5 dedicated edge cases (circular Map
self-ref, circular Set self-ref, all 7 RegExp flags `dgimsuy`, RegExp
with no flags, lastIndex-not-preserved).

**Full suite: 32 pass, 0 fail, 0 err, 3 skip** (unchanged from E15
baseline).

## Edge cases handled

- **Circular Map / Set values.**  Both containers register themselves
  in `frame.byFrameId` BEFORE iterating entries, so a self-reference
  emits `MARSHAL_TAG_CIRCULAR_REF` and resolves back to the same
  instance.  Verified.
- **Map with object keys.**  Keys go through the full recursive
  packer — they can be any marshalable value (no string-only
  restriction like `MARSHAL_TAG_OBJECT_PLAIN`).
- **Frame-id symmetry.**  The encoder unconditionally calls
  `frame.nextId++` for every `typeof "object"` value, including
  leaf-shaped Date and RegExp.  The decoder must push the same
  number of placeholders into `byFrameId` or CIRCULAR_REF ids
  desync.  RegExp now pushes before return; Map/Set push before
  iterating.
- **RegExp `lastIndex` NOT preserved** — receiver always sees 0.
  Matches `structuredClone` semantics; documented in the module
  header.  Rationale: iteration state, not value identity.
- **SAB safety.**  RegExp decoder copies source bytes out of a
  SharedArrayBuffer-backed view before `TextDecoder.decode`,
  mirroring existing string handling.
- **Function / Symbol values inside Maps / Sets** tag as 255 and
  decoder throws — no special-casing, parallel to plain-object
  behavior.

## Files changed in main

- `browser-target/src/host-worker/cross-context-marshal.ts` —
  new tags + encoder/decoder branches + helpers
- `browser-target/src/main.ts` — deepEq arms + 3 new sweep probes

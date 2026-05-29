// ESM module registry — host-JS-side state for the
// unofficial_napi_module_wrap_* family.
//
// Stub history: the module_wrap family used to be no-op markers
// (unofficial.ts kUninstantiated through Phase 0 of the ESM plan). This
// module now owns:
//   * the per-module record (source/deps/namespace/status/error)
//   * blob-URL synthesis with specifier rewrite
//   * the actual `import(blobUrl)` call that drives browser-native ESM
//
// Architecture rationale:
//   The browser's `import(blob:URL)` runs the source through the same
//   V8 ESM machinery Node uses. Wrapping our evaluate stub in
//   `WebAssembly.Suspending` lets wasm-side edge.js see the async
//   `import()` as a sync call (no Asyncify). For each module's
//   dependencies we mint child blob URLs first, then string-substitute
//   the parent's import specifiers with the child URLs before minting
//   the parent blob. The browser then resolves each `from "blob:..."`
//   to the cached dep module — full Node semantics including cycles,
//   live bindings, top-level await, no extra link/instantiate work on
//   our side.
//
// See NOTES.md `module_wrap_*` debt entry + plans/esm-via-jspi.md.

import { initSync, parse } from "es-module-lexer";

// Sync wasm compile (~10ms, ~10KB wasm) so every parse/rewrite entry
// below can run synchronously from the napi wasm callbacks without
// awaiting the async `init`. Hoisted to module load so the cost is paid
// once per worker boot, off the user's request-handler hot path.
initSync();

export type ModuleStatus = 0 | 1 | 2 | 3 | 4 | 5;
// 0=kUninstantiated, 1=kInstantiating, 2=kInstantiated,
// 3=kEvaluating, 4=kEvaluated, 5=kErrored.

export interface ModuleRecord {
  kind: "source-text" | "synthetic" | "required-facade";
  /** edge's `wrapper` handle — passed through from the host so the
   *  loader can correlate this record back to its ScriptOrModule. */
  wrapper: number;
  /** Module URL the lib loader gave us (typically a `file:` URL or
   *  `node:` builtin). We pass through unchanged for diagnostics; the
   *  browser sees the synthesized blob: URL, not this one. */
  url: string;
  /** Original source text — undefined for synthetic modules. */
  source?: string;
  /** Synthetic export names — set by create_synthetic. */
  exportNames?: string[];
  /** Deps as the loader linked them, in the same order
   *  `get_module_requests` returned them. Populated by `link()`. */
  deps: ModuleRecord[];
  /** Static module-request list extracted from source. Cached after
   *  the first `get_module_requests()` so multiple loader queries
   *  don't re-parse. */
  requests?: ModuleRequest[];
  /** Lifecycle state. Mirrors v8::Module::Status. */
  status: ModuleStatus;
  /** Captured namespace from the browser's evaluated blob module. */
  namespace: Record<string, unknown>;
  /** Exception captured during evaluate. */
  error?: unknown;
  /** Set after evaluate if browser-V8 detected top-level await in the
   *  source. We can't determine this statically without parsing; we
   *  set it eagerly via source scan and revise after evaluate. */
  hasTla: boolean;
  /** True if any module in the linked subgraph has TLA. Computed
   *  recursively during evaluate. */
  hasAsyncGraph: boolean;
  /** Synthesized blob: URL — cached so the dep-import rewrite step
   *  for parents that pull us in can reuse it. */
  blobUrl?: string;
  /** Synthesized SW URL (`/_edge_esm/<id>`) — assigned only when the
   *  dep subgraph contains a cycle, since blob URLs can't be pre-
   *  reserved before their source is generated.  See
   *  `synthesizeUrl` + `synthesizeSwUrlsForCycle`. */
  swUrl?: string;
  /** Synthetic-module evaluation callback — captured during
   *  `create_synthetic`.  Invoked when we synthesize the synthetic's
   *  blob; the callback sets exports via `this.setExport(name, value)`
   *  which we intercept and write into `namespace`.  JSON-import
   *  modules go through this path: lib's translator builds a
   *  ModuleWrap with `exportNames=['default']` + a callback that
   *  invokes `this.setExport('default', JSON.parse(source))`. */
  syntheticEvalSteps?: (this: { setExport(name: string, value: unknown): void }) => void;
  /** Set after `runSyntheticEvalSteps` has executed once.  We can't
   *  rely on `status` for idempotency because `evaluateRecord` sets
   *  it to kEvaluating before synthesis runs. */
  _syntheticEvalRan?: boolean;
  /** Source-phase import return value — for Wasm-ESM that's the
   *  compiled `WebAssembly.Module`.  Set via
   *  `set_module_source_object` from lib's wasm translator (line 625
   *  of `lib/internal/modules/esm/translators.js`); read via
   *  `get_module_source_object` when lib resolves an `import source X`
   *  declaration or a dynamic `import` with `phase: kSourcePhase`. */
  sourceObject?: unknown;
}

export interface ModuleRequest {
  specifier: string;
  attributes: Record<string, string>;
  // 1 = source phase, 2 = evaluation phase (matches kSourcePhase /
  // kEvaluationPhase in binding_module_wrap.cc).
  phase: 1 | 2;
}

/** Static module-request list — every `import ... from 'X'` /
 *  `export ... from 'X'` / bare `import 'X'` the source declares, in
 *  source order. Dynamic `import(...)` and `import.meta` are filtered
 *  out (lib's loader handles dynamic via the registered callback). */
export function extractModuleRequests(source: string): ModuleRequest[] {
  const [imports] = parse(source);
  const out: ModuleRequest[] = [];
  for (const imp of imports) {
    // d === -1 → static; -2 → import.meta; >= 0 → dynamic import().
    if (imp.d !== -1) continue;
    if (imp.n === undefined) continue;
    const attributes: Record<string, string> = {};
    if (imp.at) for (const [k, v] of imp.at) attributes[k] = v;
    out.push({ specifier: imp.n, attributes, phase: 2 });
  }
  return out;
}

/** Detect top-level await — used to set `hasTla`, which feeds
 *  `hasAsyncGraph`, which lib's `ModuleJobSync.runSync` checks at
 *  `lib/internal/modules/esm/module_job.js:392` to throw
 *  `ERR_REQUIRE_ASYNC_MODULE` BEFORE calling `evaluateSync`.  False
 *  positives here therefore short-circuit modules that don't
 *  actually have TLA — a real correctness bug, not a benign hint.
 *
 *  This implementation walks the source tracking `{` `}` depth and
 *  detecting `async` markers on functions / arrow functions, so we
 *  can identify `await` tokens at module scope (depth 0, no enclosing
 *  async function).  Skips strings + comments.  Doesn't do full JS
 *  parsing — handles the common patterns the regex form mis-flagged.
 *
 *  #!~debt esm-tla-heuristic: Still a heuristic.  Misses edge cases
 *  like generators (`function*`), class method bodies, and
 *  expression-bodied arrow async functions (`async () => await x`,
 *  which is valid but contrived).  When Sucrase is loaded (b₄
 *  policy), the runtime compile-time check is authoritative; this
 *  heuristic only matters at `create_source_text` time. */
export function detectTopLevelAwait(source: string): boolean {
  const n = source.length;
  let i = 0;
  let depth = 0;
  // Stack of booleans: each `{` push records whether the block is an
  // async function body.  `await` inside an async block doesn't count.
  const asyncStack: boolean[] = [];
  while (i < n) {
    const ch = source.charCodeAt(i);
    // Skip strings (single, double, template).
    if (ch === 39 /* ' */ || ch === 34 /* " */ || ch === 96 /* ` */) {
      i = skipStringChar(source, i, ch);
      continue;
    }
    // Skip comments.
    if (ch === 47 /* / */ && i + 1 < n) {
      const next = source.charCodeAt(i + 1);
      if (next === 47) { i = source.indexOf("\n", i); if (i < 0) return false; i++; continue; }
      if (next === 42) { const end = source.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    }
    if (ch === 123 /* { */) {
      // Decide whether this block opens an async function body.
      asyncStack.push(precedingAsyncFunctionContext(source, i));
      depth++;
      i++;
      continue;
    }
    if (ch === 125 /* } */) {
      depth--;
      asyncStack.pop();
      i++;
      continue;
    }
    // Word boundary check for `await`.
    if (ch === 97 /* a */ &&
        source.charCodeAt(i + 1) === 119 /* w */ &&
        source.charCodeAt(i + 2) === 97 /* a */ &&
        source.charCodeAt(i + 3) === 105 /* i */ &&
        source.charCodeAt(i + 4) === 116 /* t */ &&
        !isIdentifierChar(source.charCodeAt(i + 5)) &&
        (i === 0 || !isIdentifierChar(source.charCodeAt(i - 1)))) {
      // At module scope?  Module scope means depth 0 OR all enclosing
      // blocks are not async function bodies (i.e. they're if/for/etc.
      // — `await` in those at module scope IS still top-level).
      const insideAsyncFn = asyncStack.some((b) => b);
      if (!insideAsyncFn) return true;
    }
    i++;
  }
  return false;
}

function isIdentifierChar(c: number): boolean {
  // ASCII subset is enough — full Unicode identifiers are rare here
  // and a wider class only causes false positives we're already
  // tolerating.
  return (c >= 48 && c <= 57) || // 0-9
         (c >= 65 && c <= 90) || // A-Z
         (c >= 97 && c <= 122) || // a-z
         c === 95 || c === 36; // _ $
}

function skipStringChar(source: string, p: number, quote: number): number {
  const n = source.length;
  let j = p + 1;
  while (j < n) {
    const c = source.charCodeAt(j);
    if (c === 92 /* \\ */) { j += 2; continue; }
    if (c === quote) return j + 1;
    // Template substitution — skip nested braces.
    if (quote === 96 && c === 36 /* $ */ && source.charCodeAt(j + 1) === 123 /* { */) {
      j += 2;
      let depth = 1;
      while (j < n && depth > 0) {
        const cc = source.charCodeAt(j);
        if (cc === 123) depth++;
        else if (cc === 125) depth--;
        else if (cc === 39 || cc === 34 || cc === 96) { j = skipStringChar(source, j, cc); continue; }
        j++;
      }
      continue;
    }
    j++;
  }
  return j;
}

/** Look BACKWARD from a `{` to see if it's the body of an async
 *  function declaration or async arrow function.  Pattern matches:
 *    async function X (...) {
 *    async (...) => {
 *    async X => {        (rare)
 *  Returns true iff the `{` opens an async function body. */
function precedingAsyncFunctionContext(source: string, openBrace: number): boolean {
  // Walk back skipping whitespace.
  let j = openBrace - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return false;
  // Arrow form: `=>` immediately before (with whitespace stripped).
  if (j >= 1 && source[j] === ">" && source[j - 1] === "=") {
    // Walk back past the arrow + parameter list, looking for `async`.
    let k = j - 2;
    while (k >= 0 && /\s/.test(source[k])) k--;
    // Skip a parenthesized param list or a single identifier.
    if (k >= 0 && source[k] === ")") {
      let parens = 1;
      k--;
      while (k >= 0 && parens > 0) {
        if (source[k] === ")") parens++;
        else if (source[k] === "(") parens--;
        k--;
      }
    } else {
      while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k--;
    }
    while (k >= 0 && /\s/.test(source[k])) k--;
    // Look for "async" preceding.
    if (k >= 4 &&
        source.slice(k - 4, k + 1) === "async" &&
        (k - 5 < 0 || !/[A-Za-z0-9_$]/.test(source[k - 5]))) {
      return true;
    }
    return false;
  }
  // Function form: walk back past `)`...`(` (param list), then past
  // optional identifier, then look for `function`, then `async`.
  if (source[j] === ")") {
    let k = j;
    let parens = 1;
    k--;
    while (k >= 0 && parens > 0) {
      if (source[k] === ")") parens++;
      else if (source[k] === "(") parens--;
      k--;
    }
    while (k >= 0 && /\s/.test(source[k])) k--;
    // Optional function name.
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k])) k--;
    while (k >= 0 && /\s/.test(source[k])) k--;
    // Expect "function" keyword.
    if (k >= 7 &&
        source.slice(k - 7, k + 1) === "function" &&
        (k - 8 < 0 || !/[A-Za-z0-9_$]/.test(source[k - 8]))) {
      // Walk back past "function" + whitespace, look for "async".
      let m = k - 8;
      while (m >= 0 && /\s/.test(source[m])) m--;
      if (m >= 4 &&
          source.slice(m - 4, m + 1) === "async" &&
          (m - 5 < 0 || !/[A-Za-z0-9_$]/.test(source[m - 5]))) {
        return true;
      }
    }
  }
  return false;
}

// Counter for SW URL paths.  Global so cyclic graphs across
// independent modules don't reuse paths.  SW caches indefinitely
// (cleared on `destroy` for bounded memory).
let nextEsmSwId = 1;

/** Detect a cycle in the dep subgraph reachable from `root`.  Uses
 *  the textbook DFS color algorithm: white=unvisited, gray=in-stack,
 *  black=fully-visited.  Returns true iff a back-edge into a gray
 *  ancestor exists. */
function hasCycle(root: ModuleRecord): boolean {
  const gray = new Set<ModuleRecord>();
  const black = new Set<ModuleRecord>();
  function visit(r: ModuleRecord): boolean {
    if (black.has(r)) return false;
    if (gray.has(r)) return true;
    gray.add(r);
    for (const dep of r.deps) {
      if (visit(dep)) return true;
    }
    gray.delete(r);
    black.add(r);
    return false;
  }
  return visit(root);
}

/** Top-level URL synthesizer.  Cycle-free graphs go through the fast
 *  blob: URL path (sync, in-memory).  Cyclic graphs route through
 *  the SW: each record gets a stable `/_edge_esm/<id>` path, sources
 *  are generated using the pre-assigned URLs (no chicken-and-egg),
 *  then all sources are published to the SW via the worker → page →
 *  SW relay before `import()` is called.  Returns the URL of the
 *  root record. */
export async function synthesizeUrl(record: ModuleRecord): Promise<string> {
  if (record.blobUrl) return record.blobUrl;
  if (record.swUrl) return record.swUrl;
  if (hasCycle(record)) {
    return synthesizeSwUrlsForCycle(record);
  }
  return synthesizeBlobUrl(record);
}

/** Synthesize a blob URL for a record, recursively minting blobs for
 *  its dependency subgraph first. Rewrites each `import ... from "X"`
 *  specifier in source to the dep's blob: URL. Caches per-record.
 *
 *  Uses native URL / Blob ctors cached on globalThis at worker.ts load
 *  — edge.js swaps the global `URL` for its own implementation during
 *  bootstrap (lib/internal/url.js) which would otherwise produce
 *  `blob:nodedata:` URLs the browser can't `import()`. */
export function synthesizeBlobUrl(record: ModuleRecord): string {
  return synthesizeBlobUrlInner(record, new Set());
}

function synthesizeBlobUrlInner(record: ModuleRecord, inFlight: Set<ModuleRecord>): string {
  if (record.blobUrl) return record.blobUrl;
  if (record.swUrl) return record.swUrl;
  // Defensive cycle guard.  `synthesizeUrl` routes cycles to the SW
  // path; if a caller invokes the blob path directly on a cyclic
  // graph (e.g. tests), throw with a clear message rather than
  // stack-overflow.
  if (inFlight.has(record)) {
    throw new Error(
      "edge.js ESM cycle detected at " + record.url +
      " — call synthesizeUrl() (async) instead of synthesizeBlobUrl() " +
      "for graphs that may contain cycles.",
    );
  }
  inFlight.add(record);

  // Resolve native ctors lazily — they're cached on globalThis by
  // worker.ts before edge.js mutates the globals.  Falling back to the
  // current globalThis values keeps this module usable from non-edge
  // contexts (e.g. unit tests).
  const NativeURL = (globalThis as { __edgeNativeURL?: typeof URL }).__edgeNativeURL ?? URL;
  const NativeBlob = (globalThis as { __edgeNativeBlob?: typeof Blob }).__edgeNativeBlob ?? Blob;

  if (record.kind === "synthetic") {
    // Run the synthetic eval steps first if registered (JSON imports
    // and any other lib translator that uses synthetic modules).  The
    // callback sets exports via `this.setExport(name, value)`; we
    // intercept and write to `record.namespace`, then inline the
    // values as a JSON-stringified literal in the blob source so the
    // browser-V8 import sees real ESM exports.
    runSyntheticEvalSteps(record);
    const names = record.exportNames ?? [];
    const lines: string[] = [];
    for (const nm of names) {
      const literal = inlineOrLookup(record.namespace[nm]);
      if (nm === "default") {
        // `export default { … };` is parsed as `export default
        // <ObjectLiteral>` and works — but `export default <literal>`
        // for arbitrary AssignmentExpression is safer parenthesized
        // when the literal starts with `{` (V8 quirk on some shapes).
        lines.push(`export default (${literal});`);
      } else {
        lines.push(`export const ${jsId(nm)} = ${literal};`);
      }
    }
    const blob = new NativeBlob([lines.join("\n")], { type: "text/javascript" });
    record.blobUrl = NativeURL.createObjectURL(blob);
    return record.blobUrl;
  }

  if (record.kind === "required-facade") {
    // CJS-as-ESM facade. Phase 1 ships a placeholder; real impl in
    // Phase 5 (CJS interop).
    const blob = new NativeBlob(["export default {};"], { type: "text/javascript" });
    record.blobUrl = NativeURL.createObjectURL(blob);
    return record.blobUrl;
  }

  // source-text path: rewrite specifiers, mint deps first.
  const source = record.source ?? "";
  const requests = record.requests ?? extractModuleRequests(source);
  record.requests = requests;

  // Build specifier->blobUrl map. The loader called `link()` with
  // record.deps in the SAME order as get_module_requests returned, so
  // we can pair them by index.
  const specifierToBlobUrl = new Map<string, string>();
  for (let i = 0; i < requests.length && i < record.deps.length; i++) {
    const dep = record.deps[i];
    const depUrl = synthesizeBlobUrlInner(dep, inFlight);
    specifierToBlobUrl.set(requests[i].specifier, depUrl);
  }

  const rewritten = rewriteImportSpecifiers(source, specifierToBlobUrl);
  // Phase 4: inject import.meta object via preamble.  Browsers set
  // `import.meta.url` to the blob: URL, which leaks our trampoline to
  // user code (they'd see `blob:https://.../uuid` instead of the URL
  // they passed to `new vm.SourceTextModule(src, {identifier})`).
  // Rewrite `import.meta` references to a closure local containing
  // the lib-provided URL, then let lib's
  // `setInitializeImportMetaObjectCallback` (if registered) layer
  // additional properties.
  //
  // Phase 3: dynamic `import(...)` inside source is rewritten to a
  // helper `__edgeDynImport` that resolves via the host-side dynamic
  // import callback (lib's loader chain).  For static specifiers, we
  // pre-resolve to blob: URLs when we know them (covers cyclic and
  // re-import-of-static-dep cases); otherwise fall through to the
  // host callback.
  const preamble = synthesizePreamble(record, specifierToBlobUrl);
  const withMetaRewrite = rewriteImportMeta(rewritten);
  const withDynImport = rewriteDynamicImport(withMetaRewrite);
  // # sourceURL pragma so DevTools shows the real edge URL instead
  // of the opaque blob: URL.
  const withPragma = preamble + "\n" + withDynImport + `\n//# sourceURL=${record.url}\n`;
  const blob = new NativeBlob([withPragma], { type: "text/javascript" });
  record.blobUrl = NativeURL.createObjectURL(blob);
  return record.blobUrl;
}

/** Generate source text for a record using a pre-built specifier →
 *  URL map.  Shared between the blob path (URLs are blob:) and the
 *  SW path (URLs are /_edge_esm/<id>); the only difference is how
 *  the URLs were minted. */
function generateRecordSource(record: ModuleRecord, specifierToUrl: Map<string, string>): string {
  if (record.kind === "synthetic") {
    runSyntheticEvalSteps(record);
    const names = record.exportNames ?? [];
    const lines: string[] = [];
    for (const nm of names) {
      const literal = inlineOrLookup(record.namespace[nm]);
      if (nm === "default") {
        lines.push(`export default ${literal};`);
      } else {
        lines.push(`export const ${jsId(nm)} = ${literal};`);
      }
    }
    return lines.join("\n");
  }
  if (record.kind === "required-facade") {
    return "export default {};";
  }
  const source = record.source ?? "";
  const rewritten = rewriteImportSpecifiers(source, specifierToUrl);
  const preamble = synthesizePreamble(record, specifierToUrl);
  const withMetaRewrite = rewriteImportMeta(rewritten);
  const withDynImport = rewriteDynamicImport(withMetaRewrite);
  return preamble + "\n" + withDynImport + `\n//# sourceURL=${record.url}\n`;
}

/** Assign stable SW URLs to every record in the subgraph rooted at
 *  `root`, generate sources using the pre-assigned URLs, publish the
 *  sources to the SW, then return the root's URL.  This is the only
 *  path that supports cyclic ES module graphs, because each record's
 *  URL exists in the assigned-map BEFORE any source is generated.
 *
 *  Synthetic and required-facade records still work — their sources
 *  don't reference other modules, so they're trivially included. */
async function synthesizeSwUrlsForCycle(root: ModuleRecord): Promise<string> {
  // Walk graph; assign URLs in deterministic DFS order.  `assigned`
  // doubles as the visited set so each record is sourced once even
  // when reached through multiple paths.
  const assigned = new Map<ModuleRecord, string>();
  const order: ModuleRecord[] = [];
  function assign(r: ModuleRecord): string {
    const existing = r.swUrl ?? assigned.get(r);
    if (existing !== undefined) {
      assigned.set(r, existing);
      return existing;
    }
    const url = "/_edge_esm/" + (nextEsmSwId++);
    assigned.set(r, url);
    order.push(r);
    for (const dep of r.deps) assign(dep);
    return url;
  }
  const rootUrl = assign(root);

  // Generate sources using the assigned URLs.  This is the step that
  // would fail under the blob path — here it's straightforward because
  // every record's URL is already known.
  const sources: Array<[string, string]> = [];
  for (const r of order) {
    if (r.kind === "source-text") {
      const reqs = r.requests ?? extractModuleRequests(r.source ?? "");
      r.requests = reqs;
      const specifierToUrl = new Map<string, string>();
      for (let i = 0; i < reqs.length && i < r.deps.length; i++) {
        specifierToUrl.set(reqs[i].specifier, assigned.get(r.deps[i])!);
      }
      sources.push([assigned.get(r)!, generateRecordSource(r, specifierToUrl)]);
    } else {
      sources.push([assigned.get(r)!, generateRecordSource(r, new Map())]);
    }
    r.swUrl = assigned.get(r);
  }

  const publish = (globalThis as {
    __edgeEsmPublishSources?: (s: Array<[string, string]>) => Promise<void>;
  }).__edgeEsmPublishSources;
  if (typeof publish !== "function") {
    throw new Error(
      "edge.js ESM cycle detected at " + root.url +
      " — service worker bridge unavailable (__edgeEsmPublishSources not " +
      "installed). Confirm setupBridge() ran on the page and the SW activated.",
    );
  }
  await publish(sources);
  return rootUrl;
}

/** Build the per-module preamble that exposes `__edgeImportMeta` and
 *  `__edgeDynImport` to the rewritten user source.  Both names are
 *  looked up on globalThis at evaluation time; the host worker sets
 *  them at boot.  `__edgeDynImportImpl` calls lib's global dynamic-
 *  import callback (`importModuleDynamicallyCallback`), which the
 *  `esm-via-blob-import` policy wraps to dispatch on parent URL — so
 *  per-module `new vm.SourceTextModule(src, {importModuleDynamically})`
 *  fires correctly.  Falls through to native browser `import()` for
 *  absolute URLs (blob:/data:/https:).
 *
 *  `import.meta.resolve(specifier)` — Node returns the resolved URL
 *  string synchronously.  We bake the record's per-specifier
 *  resolution map (built from get_module_requests + link's deps) into
 *  the closure; static-import specifiers resolve to their bound URL,
 *  everything else falls through to lib's
 *  `initializeImportMetaObjectCallback`-installed resolver (or, when
 *  absent, a best-effort `new URL(specifier, importMeta.url)` which
 *  matches Node's default loader for already-absolute URLs).
 */
function synthesizePreamble(record: ModuleRecord, specifierToUrl?: Map<string, string>): string {
  const url = JSON.stringify(record.url);
  // Serialize the resolve map as a JSON object so the preamble stays
  // a single line per declaration (predictable line offsets for source
  // maps).  Empty map keeps the literal compact for cycle-free
  // synthetic / facade records that have no static deps.
  const mapLiteral = specifierToUrl && specifierToUrl.size > 0
    ? JSON.stringify(Object.fromEntries(specifierToUrl))
    : "{}";
  return [
    "const __edgeImportMetaResolveMap = " + mapLiteral + ";",
    "const __edgeImportMeta = (globalThis.__edgeImportMetaFactory ? globalThis.__edgeImportMetaFactory(" + url + ", __edgeImportMetaResolveMap) : { url: " + url + ", resolve: (s) => __edgeImportMetaResolveMap[s] ?? new URL(s, " + url + ").href });",
    "const __edgeDynImport = (specifier) => (globalThis.__edgeDynImportImpl ? globalThis.__edgeDynImportImpl(specifier, " + url + ") : import(specifier));",
  ].join("\n");
}

/** Rewrite `import.meta` property accesses to `__edgeImportMeta`.  We
 *  bind the meta object once per module so subsequent property reads
 *  see whatever the host's `initializeImportMetaCallback` populated. */
export function rewriteImportMeta(source: string): string {
  const [imports] = parse(source);
  let out = source;
  // Reverse iteration so each splice keeps earlier offsets valid.
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.d !== -2) continue;
    out = out.slice(0, imp.ss) + "__edgeImportMeta" + out.slice(imp.se);
  }
  return out;
}

/** Rewrite `import(...)` expressions to `__edgeDynImport(...)`.  For
 *  dynamic imports, `imp.ss` is the start of the keyword and `imp.d`
 *  is the start of `(`; we replace the `ss..d` span (`import`,
 *  `import.source`, or `import.defer` plus any trailing whitespace)
 *  with `__edgeDynImport`.  The `(` and arguments are left untouched.
 *
 *  #!~debt esm-dynamic-import-phase: ES2024 source-phase
 *  (`import.source('m')`) and defer-phase (`import.defer('m')`) imports
 *  are correctly stripped of their keyword span here, but
 *  `__edgeDynImport(specifier)` takes only ONE argument — the phase
 *  semantics are silently dropped.  At runtime,
 *  `import.source('m')` and `import('m')` both call lib's
 *  dynamic-import callback with the default evaluation phase, so
 *  source-phase code that depended on receiving the compiled
 *  WebAssembly.Module silently gets the evaluated namespace
 *  instead.  Same for defer-phase.  Fix shape: extend
 *  `__edgeDynImport` to `(specifier, phase)`; detect phase via
 *  `imp.t` (es-module-lexer's ImportType enum: 2=Dynamic,
 *  5=DynamicSourcePhase, 7=DynamicDeferPhase); plumb through
 *  `__edgeDynImportImpl` to lib's callback with the right
 *  `phase` constant.  No test exercises source/defer dynamic
 *  phase today, which is why this is documented-but-not-fixed. */
export function rewriteDynamicImport(source: string): string {
  const [imports] = parse(source);
  let out = source;
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.d < 0) continue;
    out = out.slice(0, imp.ss) + "__edgeDynImport" + out.slice(imp.d);
  }
  return out;
}

/** Rewrite static-import specifiers in source using the given map.
 *  Imports for unknown specifiers are left untouched (the browser
 *  will fail to resolve them — that's a loader bug, surfaced loud).
 *
 *  ALSO strips `with { ... }` import attribute clauses on rewritten
 *  imports.  The browser enforces the attribute (e.g. `type: "json"`
 *  requires application/json MIME from the import target) — but our
 *  rewritten blob URL serves text/javascript regardless of the
 *  original module type, because the synthetic module we generated
 *  re-exports the parsed values via JS `export` syntax.  Dropping
 *  the clause keeps the browser happy. */
export function rewriteImportSpecifiers(
  source: string,
  map: Map<string, string>,
): string {
  if (map.size === 0) return source;
  const [imports] = parse(source);
  let out = source;
  // Reverse iteration so each splice keeps earlier offsets valid;
  // within one import, strip attributes (rightmost) before replacing
  // the specifier (leftmost) for the same reason.
  for (let i = imports.length - 1; i >= 0; i--) {
    const imp = imports[i];
    if (imp.d !== -1 || imp.n === undefined) continue;
    const replacement = map.get(imp.n);
    if (replacement === undefined) continue;
    if (imp.a >= 0) {
      // imp.a is the position of `{`; scan back past whitespace to
      // before `with`, then forward via brace-matching for the close.
      let withStart = imp.a;
      while (withStart > imp.e && /\s/.test(out[withStart - 1])) withStart--;
      withStart -= 4; // length of "with"
      let close = imp.a + 1;
      let depth = 1;
      while (close < out.length && depth > 0) {
        const ch = out[close];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        close++;
      }
      out = out.slice(0, withStart) + out.slice(close);
    }
    out = out.slice(0, imp.s) + replacement + out.slice(imp.e);
  }
  return out;
}

function jsId(name: string): string {
  // Restrict to plausible identifier — block synthetic export names
  // like `default` from breaking the `export let default` template.
  if (name === "default") return `__edgeDefault__`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `__edgeExp_${name.replace(/[^A-Za-z0-9_$]/g, "_")}`;
}

/** Invoke a synthetic module's `evaluateCallback` if one was captured
 *  during `create_synthetic`.  The callback uses `this.setExport(name,
 *  value)` to populate exports (per Node's vm.SyntheticModule API).
 *  We intercept by providing a proxy `this` whose `setExport` writes
 *  directly into `record.namespace`.  Idempotent — only runs once. */
function runSyntheticEvalSteps(record: ModuleRecord): void {
  if (record.kind !== "synthetic") return;
  // Idempotent: check our own flag instead of `record.status`, which
  // evaluateRecord sets to kEvaluating (3) before calling
  // synthesizeUrl → synthesizeBlobUrl → us, so the status alone can't
  // tell us whether the eval steps already ran.
  if (record._syntheticEvalRan) return;
  const fn = record.syntheticEvalSteps;
  if (typeof fn !== "function") {
    record._syntheticEvalRan = true;
    return;
  }
  try {
    const proxy = {
      setExport(name: string, value: unknown): void {
        record.namespace[name] = value;
      },
    };
    fn.call(proxy);
    record._syntheticEvalRan = true;
  } catch (e) {
    record.error = e;
    record.status = 5; // kErrored
    record._syntheticEvalRan = true;
    throw e;
  }
}

/** Cross-realm registry for synthetic-module export values that
 *  aren't JSON-inlineable (functions, classes, WebAssembly memory /
 *  tables, etc.).  Keyed by a stable id assigned per (record, name)
 *  pair so the blob source can pull the live reference from
 *  `globalThis.__edgeSyntheticExports.get(id)` at evaluation time.
 *  Lives on globalThis so the SW-served blob (which runs in the same
 *  browser-V8 realm as our handler) can read it. */
let nextSyntheticExportId = 1;
function getSyntheticExportsMap(): Map<number, unknown> {
  type G = { __edgeSyntheticExports?: Map<number, unknown> };
  const g = globalThis as G;
  if (!g.__edgeSyntheticExports) g.__edgeSyntheticExports = new Map();
  return g.__edgeSyntheticExports;
}

/** Decide if a value is safely JSON-inlineable.  Stricter than just
 *  trying `JSON.stringify`: `JSON.stringify(new Date())` returns a
 *  valid string, but `JSON.parse(...)` gives back a string rather than
 *  a Date — silently lossy.  We restrict to genuine plain JSON values
 *  (null / boolean / number / string / plain Array / plain Object
 *  composed of the same).  Everything else routes through the
 *  global-lookup path. */
function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return true;
  if (t !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) if (!isPlainJsonValue(item)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(value as object)) {
    if (!isPlainJsonValue((value as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Serialize a value as a JS literal that can be inlined into source.
 *  Plain JSON values are inlined directly (fastest path, no global
 *  state, no SW lookup at evaluation).  Non-plain values (functions,
 *  WebAssembly exports, Date, Map, class instances) get a global-
 *  lookup expression that reads from
 *  `globalThis.__edgeSyntheticExports`.  The id parameter is allocated
 *  per (record, name) pair so multiple modules don't collide.  Returns
 *  the literal source fragment plus a side-effect of registering the
 *  value if it took the global path. */
function inlineOrLookup(value: unknown): string {
  if (value === undefined) return "undefined";
  if (isPlainJsonValue(value)) {
    return JSON.stringify(value)!;
  }
  const id = nextSyntheticExportId++;
  getSyntheticExportsMap().set(id, value);
  return "globalThis.__edgeSyntheticExports.get(" + id + ")";
}

/** Free any blob URLs the record (or its subgraph) holds. Called on
 *  module destroy to avoid leaking blob backing memory.  Native URL
 *  ctor is cached at `worker.ts` module load (edge.js swaps the
 *  global URL during boot — `revokeObjectURL` on the patched URL
 *  would throw). */
export function releaseBlobUrls(record: ModuleRecord, visited = new Set<ModuleRecord>()): void {
  if (visited.has(record)) return;
  visited.add(record);
  const NativeURL = (globalThis as { __edgeNativeURL?: typeof URL }).__edgeNativeURL ?? URL;
  if (record.blobUrl) {
    try { NativeURL.revokeObjectURL(record.blobUrl); } catch { /* best effort */ }
    record.blobUrl = undefined;
  }
  for (const dep of record.deps) releaseBlobUrls(dep, visited);
}

/** Walk a record's subgraph and return all SW URLs it owns.  Used by
 *  `unofficial_napi_module_wrap_destroy` to clear the SW cache via the
 *  `edge-esm-clear` message — keeps the SW's in-memory source registry
 *  bounded so long-running pages with many ESM evaluations don't leak. */
export function collectSwUrls(record: ModuleRecord, visited = new Set<ModuleRecord>()): string[] {
  const out: string[] = [];
  function visit(r: ModuleRecord): void {
    if (visited.has(r)) return;
    visited.add(r);
    if (r.swUrl) {
      out.push(r.swUrl);
      r.swUrl = undefined;
    }
    for (const dep of r.deps) visit(dep);
  }
  visit(record);
  return out;
}

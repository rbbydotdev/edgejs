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
}

export interface ModuleRequest {
  specifier: string;
  attributes: Record<string, string>;
  // 1 = source phase, 2 = evaluation phase (matches kSourcePhase /
  // kEvaluationPhase in binding_module_wrap.cc).
  phase: 1 | 2;
}

/** Lightweight import-statement scanner. NOT a full parser — handles
 *  the static-import patterns ESM uses + skips line/block comments
 *  and quoted strings. Dynamic `import(...)` expressions are ignored
 *  here (they're handled at runtime via the dynamically-callback
 *  registered in Phase 3, not pre-resolved).
 *
 *  Trade-off: vs. vendoring acorn (~80KB), this is ~150 lines and
 *  covers every static import pattern in the ESM spec. If a test
 *  fails because of a parser miss we'll swap to acorn — keep the
 *  signature stable so the caller doesn't care.
 */
export function extractModuleRequests(source: string): ModuleRequest[] {
  const out: ModuleRequest[] = [];
  let i = 0;
  const n = source.length;

  // Skip a quoted string starting at position p (source[p] is the
  // opening quote). Returns the index AFTER the closing quote.
  function skipString(p: number, quote: string): number {
    let j = p + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === quote) return j + 1;
      // Template literals can contain ${...} — skip the embedded expr
      // by tracking brace depth.
      if (quote === "`" && ch === "$" && source[j + 1] === "{") {
        j += 2;
        let depth = 1;
        while (j < n && depth > 0) {
          const cc = source[j];
          if (cc === "{") depth++;
          else if (cc === "}") depth--;
          else if (cc === "'" || cc === '"' || cc === "`") { j = skipString(j, cc); continue; }
          else if (cc === "/" && source[j + 1] === "/") { j = skipLineComment(j); continue; }
          else if (cc === "/" && source[j + 1] === "*") { j = skipBlockComment(j); continue; }
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  }

  function skipLineComment(p: number): number {
    let j = p + 2;
    while (j < n && source[j] !== "\n") j++;
    return j;
  }

  function skipBlockComment(p: number): number {
    let j = p + 2;
    while (j < n - 1) {
      if (source[j] === "*" && source[j + 1] === "/") return j + 2;
      j++;
    }
    return n;
  }

  // Match a quoted specifier starting at position p (skips whitespace
  // first). Returns {specifier, end} or null.
  function readSpecifier(p: number): { specifier: string; end: number } | null {
    let j = p;
    while (j < n && /\s/.test(source[j])) j++;
    if (j >= n) return null;
    const q = source[j];
    if (q !== "'" && q !== '"' && q !== "`") return null;
    const end = skipString(j, q);
    return { specifier: source.slice(j + 1, end - 1), end };
  }

  // Match `with { type: 'json' }` import attributes after a specifier.
  function readAttributes(p: number): { attributes: Record<string, string>; end: number } {
    let j = p;
    while (j < n && /\s/.test(source[j])) j++;
    if (j + 4 > n || source.slice(j, j + 4) !== "with") return { attributes: {}, end: p };
    j += 4;
    while (j < n && /\s/.test(source[j])) j++;
    if (source[j] !== "{") return { attributes: {}, end: p };
    j++;
    const attrs: Record<string, string> = {};
    while (j < n) {
      while (j < n && /[\s,]/.test(source[j])) j++;
      if (source[j] === "}") { j++; break; }
      // key
      let keyStart = j;
      if (source[j] === "'" || source[j] === '"') {
        const r = readSpecifier(j);
        if (!r) return { attributes: attrs, end: j };
        const key = r.specifier;
        j = r.end;
        while (j < n && /\s/.test(source[j])) j++;
        if (source[j] !== ":") return { attributes: attrs, end: j };
        j++;
        const v = readSpecifier(j);
        if (!v) return { attributes: attrs, end: j };
        attrs[key] = v.specifier;
        j = v.end;
      } else {
        while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
        const key = source.slice(keyStart, j);
        while (j < n && /\s/.test(source[j])) j++;
        if (source[j] !== ":") return { attributes: attrs, end: j };
        j++;
        const v = readSpecifier(j);
        if (!v) return { attributes: attrs, end: j };
        attrs[key] = v.specifier;
        j = v.end;
      }
    }
    return { attributes: attrs, end: j };
  }

  // Main scan: walk forward; on each keyword boundary check whether
  // we're at an import/export statement; otherwise skip strings/comments.
  while (i < n) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") { i = skipLineComment(i); continue; }
    if (ch === "/" && source[i + 1] === "*") { i = skipBlockComment(i); continue; }
    if (ch === "'" || ch === '"' || ch === "`") { i = skipString(i, ch); continue; }
    // Only match at start-of-line or after whitespace (avoid matching
    // `reimport` etc.).
    const prev = i === 0 ? "\n" : source[i - 1];
    if (!/[\s;{}]/.test(prev)) { i++; continue; }
    // Try import.
    if (source.startsWith("import", i) && !/[A-Za-z0-9_$]/.test(source[i + 6] ?? "")) {
      const stmtStart = i;
      let j = i + 6;
      // Skip whitespace; if the next non-space is `(` or `.`, it's a
      // dynamic-import or import.meta — not a static statement.
      while (j < n && /\s/.test(source[j])) j++;
      if (source[j] === "(" || source[j] === ".") { i = j; continue; }
      // Bare side-effect import: `import 'mod';`
      const sp = readSpecifier(j);
      if (sp) {
        const attrs = readAttributes(sp.end);
        out.push({ specifier: sp.specifier, attributes: attrs.attributes, phase: 2 });
        i = attrs.end;
        continue;
      }
      // Named/default: scan forward for `from <spec>`.
      const fromIdx = findFromKeyword(j);
      if (fromIdx < 0) { i = stmtStart + 6; continue; }
      const after = readSpecifier(fromIdx);
      if (after) {
        const attrs = readAttributes(after.end);
        out.push({ specifier: after.specifier, attributes: attrs.attributes, phase: 2 });
        i = attrs.end;
        continue;
      }
      i = stmtStart + 6;
      continue;
    }
    // Try export ... from.
    if (source.startsWith("export", i) && !/[A-Za-z0-9_$]/.test(source[i + 6] ?? "")) {
      const stmtStart = i;
      const fromIdx = findFromKeyword(i + 6);
      if (fromIdx < 0) { i = stmtStart + 6; continue; }
      const after = readSpecifier(fromIdx);
      if (after) {
        const attrs = readAttributes(after.end);
        out.push({ specifier: after.specifier, attributes: attrs.attributes, phase: 2 });
        i = attrs.end;
        continue;
      }
      i = stmtStart + 6;
      continue;
    }
    i++;
  }

  return out;

  // Helper: scan forward for the `from` keyword, skipping
  // strings/comments. Returns the index just AFTER `from` (so the
  // caller can read the specifier from there), or -1 if not found
  // before the next `;` or newline+`}`.
  function findFromKeyword(p: number): number {
    let j = p;
    while (j < n) {
      const c = source[j];
      if (c === "/" && source[j + 1] === "/") { j = skipLineComment(j); continue; }
      if (c === "/" && source[j + 1] === "*") { j = skipBlockComment(j); continue; }
      if (c === "'" || c === '"' || c === "`") { j = skipString(j, c); continue; }
      if (c === ";") return -1;
      if (source.startsWith("from", j) &&
          /\s/.test(source[j - 1] ?? "") &&
          !/[A-Za-z0-9_$]/.test(source[j + 4] ?? "")) {
        return j + 4;
      }
      j++;
    }
    return -1;
  }
}

/** Detect top-level await heuristically. False positives are fine
 *  (we revise after evaluate); false negatives just mean we don't
 *  set the eager flag — the v8 evaluate promise still resolves
 *  correctly. */
export function detectTopLevelAwait(source: string): boolean {
  // Simple pass: look for `await` at a position that's not inside
  // any function (`function`, `=>`) block. Without a real parser this
  // is approximate. Cheap heuristic: any `await` in the source AT ALL
  // that's not preceded by `async function`/`async (` on the same
  // logical line. Real Node uses V8's IsGraphAsync; we'll get that
  // from evaluate's Promise behavior anyway.
  return /(^|[\s;{}(])await\s/.test(source);
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
    // Synthetic module: emit a module that exports the captured values.
    // exportNames is set by create_synthetic; values are populated via
    // set_export (Phase 1 only handles the bare-named case — no
    // evaluation steps).
    const names = record.exportNames ?? [];
    const exports = names.map((nm) => `export let ${jsId(nm)};`).join("\n");
    const blob = new NativeBlob([exports], { type: "text/javascript" });
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
  const preamble = synthesizePreamble(record);
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
    const names = record.exportNames ?? [];
    return names.map((nm) => `export let ${jsId(nm)};`).join("\n");
  }
  if (record.kind === "required-facade") {
    return "export default {};";
  }
  const source = record.source ?? "";
  const rewritten = rewriteImportSpecifiers(source, specifierToUrl);
  const preamble = synthesizePreamble(record);
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
 *  absolute URLs (blob:/data:/https:). */
function synthesizePreamble(record: ModuleRecord): string {
  const url = JSON.stringify(record.url);
  return [
    "const __edgeImportMeta = (globalThis.__edgeImportMetaFactory ? globalThis.__edgeImportMetaFactory(" + url + ") : { url: " + url + " });",
    "const __edgeDynImport = (specifier) => (globalThis.__edgeDynImportImpl ? globalThis.__edgeDynImportImpl(specifier, " + url + ") : import(specifier));",
  ].join("\n");
}

/** Rewrite `import.meta` property accesses to `__edgeImportMeta`.  We
 *  bind the meta object once per module so subsequent property reads
 *  see whatever the host's `initializeImportMetaCallback` populated. */
export function rewriteImportMeta(source: string): string {
  // Skip strings/comments by reusing the scanner.  Simpler: target the
  // exact token `import.meta` at word boundaries; false positives are
  // rare since `import.meta` is meaningless anywhere else.
  return source.replace(/\bimport\.meta\b/g, "__edgeImportMeta");
}

/** Rewrite `import(...)` expressions to `__edgeDynImport(...)`.  We
 *  detect `import` followed by optional whitespace then `(` and rewrite
 *  the keyword (the `(` and inner expression are left untouched).
 *  Avoids matching `import.meta` (already rewritten above) or the
 *  static-import statement (which always has identifier/spec list after
 *  the keyword, never `(`). */
export function rewriteDynamicImport(source: string): string {
  // Tokenize-aware replace: a literal `import(` with no leading word
  // char is dynamic import.  We replace `import` with `__edgeDynImport`.
  return source.replace(/(^|[^A-Za-z0-9_$.])import(\s*\()/g, "$1__edgeDynImport$2");
}

/** Rewrite static-import specifiers in source using the given map.
 *  Imports for unknown specifiers are left untouched (the browser
 *  will fail to resolve them — that's a loader bug, surfaced loud). */
export function rewriteImportSpecifiers(
  source: string,
  map: Map<string, string>,
): string {
  if (map.size === 0) return source;
  const requests = extractModuleRequests(source);
  if (requests.length === 0) return source;
  // Walk the source again, replacing each specifier in-place. We need
  // the original position of each string literal; the scanner found
  // them but didn't record positions. Easier: scan again and do a
  // substring replace anchored to the quoted form.
  let out = source;
  for (const req of requests) {
    const replacement = map.get(req.specifier);
    if (!replacement) continue;
    const sq = `'${req.specifier}'`;
    const dq = `"${req.specifier}"`;
    if (out.includes(sq)) {
      out = out.replace(sq, `"${replacement}"`);
    } else if (out.includes(dq)) {
      out = out.replace(dq, `"${replacement}"`);
    }
    // If the literal isn't found (e.g. template literal in a sourceMap
    // comment) we leave it — the browser will error and we'll see it.
  }
  return out;
}

function jsId(name: string): string {
  // Restrict to plausible identifier — block synthetic export names
  // like `default` from breaking the `export let default` template.
  if (name === "default") return `__edgeDefault__`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `__edgeExp_${name.replace(/[^A-Za-z0-9_$]/g, "_")}`;
}

/** Free any blob URLs the record (or its subgraph) holds. Called on
 *  module destroy to avoid leaking blob backing memory. */
export function releaseBlobUrls(record: ModuleRecord, visited = new Set<ModuleRecord>()): void {
  if (visited.has(record)) return;
  visited.add(record);
  if (record.blobUrl) {
    try { URL.revokeObjectURL(record.blobUrl); } catch { /* best effort */ }
    record.blobUrl = undefined;
  }
  for (const dep of record.deps) releaseBlobUrls(dep, visited);
}

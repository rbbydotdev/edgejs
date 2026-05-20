# Wasmer Deploy: WASIX symlink component fs operations

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟢 | Fixed by canonicalizing follow-style raw filesystem operations and `process.chdir(...)` before passing paths to libuv. |
| **Severity** | High | Next.js bundle aliases such as `[id].rsc.func -> [id].func` cannot be read through the symlink path in WASIX. |
| **Last Updated (Created)** | 2026-05-20 (2026-05-20) | Added `process.chdir(...)` coverage after verifying `server.mjs` route handling under Wasmer. |

## Reproduction

Wasmer can resolve and stat symlinked directory paths, but the raw filesystem
operation that follows still receives `ENOENT`:

```sh
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir/hello.txt
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir/hello-link
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); fs.accessSync('/tmp/linked-dir/hello.txt'); const fd=fs.openSync('/tmp/linked-dir/hello.txt','r'); fs.closeSync(fd); console.log('open/access ok')"
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); process.chdir('/tmp/linked-dir'); console.log(process.cwd()); console.log(fs.readFileSync('hello-link','utf8').trim());"
wasmer run --volume quickjs-wasm/test/:/test --volume /Users/sadhbh/src/ImperfectProtocol/private-poker/.next-bundle:/app --net quickjs-wasm -- /app/server.mjs
```

The diagnostic output shows:

- `lstat('/tmp/linked-dir')` observes the symlink.
- `realpath('/tmp/linked-dir')` returns `/tmp/orig-dir`.
- `stat('/tmp/linked-dir')` follows the symlink and succeeds.
- `readdir('/tmp/linked-dir')` fails with `ENOENT`.
- `readFile('/tmp/linked-dir/hello.txt')` fails with `ENOENT`.
- `readFile('/tmp/linked-dir/hello-link')` fails with `ENOENT`.
- `process.chdir('/app/functions/...symlinked.func')` fails with `ENOENT`
  while the Next.js `server.mjs` adapter enters function directories.

Native Node and the native Edge QuickJS CLI both succeed for the same paths.

## Action plan

1. Keep `lstat` and `readlink` using the literal path, because they must report
   the symlink itself.
2. For filesystem operations that normally follow symlinks, canonicalize the
   existing path before passing it to libuv.
3. For `open`-style operations that may create a missing final path, canonicalize
   the parent path and append the final component.
4. Patch the raw Edge filesystem binding used by `readFileUtf8`, `readdir`,
   `open`, `writeFileUtf8`, and `access`.
5. Patch `process.chdir(...)`, because server adapters enter function
   directories before requiring function handlers.
6. Rebuild the QuickJS WASIX package and verify the focused Wasmer symlink probes
   plus the Next.js `server.mjs` route paths.

## Resolution

`src/edge_fs.cc` now resolves paths for follow-style operations before calling
libuv. Existing paths use `realpath` directly. Paths with missing components
resolve the nearest existing ancestor and append the original remaining path.
Open operations skip this resolver when `O_NOFOLLOW` is set.

`src/internal_binding/binding_fs.cc` applies the same destination-resolution rule
to `fs.mkdirSync(...)`, `fs.mkdir(..., cb)`, `fs.symlinkSync(...)`, and the async
symlink binding path, so creating directories and symlinks inside a symlinked
directory works too. The symlink target remains unchanged because relative
symlink targets are interpreted relative to the link path.

`src/edge_process.cc` resolves `process.chdir(...)` destinations before calling
`uv_chdir(...)`. Errors still report the originally requested destination.

Literal symlink APIs still use the original path:

- `lstat`
- `readlink`

Creation APIs resolve only the destination parent:

- `mkdir`
- `symlink`

Process state APIs resolve the destination directory:

- `process.chdir`

## Verification

Native QuickJS CLI:

```sh
./build-edge-quickjs-cli/edge quickjs-wasm/test/check-readfile.js quickjs-wasm/tmp/linked-dir
./build-edge-quickjs-cli/edge quickjs-wasm/test/check-readfile.js quickjs-wasm/tmp/linked-dir/hello.txt
./build-edge-quickjs-cli/edge quickjs-wasm/test/check-readfile.js quickjs-wasm/tmp/linked-dir/hello-link
```

QuickJS WASIX rebuild:

```sh
cd /Users/sadhbh/src/dev/edgejs/quickjs-wasm/ && ./build.sh
```

Focused Wasmer probes:

```sh
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/orig-dir
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/orig-dir/hello.txt
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir/hello.txt
wasmer run --volume quickjs-wasm/test/:/test --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- /test/check-readfile.js /tmp/linked-dir/hello-link
```

Symlink creation through a linked directory:

```sh
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); const rm=p=>{try{fs.unlinkSync(p)}catch{}}; rm('/tmp/orig-dir/wasm-made-file-link'); rm('/tmp/orig-dir/wasm-made-dir-link'); fs.mkdirSync('/tmp/orig-dir/wasm-child-dir',{recursive:true}); fs.writeFileSync('/tmp/orig-dir/wasm-child-dir/nested.txt','Nested!'); fs.symlinkSync('hello.txt','/tmp/linked-dir/wasm-made-file-link'); fs.symlinkSync('wasm-child-dir','/tmp/linked-dir/wasm-made-dir-link','dir'); console.log(JSON.stringify({ fileLink: fs.readlinkSync('/tmp/linked-dir/wasm-made-file-link'), fileText: fs.readFileSync('/tmp/linked-dir/wasm-made-file-link','utf8').trim(), dirLink: fs.readlinkSync('/tmp/linked-dir/wasm-made-dir-link'), dirEntries: fs.readdirSync('/tmp/linked-dir/wasm-made-dir-link') }));"
```

Creation through a linked directory:

```sh
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); try{fs.unlinkSync('/tmp/orig-dir/wasm-created.txt')}catch{}; fs.writeFileSync('/tmp/linked-dir/wasm-created.txt','Created!'); console.log(fs.readFileSync('/tmp/orig-dir/wasm-created.txt','utf8'));"
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); try{fs.rmdirSync('/tmp/orig-dir/wasm-created-dir')}catch{}; fs.mkdirSync('/tmp/linked-dir/wasm-created-dir'); console.log(fs.statSync('/tmp/orig-dir/wasm-created-dir').isDirectory());"
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); try{fs.rmdirSync('/tmp/orig-dir/wasm-recursive-dir/leaf')}catch{}; try{fs.rmdirSync('/tmp/orig-dir/wasm-recursive-dir')}catch{}; fs.mkdirSync('/tmp/linked-dir/wasm-recursive-dir/leaf',{recursive:true}); console.log(fs.statSync('/tmp/orig-dir/wasm-recursive-dir/leaf').isDirectory());"
```

Changing directory through a linked directory:

```sh
wasmer run --volume quickjs-wasm/tmp/:/tmp quickjs-wasm -- -e "const fs=require('fs'); process.chdir('/tmp/linked-dir'); console.log(process.cwd()); console.log(fs.readFileSync('hello-link','utf8').trim());"
```

Next.js bundle shape:

```sh
wasmer run --volume quickjs-wasm/test/:/test --volume /Users/sadhbh/src/ImperfectProtocol/private-poker/.next-bundle:/app ./quickjs-wasm -- /test/check-readfile.js '/app/functions/lobby/[id].rsc.func/'
wasmer run --volume quickjs-wasm/test/:/test --volume /Users/sadhbh/src/ImperfectProtocol/private-poker/.next-bundle:/app ./quickjs-wasm -- /test/check-readfile.js '/app/functions/lobby/[id].rsc.func/.vc-config.json'
```

Next.js `server.mjs` function entry:

```sh
wasmer run --volume quickjs-wasm/test/:/test --volume /Users/sadhbh/src/ImperfectProtocol/private-poker/.next-bundle:/app --net quickjs-wasm -- /app/server.mjs
curl -sS -o /dev/null -w '/ %{http_code} %{content_type}\n' http://127.0.0.1:3000/
curl -sS -o /dev/null -w '/about %{http_code} %{content_type}\n' http://127.0.0.1:3000/about
curl -sS -o /dev/null -w '/leaderboard %{http_code} %{content_type}\n' http://127.0.0.1:3000/leaderboard
curl -sS -o /dev/null -w '/main-lobby %{http_code} %{content_type}\n' http://127.0.0.1:3000/main-lobby
curl -sS -o /dev/null -w '/lobby/1 %{http_code} %{content_type}\n' http://127.0.0.1:3000/lobby/1
```

All of the focused probes passed after the rebuild.

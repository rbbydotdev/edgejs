;; Minimal WASI hello-world. Writes "hello from wasi in browser\n" to stdout
;; via fd_write, then exits with status 0.  Used by the browser harness as a
;; smoke test that the worker + import bridge + WASI shim actually run a
;; wasm end-to-end.
(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))
  (memory (export "memory") 1)

  ;; The greeting bytes (26 chars). Placed at offset 64 in memory.
  (data (i32.const 64) "hello from wasi in browser\n")

  (func $_start (export "_start")
    ;; iovec at offset 0: { base = 64, len = 27 }
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 27))

    (call $fd_write
      (i32.const 1)    ;; fd = 1 (stdout)
      (i32.const 0)    ;; iovs ptr
      (i32.const 1)    ;; iovs count
      (i32.const 32))  ;; nwritten out-ptr
    drop

    (call $proc_exit (i32.const 0))
  )
)

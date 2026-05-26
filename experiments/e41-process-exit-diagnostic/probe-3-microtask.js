// e41 probe 3: does process.exit work from a microtask context (not
// unhandledRejection, but a plain queueMicrotask). If yes, the bug is
// specific to unhandledRejection path.

console.log('[e41] start t=' + Math.round(performance.now()));

queueMicrotask(() => {
  console.log('[e41] in-microtask t=' + Math.round(performance.now()));
  process.exit(0);
  console.log('[e41] AFTER process.exit microtask t=' + Math.round(performance.now()));
});

setTimeout(() => {
  console.log('[e41] safety-timer t=' + Math.round(performance.now()));
  process.exit(1);
}, 200);

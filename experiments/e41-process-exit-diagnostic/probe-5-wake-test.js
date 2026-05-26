// e41 probe 5: test the wake hypothesis. If process.exit doesn't wake
// io_poll, then setTimeout(0) right after should force a wake.

process.on('unhandledRejection', (reason) => {
  console.log('[e41] handler-enter t=' + Math.round(performance.now()));
  process.exit(0);
  // Force a wake by scheduling a 0ms timer; if my hypothesis is right,
  // this should make uv_run return promptly via the 0ms timer firing.
  setTimeout(() => {
    console.log('[e41] wake-timer-fired t=' + Math.round(performance.now()));
  }, 0);
});

Promise.reject(new Error('boom'));

setTimeout(() => {
  console.log('[e41] safety-timer-fired t=' + Math.round(performance.now()));
  process.exit(1);
}, 100);

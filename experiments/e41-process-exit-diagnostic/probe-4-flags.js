// e41 probe 4: check process._exiting flag at various points to verify
// the exit-flag-is-set hypothesis.

process.on('unhandledRejection', (reason) => {
  console.log('[e41] handler-enter t=' + Math.round(performance.now()) + ' reason=' + reason);
  console.log('[e41] _exiting before exit=' + process._exiting);
  process.exit(0);
  console.log('[e41] AFTER process.exit t=' + Math.round(performance.now()) + ' _exiting=' + process._exiting);
});

Promise.reject(new Error('boom'));

// Multiple safety timers to sample the timeline
setTimeout(() => {
  console.log('[e41] timer-50ms t=' + Math.round(performance.now()) + ' _exiting=' + process._exiting);
}, 50);

setTimeout(() => {
  console.log('[e41] timer-100ms t=' + Math.round(performance.now()) + ' _exiting=' + process._exiting);
  process.exit(1);
}, 100);

// e41 probe 1: instrument process.reallyExit to verify if TerminateExecution
// actually interrupts JS after the napi binding returns.
//
// We wrap process.reallyExit to log enter/return. If TerminateExecution
// works, "AFTER reallyExit" should NEVER print after process.reallyExit
// is called.
//
// Run via browser-test-runner against this test file directly.

const realReallyExit = process.reallyExit.bind(process);
process.reallyExit = function(code) {
  console.log('[e41] BEFORE reallyExit code=' + code + ' t=' + Math.round(performance.now()));
  const ret = realReallyExit(code);
  console.log('[e41] AFTER reallyExit returned=' + ret + ' t=' + Math.round(performance.now()));
  return ret;
};

process.on('unhandledRejection', (reason) => {
  console.log('[e41] handler-enter t=' + Math.round(performance.now()) + ' reason=' + reason);
  process.exit(0);
  console.log('[e41] AFTER process.exit(0) — handler continues t=' + Math.round(performance.now()));
});

Promise.reject(new Error('boom'));

setTimeout(() => {
  console.log('[e41] safety-timer-fired t=' + Math.round(performance.now()));
  process.exit(1);
}, 100);

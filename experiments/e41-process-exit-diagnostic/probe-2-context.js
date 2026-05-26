// e41 probe 2: does process.exit terminate cleanly when called from
// OUTSIDE an unhandledRejection handler? If yes, the bug is specific
// to the microtask-drain context. If no, process.exit is broken
// everywhere.

console.log('[e41] start t=' + Math.round(performance.now()));

// Wrap reallyExit to log
const realReallyExit = process.reallyExit.bind(process);
process.reallyExit = function(code) {
  console.log('[e41] BEFORE reallyExit code=' + code + ' t=' + Math.round(performance.now()));
  const ret = realReallyExit(code);
  console.log('[e41] AFTER reallyExit returned=' + ret + ' t=' + Math.round(performance.now()));
  return ret;
};

// Call exit from setTimeout (uv timer callback context — NOT a microtask)
setTimeout(() => {
  console.log('[e41] in-timer t=' + Math.round(performance.now()));
  process.exit(0);
  console.log('[e41] AFTER process.exit in-timer t=' + Math.round(performance.now()));
}, 50);

// Safety timer 200ms later
setTimeout(() => {
  console.log('[e41] safety-timer t=' + Math.round(performance.now()));
  process.exit(1);
}, 200);

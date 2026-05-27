// Regression test for the latent chunk-size > ring-slot-size bug.
// The executor pushes ONE stdout call with ~20 KB. The chunker must
// split this into multiple ring-slot-sized pieces; before the fix,
// ASYNC_CHUNK_SIZE was 16 KB while slots are 4 KB, so emitChunked
// would write 16 KB into a 4 KB slot and throw RangeError, surfacing
// as an inscrutable spawn failure.
//
// Expected: stdout receives the full 20 KB, byte-for-byte intact,
// exit code 0.
const { spawn } = require('child_process');

const N = 20 * 1024; // 20 KB -- bigger than slot size, smaller than ring capacity

const child = spawn('big-stdout', []);

let total = 0;
let firstWrong = -1;
child.stdout.on('data', (chunk) => {
  // Each byte should be (offset % 251). Quick integrity check.
  for (let i = 0; i < chunk.length; i++) {
    const expected = (total + i) % 251;
    if (chunk[i] !== expected && firstWrong < 0) firstWrong = total + i;
  }
  total += chunk.length;
});
child.on('exit', (code) => {
  console.log('total bytes:', total, 'expected:', N);
  if (firstWrong < 0) console.log('integrity ok? true');
  else console.log('integrity ok? false (first wrong at ' + firstWrong + ')');
  console.log('exit:', code);
  process.exit(0);
});

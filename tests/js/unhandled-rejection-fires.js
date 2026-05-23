// process.on('unhandledRejection', ...) must receive Promise rejections
// that no .catch() handles, within the same tick as the rejection.
//
// NOTES.md flags "process.on('unhandledRejection') partially wired":
// rejections ARE captured but don't surface to user listeners before
// process exit.  This test will fail until that gap is closed; kept
// here as the smoke for when it is.  See companion .skip file.
process.on('unhandledRejection', (reason) => {
  console.log('caught:' + reason);
  process.exit(0);
});
Promise.reject(new Error('boom'));
// Keep the loop alive briefly so the handler has a chance to fire.
setTimeout(() => {
  console.log('handler did not fire');
  process.exit(1);
}, 100);

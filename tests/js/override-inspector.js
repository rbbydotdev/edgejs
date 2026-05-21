// Verifies the universal module-override hook reaches lazy-required builtins.
// The runner invokes this test with `--override inspector:null` so
// `require('inspector')` should return an empty object instead of throwing
// ERR_INSPECTOR_NOT_AVAILABLE.
const i = require('inspector');
console.log(Object.keys(i).length === 0 ? 'override-ok' : 'override-bad');

const { randomBytes } = require('crypto');
const a = randomBytes(16);
const b = randomBytes(16);
console.log(a.length === 16 && b.length === 16 && a.toString('hex') !== b.toString('hex') ? 'rb-ok' : 'rb-bad');

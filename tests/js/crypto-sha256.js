const c = require('crypto');
console.log(c.createHash('sha256').update('hello').digest('hex'));

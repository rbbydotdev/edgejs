const { randomUUID } = require('crypto');
const u = randomUUID();
const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
console.log(re.test(u) ? 'uuid-ok' : `uuid-bad:${u}`);

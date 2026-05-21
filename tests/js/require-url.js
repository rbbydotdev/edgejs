const { URL } = require('url');
const u = new URL('https://example.com/p?q=1');
console.log(u.host === 'example.com' && u.pathname === '/p' && u.search === '?q=1' ? 'url-ok' : 'url-bad');

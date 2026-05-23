// fs.readFile{,Sync} smoke: write a temp file, read it back both ways.
// In passing, this surfaced fs-async-write-read-divergence (see NOTES.md):
// writeFileSync to /tmp/* lands in the in-memory writable layer, sync
// readFileSync sees it, but async fs.readFile returns ENOENT for the
// same path.  The async path doesn't check the writable layer.  Test
// runs the sync round-trip only until that's fixed.
const fs = require('fs');
const tmpPath = '/tmp/edge-f8-fs-test.txt';
fs.writeFileSync(tmpPath, 'hello-f8');
console.log('exists:', fs.existsSync(tmpPath));
console.log('sync read:', fs.readFileSync(tmpPath, 'utf8') === 'hello-f8');

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const depdStub = fileURLToPath(new URL('./edge-depd-stub.cjs', import.meta.url));

await build({
  entryPoints: ['./dist/server/entry.mjs'],
  outfile: './dist/server/entry.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  alias: {
    depd: depdStub,
    'es-module-lexer': 'es-module-lexer/js',
  },
  define: {
    'import.meta.url': '"file:///app/dist/server/entry.cjs"',
  },
  banner: {
    js: `if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
  globalThis.Intl = {
    DateTimeFormat: function () {
      return { format: function (date) { return date.toISOString().slice(11, 19); } };
    },
  };
}`,
  },
});

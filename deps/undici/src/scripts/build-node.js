'use strict'

const esbuild = require('esbuild')

const nativeLlhttp = process.env.UNDICI_USE_NATIVE_LLHTTP === '1'

esbuild.buildSync({
  entryPoints: ['index-fetch.js'],
  bundle: true,
  platform: 'node',
  outfile: 'undici-fetch.js',
  define: {
    esbuildDetection: '1',
    UNDICI_USE_NATIVE_LLHTTP: nativeLlhttp ? 'true' : 'false'
  },
  dropLabels: nativeLlhttp ? ['UNDICI_WASM_LLHTTP'] : [],
  keepNames: true,
  minifySyntax: true,
  logLevel: 'info'
})

require('./strip-comments')

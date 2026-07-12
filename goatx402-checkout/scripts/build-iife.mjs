import { build } from 'esbuild'

await build({
  entryPoints: ['src/browser.ts'],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: 'dist/checkout.global.js',
})

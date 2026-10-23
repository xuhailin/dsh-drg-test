import { defineConfig } from 'tsdown'

/** Keep saved-result validation independent from Node runtime services. */
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false },
  { entry: ['lib/types/result.js'], outDir: 'lib', format: ['esm'], platform: 'neutral', target: 'es2024', fixedExtension: false, dts: false, clean: false },
])

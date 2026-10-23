import { defineConfig } from 'tsdown'

/** Build the provider service and browser-safe JSON entry as independent bundles. */
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false },
  { entry: ['lib/types/wire.js'], outDir: 'lib', format: ['esm'], platform: 'neutral', target: 'es2024', fixedExtension: false, dts: false, clean: false },
])

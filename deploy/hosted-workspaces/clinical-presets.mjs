/** Generate independent clinical presets without evaluating deferred YAML expressions. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dump } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { generateClinicalPathwayPreset, generateClinicalPreset, requiresClinicalPreset } from './company-presets.mjs'

const args = process.argv.slice(2)
if (args.length === 2 && args[0] === '--required') {
  process.stdout.write(`${String(requiresClinicalPreset(resolve(args[1])))}\n`)
} else {
  const flags = new Set(args.filter(arg => arg.startsWith('--')))
  const paths = args.filter(arg => !arg.startsWith('--'))
  if ((paths.length !== 2 && paths.length !== 3)
    || [...flags].some(flag => !['--clinical-pathway', '--pathway-reader'].includes(flag))
    || (flags.has('--pathway-reader') && !flags.has('--clinical-pathway'))) {
    throw new Error('Usage: clinical-presets.mjs <root> <output-path> [profile-patch] [--clinical-pathway [--pathway-reader]], or --required <runtime-patch>')
  }
  const profile = paths[2] === undefined ? undefined : resolve(paths[2])
  const entry = flags.has('--clinical-pathway')
    ? generateClinicalPathwayPreset(resolve(paths[0]), profile, flags.has('--pathway-reader'))
    : generateClinicalPreset(resolve(paths[0]), profile)
  writeFileSync(resolve(paths[1]), dump([{ insert: [entry] }], { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
}

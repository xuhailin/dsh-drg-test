/** Generate the optional hosted clinical preset without evaluating deferred YAML expressions. */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dump } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { generateClinicalPreset, requiresClinicalPreset } from './company-presets.mjs'

const args = process.argv.slice(2)
if (args.length === 2 && args[0] === '--required') {
  process.stdout.write(`${String(requiresClinicalPreset(resolve(args[1])))}\n`)
} else {
  if (args.length !== 2 && args.length !== 3) throw new Error('Usage: clinical-presets.mjs <root> <output-path> [profile-patch], or --required <runtime-patch>')
  const entry = generateClinicalPreset(resolve(args[0]), args[2] === undefined ? undefined : resolve(args[2]))
  writeFileSync(resolve(args[1]), dump([{ insert: [entry] }], { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
}

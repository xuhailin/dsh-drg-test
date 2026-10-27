/** Mirror only EMR-owned definition artifacts; --check also verifies source identity when --emr-root is supplied. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const check = args.includes('--check')
const sourceIndex = args.indexOf('--emr-root')
const emrRoot = sourceIndex < 0 ? undefined : args[sourceIndex + 1]
if (!check && emrRoot === undefined) throw new Error('Supply --emr-root to the EMR checkout containing the canonical definition.')
const files = ['definition.schema.json', 'definition.generated.d.ts', 'definition-schema.generated.ts', 'definition-reader.ts']
const manifestPath = join(root, 'src/emr/source.json')
const previous = check ? JSON.parse(await readFile(manifestPath, 'utf8')) : null
const hashes = {}
for (const file of files) {
  const target = join(root, 'src/emr', file)
  let expected
  if (emrRoot !== undefined) {
    expected = await readFile(resolve(emrRoot, 'src/app/core/models/clinical-pathway/definition', file), 'utf8')
    if (file === 'definition-reader.ts') expected = expected.replace("'./definition-schema.generated'", "'./definition-schema.generated.ts'").replace("'./definition.generated'", "'./definition.generated.d.ts'")
    if (!check) await writeFile(target, expected)
  }
  const actual = await readFile(target, 'utf8')
  if (expected !== undefined && expected !== actual) throw new Error(`EMR definition mirror is stale: ${file}`)
  hashes[file] = createHash('sha256').update(actual).digest('hex')
  if (check && previous.files[file] !== hashes[file]) throw new Error(`Definition mirror digest differs: ${file}`)
}
if (!check) await writeFile(manifestPath, JSON.stringify({ owner: 'emr-app', schemaVersion: 1, sourceDirectory: 'src/app/core/models/clinical-pathway/definition', files: hashes }, null, 2) + '\n')
console.log(`EMR shared definition: ${files.length} artifacts ${check ? 'verified' : 'synchronized'}.`)

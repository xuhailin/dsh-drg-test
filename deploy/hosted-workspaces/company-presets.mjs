/** Generate deployment overrides for the compaction services owned by Web presets. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const presets = ['minimal', 'standard', 'ptc', 'cordis']

function readList(file, optional = false) {
  let text
  try { text = readFileSync(file, 'utf8') }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return []
    throw error
  }
  let value
  try { value = load(text, { schema: entryListSchema }) }
  catch (_error) {
    // Parser excerpts could disclose values in a user profile.
    throw new Error(`Invalid YAML entry list: ${file}`)
  }
  if (!Array.isArray(value)) throw new Error(`Expected a YAML entry list: ${file}`)
  return value
}

function exactlyOne(rows, id, file) {
  const matches = rows.filter(row => row?.id === id)
  if (matches.length !== 1) throw new Error(`Expected one ${id} entry in ${file}; found ${matches.length}`)
  return matches[0]
}

function failPatch(message, ...details) {
  throw new Error(`Company preset patch failed: ${message}; ${details.join(', ')}`)
}

/**
 * Apply the company compaction policy inside each shipped Web preset.
 * Preserves every other preset field and deferred YAML expression. Fails before
 * producing output when a canonical preset or policy target is missing.
 * @param {string} root - Repository or installed image root containing packages and deploy.
 * @param {string} [profilePatch] - Optional user profile patch file; an absent file contributes no overrides.
 * @returns {import('./company-presets.mjs').CompanyPresetPatch[]} Full preset config overrides for a later Loader patch layer.
 */
export function generateCompanyPresets(root, profilePatch) {
  const policyFile = resolve(root, 'deploy/hosted-workspaces/company-model.runtime.patch.yml')
  const policy = exactlyOne(readList(policyFile), 'compaction-basic', policyFile)
  if (policy.config === null || typeof policy.config !== 'object' || Array.isArray(policy.config)) {
    throw new Error(`Expected compaction-basic config in ${policyFile}`)
  }
  const canonical = presets.map((preset) => {
    const file = resolve(root, `packages/bundle/web-app/presets/${preset}.patch.yml`)
    const rows = applyEntryPatches([], readList(file), failPatch)
    return exactlyOne(rows, `preset-${preset}`, file)
  })
  const ids = new Set(canonical.map(row => row.id))
  const overrides = profilePatch === undefined ? [] : readList(profilePatch, true).filter(row => ids.has(row?.id))
  const effective = applyEntryPatches(canonical, overrides, failPatch)
  return effective.map((entry) => {
    if (!Array.isArray(entry.config?.plugins)) throw new Error(`Expected plugins in ${entry.id}`)
    return {
      id: entry.id,
      config: {
        ...entry.config,
        plugins: applyEntryPatches(entry.config.plugins, [policy], failPatch),
      },
    }
  })
}

function main(args) {
  if (args.length !== 2 && args.length !== 3) throw new Error('Usage: company-presets.mjs <root> <output-path> [profile-patch]')
  const rows = generateCompanyPresets(resolve(args[0]), args[2] === undefined ? undefined : resolve(args[2]))
  writeFileSync(resolve(args[1]), dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2))
}

/** Generate hosted clinical compositions and company compaction overrides. */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const presets = ['minimal', 'standard', 'ptc', 'cordis']
const clinicalPresetId = 'clinical-review'
const clinicalPersona = 'You are a clinical record review assistant powered by the {{model}} model. Review the authorized encounter using original evidence and exact citations. Identify inconsistencies, missing information, and items requiring clinician verification. Findings are advisory and require human review; never block discharge or modify EMR records. DRG and DIP calculation are unavailable; do not invent groups, scores, or payment conclusions.'

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

function canonicalPreset(root, preset) {
  const file = resolve(root, `packages/bundle/web-app/presets/${preset}.patch.yml`)
  return exactlyOne(applyEntryPatches([], readList(file), failPatch), `preset-${preset}`, file)
}

function profileOverrides(rows, profilePatch) {
  const ids = new Set(rows.map(row => row.id))
  const overrides = profilePatch === undefined ? [] : readList(profilePatch, true).filter(row => ids.has(row?.id))
  return applyEntryPatches(rows, overrides, failPatch)
}

/**
 * Derive the hosted clinical preset from the installed standard tool composition.
 * Replaces only the persona prefix, then applies this preset's saved profile edits.
 * @param {string} root - Repository or installed image root.
 * @param {string} [profilePatch] - Optional saved profile patch.
 * @returns {import('./company-presets.mjs').ClinicalPresetDeclaration} Complete clinical preset declaration.
 * @throws When the standard preset or its persona row is missing.
 */
export function generateClinicalPreset(root, profilePatch) {
  const standard = canonicalPreset(root, 'standard')
  const persona = exactlyOne(standard.config.plugins, 'persona', 'standard preset plugins')
  if (persona.name !== '@deepseek-ai/dsh-persona' || persona.config === null || typeof persona.config !== 'object' || Array.isArray(persona.config)) {
    throw new Error('Expected a configured dsh-persona row in the standard preset')
  }
  const declaration = {
    id: `preset-${clinicalPresetId}`,
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      ...standard.config,
      id: clinicalPresetId,
      name: 'Clinical review',
      description: 'Evidence-based clinical record review with advisory findings for clinicians.',
      plugins: applyEntryPatches(standard.config.plugins, [{ id: 'persona', config: { ...persona.config, prefix: clinicalPersona } }], failPatch),
    },
  }
  return exactlyOne(profileOverrides([declaration], profilePatch), declaration.id, 'clinical preset overrides')
}

/**
 * Read whether a runtime overlay mounts clinical review with the hosted clinical preset.
 * Deferred expressions remain data; a clinical preset selection must be literal.
 * @param {string} runtimePatch - Runtime overlay to inspect.
 * @returns {boolean} Whether the clinical preset declaration is required.
 * @throws When overlay rows or the clinical preset selection are invalid.
 */
export function requiresClinicalPreset(runtimePatch) {
  let required = false
  function visit(rows) {
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid runtime overlay row in ${runtimePatch}`)
      if (row.insert === undefined && typeof row.id !== 'string' && typeof row.name !== 'string') throw new Error(`Invalid runtime overlay row in ${runtimePatch}`)
      if (row.insert !== undefined) {
        if (!Array.isArray(row.insert)) throw new Error(`Expected runtime overlay insert list in ${runtimePatch}`)
        visit(row.insert)
      }
      if (row.name === '@deepseek-ai/dsh-experimental-clinical-review' && row.disabled !== true) {
        if (row.config === null || typeof row.config !== 'object' || Array.isArray(row.config)) throw new Error(`Expected clinical runtime configuration in ${runtimePatch}`)
        if (row.config.agentPreset !== undefined && typeof row.config.agentPreset !== 'string') throw new Error(`Clinical runtime overlay requires a literal agentPreset in ${runtimePatch}`)
        if (row.config.agentPreset === clinicalPresetId) required = true
      }
      if (row.group === true) {
        if (!Array.isArray(row.config)) throw new Error(`Expected runtime overlay group list in ${runtimePatch}`)
        visit(row.config)
      }
    }
  }
  visit(readList(runtimePatch))
  return required
}

/**
 * Apply the company compaction policy inside each shipped Web preset.
 * Preserves every other preset field and deferred YAML expression. Fails before
 * producing output when a canonical preset or policy target is missing.
 * @param {string} root - Repository or installed image root containing packages and deploy.
 * @param {string} [profilePatch] - Optional user profile patch file; an absent file contributes no overrides.
 * @param {boolean} [includeClinicalReview] - Also override the hosted clinical preset.
 * @returns {import('./company-presets.mjs').CompanyPresetPatch[]} Full preset config overrides for a later Loader patch layer.
 */
export function generateCompanyPresets(root, profilePatch, includeClinicalReview = false) {
  const policyFile = resolve(root, 'deploy/hosted-workspaces/company-model.runtime.patch.yml')
  const policy = exactlyOne(readList(policyFile), 'compaction-basic', policyFile)
  if (policy.config === null || typeof policy.config !== 'object' || Array.isArray(policy.config)) {
    throw new Error(`Expected compaction-basic config in ${policyFile}`)
  }
  const canonical = presets.map(preset => canonicalPreset(root, preset))
  if (includeClinicalReview) canonical.push(generateClinicalPreset(root))
  const effective = profileOverrides(canonical, profilePatch)
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
  const clinical = args.at(-1) === '--clinical-review'
  const paths = clinical ? args.slice(0, -1) : args
  if (paths.length !== 2 && paths.length !== 3) throw new Error('Usage: company-presets.mjs <root> <output-path> [profile-patch] [--clinical-review]')
  const rows = generateCompanyPresets(resolve(paths[0]), paths[2] === undefined ? undefined : resolve(paths[2]), clinical)
  writeFileSync(resolve(paths[1]), dump(rows, { schema: entryListSchema, noRefs: true, lineWidth: -1 }))
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2))
}

/** Configuration-only generator for deployment-owned Web preset overrides. */
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** A complete replacement of one canonical preset's configuration. */
export interface CompanyPresetPatch {
  readonly id: string
  readonly config: PresetDefinition
}

/** A complete Loader declaration for the optional clinical review composition. */
export interface ClinicalPresetDeclaration extends CompanyPresetPatch {
  readonly name: string
}

/**
 * Load the independent physician-facing clinical composition.
 * @param root - Repository or installed image root.
 * @param profilePatch - Optional saved profile patch.
 * @returns Complete clinical preset declaration after saved clinical overrides.
 * @throws If the clinical declaration or prompt-policy row is missing.
 */
export function generateClinicalPreset(root: string, profilePatch?: string): ClinicalPresetDeclaration

/**
 * Inspect a runtime overlay without evaluating deferred YAML expressions.
 * @param runtimePatch - Runtime overlay path.
 * @returns Whether its clinical plugin selects the clinical-review preset.
 * @throws If overlay rows or the clinical preset selection are invalid.
 */
export function requiresClinicalPreset(runtimePatch: string): boolean

/**
 * Apply the company compaction policy to canonical Web and optional clinical presets.
 * @param root - Repository or installed image root containing packages and deploy.
 * @param profilePatch - Optional user profile patch file; missing files add no overrides.
 * @param includeClinicalReview - Also override the hosted clinical preset.
 * @returns Complete preset overrides preserving other plugins and deferred expressions.
 * @throws If a canonical preset or its compaction policy target is missing.
 */
export function generateCompanyPresets(root: string, profilePatch?: string, includeClinicalReview?: boolean): CompanyPresetPatch[]

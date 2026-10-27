/** Configuration-only generator for deployment-owned Web preset overrides. */
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** A complete replacement of one canonical preset's configuration. */
export interface CompanyPresetPatch {
  readonly id: string
  readonly config: PresetDefinition
}

/** A complete Loader declaration for an independent clinical composition. */
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
 * Load pathway analysis and optionally enable its gateway-backed read tools.
 * @param root - Repository or installed image root.
 * @param profilePatch - Optional saved profile patch.
 * @param enableReader - Enable pathway read tools after saved profile edits.
 * @returns Complete pathway analysis declaration after its saved overrides.
 * @throws If the declaration or prompt-policy row is missing.
 */
export function generateClinicalPathwayPreset(root: string, profilePatch?: string, enableReader?: boolean): ClinicalPresetDeclaration

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
 * @param includeClinicalPathway - Also override the independent pathway analysis preset.
 * @param enablePathwayReader - Enable pathway read tools after saved profile edits.
 * @returns Complete preset overrides preserving other plugins and deferred expressions.
 * @throws If a canonical preset or its compaction policy target is missing.
 */
export function generateCompanyPresets(root: string, profilePatch?: string, includeClinicalReview?: boolean, includeClinicalPathway?: boolean, enablePathwayReader?: boolean): CompanyPresetPatch[]

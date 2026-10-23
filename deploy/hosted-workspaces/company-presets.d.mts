/** Configuration-only generator for deployment-owned Web preset overrides. */
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** A complete replacement of one canonical preset's configuration. */
export interface CompanyPresetPatch {
  readonly id: string
  readonly config: PresetDefinition
}

/**
 * Apply the company compaction policy to the four canonical Web presets.
 * @param root - Repository or installed image root containing packages and deploy.
 * @param profilePatch - Optional user profile patch file; missing files add no overrides.
 * @returns Complete preset overrides preserving other plugins and deferred expressions.
 * @throws If a canonical preset or its compaction policy target is missing.
 */
export function generateCompanyPresets(root: string, profilePatch?: string): CompanyPresetPatch[]

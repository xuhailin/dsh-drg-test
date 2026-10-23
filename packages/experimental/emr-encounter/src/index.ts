/** Replaceable, authorized encounter evidence reader definition. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ClinicalActor, EncounterBinding, EncounterErrorCode, EncounterSnapshot } from './types.ts'
export type * from './types.ts'
export * from './directory.ts'
export { actorSchema, bindingSchema, evidenceCategories, grantResultSchema, launchClaimSchema, parseActor, parseBinding, parseLaunchClaim, parseLaunchGrantResult, parseSnapshot, snapshotSchema, sourceSchema } from './schema.ts'

declare module '@deepseek-ai/cordis' { interface Context { encounterReader: EncounterReader } }

/** Expected read failures expose a stable code without source credentials or SQL. */
export class EncounterReadError extends Error {
  override readonly name = 'EncounterReadError'
  /**
 * @param code - Handling category.
 * @param message - Safe action-oriented diagnostic.
 * @param options - Retained internal cause.
 */
  constructor(readonly code: EncounterErrorCode, message: string, options?: ErrorOptions) { super(message, options) }
}

/** Providers reauthorize every capture and return immutable, bounded original evidence. */
export abstract class EncounterReader extends Service {
  constructor(ctx: Context) { super(ctx, 'encounterReader') }
  /**
   * Capture one authorized encounter without modifying its source records.
   * @param actor - Authenticated transport identity; never model-selected.
   * @param binding - Previously accepted actor and encounter binding.
   * @param signal - Caller cancellation; dependent work stops before publication.
   * @returns Complete validated snapshot, or a typed failure with no accepted partial snapshot.
   */
  abstract capture(actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot>
}
export default EncounterReader

/** Explicit development encounter authorization and authenticated binding identifiers. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { EncounterReadError, parseBinding, type ClinicalActor, type EncounterBinding, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { readBoundedFile } from './files.ts'

const text = z.string().min(1).max(512)
const entrySchema = z.strictObject({
  issuer: text, subject: text, sourceSystem: text, hospitalCode: text,
  inpatId: z.string().regex(/^[1-9][0-9]{0,18}$/), inpatCode: text.optional(), sourceVisitId: text.optional(),
})
const policySchema = z.strictObject({ schemaVersion: z.literal(1), entries: z.array(entrySchema) })
/** One configured synthetic, deidentified, or explicitly authorized test encounter. */
export type AccessEntry = z.infer<typeof entrySchema>

/** Authorizes each read against the current operator-owned allowlist. */
export class EncounterPolicy {
  constructor(
    private readonly path: string, private readonly maxBytes: number,
    private readonly key: string, private readonly sourceSystem: string,
  ) {}
  /**
 * Validate deployment policy before exposing routes.
 * @returns Completion or a configuration failure.
 */
  async validate(): Promise<void> { await this.load() }
  private async load(): Promise<z.infer<typeof policySchema>> {
    try {
      const policyText = await readBoundedFile(this.path, this.maxBytes)
      const policy = policySchema.parse(JSON.parse(policyText))
      const identities = policy.entries.map(entry => JSON.stringify([
        entry.issuer, entry.subject, entry.sourceSystem, entry.hospitalCode, entry.inpatId,
      ]))
      if (new Set(identities).size !== identities.length) throw new Error('Duplicate clinical access entry')
      return policy
    } catch (error) {
      throw new EncounterReadError('source-unavailable', 'Clinical access policy is unavailable or invalid; ask the operator to repair it.', { cause: error })
    }
  }
  /**
   * Re-read policy so removal takes effect before the next protected operation.
   * @param actor - Verified runtime actor.
   * @param claim - Requested encounter identifiers.
   * @returns Exactly one matching grant, otherwise forbidden or invalid policy.
   */
  async authorize(actor: ClinicalActor, claim: Pick<LaunchClaim, 'sourceSystem' | 'hospitalCode' | 'inpatId' | 'inpatCode' | 'sourceVisitId'>): Promise<AccessEntry> {
    const policy = await this.load()
    const matches = policy.entries.filter(entry => entry.issuer === actor.issuer && entry.subject === actor.subject
      && entry.sourceSystem === this.sourceSystem
      && entry.sourceSystem === claim.sourceSystem && entry.hospitalCode === claim.hospitalCode && entry.inpatId === claim.inpatId)
    const match = matches[0]
    if (matches.length !== 1 || match === undefined) throw new EncounterReadError('forbidden', 'This account has no unique authorization for the requested encounter.')
    if ((match.inpatCode !== undefined && claim.inpatCode !== undefined && match.inpatCode !== claim.inpatCode)
      || (claim.sourceVisitId !== undefined && match.sourceVisitId !== claim.sourceVisitId)) throw new EncounterReadError('source-mismatch', 'Encounter identifiers disagree with the approved mapping.')
    return match
  }
  /**
   * Create a restart-verifiable binding after source identifier checks.
   * @param actor - Verified runtime actor.
   * @param entry - Authorized encounter mapping.
   * @param inpatCode - Actual admission code returned by the source.
   * @returns Authenticated opaque binding for this exact actor and encounter.
   */
  bind(actor: ClinicalActor, entry: AccessEntry, inpatCode?: string): EncounterBinding {
    const fields = {
      schemaVersion: 1 as const, actorId: actor.id, actorIssuer: actor.issuer, actorSubject: actor.subject,
      sourceSystem: entry.sourceSystem, hospitalCode: entry.hospitalCode, inpatId: entry.inpatId,
      ...(inpatCode === undefined ? {} : { inpatCode }),
      ...(entry.sourceVisitId === undefined ? {} : { sourceVisitId: entry.sourceVisitId }),
    }
    return parseBinding({ ...fields, bindingId: this.identifier(fields) })
  }
  /**
   * Reject modified, foreign-actor or retired-key bindings before a database read.
   * @param actor - Verified runtime actor.
   * @param binding - Decoded wire binding.
   */
  verify(actor: ClinicalActor, binding: EncounterBinding): void {
    const { bindingId, ...fields } = binding
    const expected = this.identifier(fields)
    if (actor.id !== binding.actorId || actor.issuer !== binding.actorIssuer || actor.subject !== binding.actorSubject
      || !timingSafeEqual(Buffer.from(bindingId), Buffer.from(expected))) throw new EncounterReadError('invalid-binding', 'Reopen the encounter from the authorized launch entry.')
  }
  private identifier(fields: Omit<EncounterBinding, 'bindingId'>): string {
    const hash = createHmac('sha256', this.key).update(JSON.stringify([fields.schemaVersion, fields.actorId, fields.actorIssuer, fields.actorSubject, fields.sourceSystem, fields.hospitalCode, fields.inpatId, fields.inpatCode ?? null, fields.sourceVisitId ?? null])).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  }
}

/**
 * Generate an unpredictable one-use grant.
 * @returns 256-bit capability.
 */
export function newGrant(): string { return randomBytes(32).toString('hex') }

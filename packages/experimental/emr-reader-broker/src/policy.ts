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
const departmentSchema = z.strictObject({ issuer: text, subject: text, sourceSystem: text, hospitalCode: text, departmentCode: text })
const policySchema = z.strictObject({
  schemaVersion: z.literal(1), entries: z.array(entrySchema), departments: z.array(departmentSchema).optional(),
})
/** One configured synthetic, deidentified, or explicitly authorized test encounter. */
export type AccessEntry = z.infer<typeof entrySchema>
/** Operator-authorized department for one exact authenticated account and hospital. */
export type DepartmentAccess = z.infer<typeof departmentSchema>
/** Current grants for one transport-authenticated actor and configured source. */
export interface ActorAccess { readonly entries: readonly AccessEntry[]; readonly departments: readonly DepartmentAccess[] }
type EncounterClaim = Pick<LaunchClaim, 'sourceSystem' | 'hospitalCode' | 'inpatId' | 'inpatCode' | 'sourceVisitId'>

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
      const departments = (policy.departments ?? []).map(entry => JSON.stringify([
        entry.issuer, entry.subject, entry.sourceSystem, entry.hospitalCode, entry.departmentCode,
      ]))
      if (new Set(departments).size !== departments.length) throw new Error('Duplicate clinical department grant')
      return policy
    } catch (error) {
      throw new EncounterReadError('source-unavailable', 'Clinical access policy is unavailable or invalid; ask the operator to repair it.', { cause: error })
    }
  }
  /**
   * Read current grants for one authenticated account and this configured source.
   * @param actor - Verified runtime actor.
   * @returns Exact encounter and department grants; an empty set grants no access.
   */
  async grants(actor: ClinicalActor): Promise<ActorAccess> {
    const policy = await this.load()
    const own = (entry: AccessEntry | DepartmentAccess): boolean => entry.issuer === actor.issuer
      && entry.subject === actor.subject && entry.sourceSystem === this.sourceSystem
    return { entries: policy.entries.filter(own), departments: (policy.departments ?? []).filter(own) }
  }
  /** Reject unrelated accounts and scopes before SQL; department admission still needs current source verification.
   * @param actor - Verified runtime actor.
   * @param claim - Requested encounter identifiers.
   * @returns Exact encounter grant, or undefined when a current department must be checked.
   */
  async admission(actor: ClinicalActor, claim: EncounterClaim): Promise<AccessEntry | undefined> {
    const grants = await this.grants(actor)
    if (claim.sourceSystem !== this.sourceSystem) throw new EncounterReadError('forbidden', 'This clinical source is not authorized.')
    const match = grants.entries.find(entry => entry.hospitalCode === claim.hospitalCode && entry.inpatId === claim.inpatId)
    if (match === undefined) {
      if (!grants.departments.some(entry => entry.hospitalCode === claim.hospitalCode)) throw new EncounterReadError('forbidden', 'This account has no authorization for the requested encounter or department.')
      if (claim.sourceVisitId !== undefined) throw new EncounterReadError('source-mismatch', 'No source visit alias is configured for this department grant.')
      return undefined
    }
    if ((match.inpatCode !== undefined && claim.inpatCode !== undefined && match.inpatCode !== claim.inpatCode)
      || (claim.sourceVisitId !== undefined && match.sourceVisitId !== claim.sourceVisitId)) throw new EncounterReadError('source-mismatch', 'Encounter identifiers disagree with the approved mapping.')
    return match
  }
  /** Re-read the policy and require the current department when no exact encounter grant exists.
   * @param actor - Verified runtime actor.
   * @param claim - Requested encounter identifiers.
   * @param departmentCode - Current source department, required for department grants.
   * @returns Authorized encounter mapping, otherwise a typed denial.
   */
  async authorize(actor: ClinicalActor, claim: EncounterClaim, departmentCode?: string): Promise<AccessEntry> {
    const exact = await this.admission(actor, claim)
    if (exact !== undefined) return exact
    const grants = await this.grants(actor)
    if (departmentCode === undefined || !grants.departments.some(entry => entry.hospitalCode === claim.hospitalCode
      && entry.departmentCode === departmentCode)) {
      throw new EncounterReadError('forbidden', 'The encounter is outside this account’s authorized departments. Reopen an authorized inpatient.')
    }
    return { issuer: actor.issuer, subject: actor.subject, sourceSystem: claim.sourceSystem,
      hospitalCode: claim.hospitalCode, inpatId: claim.inpatId }
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

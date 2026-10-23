/** PostgreSQL encounter provider with per-operation authorization and immutable evidence snapshots. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { EncounterReader, EncounterReadError, evidenceCategories, parseSnapshot, type ClinicalActor, type EncounterBinding, type EncounterSnapshot, type EvidenceCoverage, type LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { ReadDatabase, ReadTransaction } from './database.ts'
import { EncounterPolicy } from './policy.ts'
import { encounterIdentitySql, sourceQueries } from './sql.ts'

const identitySchema = z.strictObject({
  id: z.string(), inpat_code: z.string().nullable(), current_dept_code: z.string().nullable(), inpat_state_code: z.string().nullable(),
})
const rowSchema = z.strictObject({
  id: z.string(), state: z.string().nullable(), occurred_at: z.string().nullable(),
  available_at: z.string().nullable(), oversized: z.boolean(),
  body: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
})
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Source-specific reader; raw SQL and credentials stay outside personal workspaces. */
export class PgEncounterReader extends EncounterReader {
  constructor(
    ctx: Context, private readonly config: Config, private readonly policy: EncounterPolicy, private readonly database: ReadDatabase,
  ) { super(ctx) }
  /**
   * Verify claimed admission identifiers without reading clinical bodies.
   * @param actor - Verified SSO identity.
   * @param claim - Validated launch identifiers.
   * @param signal - Caller cancellation.
   * @param isActive - Runtime login admission checked before each source read.
   * @returns Reader-authenticated encounter binding.
   */
  async resolve(actor: ClinicalActor, claim: LaunchClaim, signal: AbortSignal, isActive?: () => boolean): Promise<EncounterBinding> {
    this.admit(signal, isActive)
    await this.policy.admission(actor, claim)
    const binding = await this.database.read(signal, async (transaction) => {
      this.admit(signal, isActive)
      const admission = await this.identity(transaction, claim)
      const entry = await this.currentAccess(actor, claim, admission)
      if ((entry.inpatCode !== undefined && entry.inpatCode !== admission.inpat_code)
        || (claim.inpatCode !== undefined && claim.inpatCode !== admission.inpat_code)) throw new EncounterReadError('source-mismatch', 'Admission identifiers disagree with the clinical source.')
      return this.policy.bind(actor, entry, admission.inpat_code ?? undefined)
    })
    await this.authorize(actor, binding, signal, isActive)
    return binding
  }
  /** Reauthorize saved-result reads; department grants require current admission data and fail closed on source outage.
   * @param actor - Verified transport identity.
   * @param binding - Signed encounter binding.
   * @param signal - Caller cancellation.
   * @param isActive - Current login admission.
   * @returns The unchanged binding after current permission checks.
   */
  async authorize(
    actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal, isActive?: () => boolean,
  ): Promise<EncounterBinding> {
    this.admit(signal, isActive)
    this.policy.verify(actor, binding)
    const exact = await this.policy.admission(actor, binding)
    if (exact === undefined) await this.database.read(signal, async (transaction) => {
      const current = await this.identity(transaction, binding)
      await this.currentAccess(actor, binding, current)
      if (binding.inpatCode !== undefined && binding.inpatCode !== current.inpat_code) throw new EncounterReadError('source-mismatch', 'The admission mapping changed. Reopen the encounter.')
    })
    this.admit(signal, isActive)
    return binding
  }
  /**
   * Capture original evidence after actor, binding and allowlist authorization.
   * @param actor - Verified transport identity.
   * @param binding - Reader-authenticated encounter binding.
   * @param signal - Caller cancellation.
   * @param isActive - Runtime login admission checked before each source read.
   * @returns Complete immutable evidence or a typed failure without partial acceptance.
   */
  async capture(
    actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal, isActive?: () => boolean,
  ): Promise<EncounterSnapshot> {
    this.admit(signal, isActive)
    this.policy.verify(actor, binding)
    await this.policy.admission(actor, binding)
    const snapshot = await this.database.read(signal, async (transaction) => {
      this.admit(signal, isActive)
      const admission = await this.identity(transaction, binding)
      const allowed = await this.currentAccess(actor, binding, admission)
      if ((binding.inpatCode !== undefined && binding.inpatCode !== admission.inpat_code)
        || (allowed.inpatCode !== undefined && allowed.inpatCode !== admission.inpat_code)) throw new EncounterReadError('source-mismatch', 'The admission mapping changed. Reopen the encounter.')
      const capturedAt = new Date().toISOString()
      const sources = []
      const coverage: EvidenceCoverage[] = []
      for (const query of sourceQueries) {
        this.admit(signal, isActive)
        const rows = await transaction.query(query.sql, [
          binding.inpatId, binding.hospitalCode, this.config.maxRowsPerCategory + 1,
          this.config.maxSourceBytes, this.config.maxResponseBytes,
        ])
        if (rows.length > this.config.maxRowsPerCategory) throw new EncounterReadError('limit-exceeded', `The ${query.category} source exceeds the configured record limit; no partial snapshot was accepted.`)
        let unread = false
        for (const value of rows) {
          const row = rowSchema.parse(value)
          if (row.oversized || row.body === null) throw new EncounterReadError('limit-exceeded', 'A source record exceeds the configured byte limit; no partial snapshot was accepted.')
          if (row.state === 'unreadable') unread = true
          const content = JSON.stringify(row.body)
          const contentDigest = digest(content)
          const metadata = { category: query.category, sourceId: row.id, state: row.state ?? 'unknown', ...(row.occurred_at === null ? {} : { occurredAt: row.occurred_at }), ...(row.available_at === null ? {} : { availableAt: row.available_at }) }
          sources.push({ ...metadata, sourceRef: `${query.category}:${row.id}`, sourceRevision: digest(JSON.stringify({ ...metadata, contentDigest })), content, contentDigest })
          if (Buffer.byteLength(JSON.stringify(sources)) > this.config.maxResponseBytes) throw new EncounterReadError('limit-exceeded', 'The combined clinical sources exceed the configured byte limit; no partial snapshot was accepted.')
        }
        coverage.push({ category: query.category, status: unread ? 'unread' : rows.length === 0 ? 'empty' : 'complete', ...(unread ? { detail: 'Some document bodies are unavailable; metadata does not replace readable original text.' } : {}) })
      }
      for (const category of evidenceCategories) if (!coverage.some(item => item.category === category)) coverage.push({ category, status: 'unsupported', detail: 'This provider has no verified reader for this category.' })
      const revisionInput = { bindingId: binding.bindingId, providerRevision: 'emr-pg-readonly-v1', sources, coverage }
      const value = {
        schemaVersion: 1, ...revisionInput, capturedAt, cutoff: capturedAt,
        caseRevision: digest(JSON.stringify(revisionInput)),
      }
      if (Buffer.byteLength(JSON.stringify(value)) > this.config.maxResponseBytes) throw new EncounterReadError('limit-exceeded', 'The complete clinical snapshot exceeds the configured byte limit; no partial snapshot was accepted.')
      return parseSnapshot(value)
    })
    await this.authorize(actor, binding, signal, isActive)
    this.admit(signal, isActive)
    return snapshot
  }
  private admit(signal: AbortSignal, isActive?: () => boolean): void {
    if (signal.aborted) throw new EncounterReadError('cancelled', 'Clinical read was cancelled.')
    if (isActive !== undefined && !isActive()) throw new EncounterReadError('forbidden', 'Sign in again before reading clinical data.')
  }
  private async currentAccess(actor: ClinicalActor, claim: LaunchClaim | EncounterBinding, current: z.infer<typeof identitySchema>) {
    const exact = await this.policy.admission(actor, claim)
    if (exact === undefined && current.inpat_state_code !== '4' && current.inpat_state_code !== '5') throw new EncounterReadError('forbidden', 'Department access is limited to current inpatients. Reopen an authorized encounter.')
    return this.policy.authorize(actor, claim, current.current_dept_code ?? undefined)
  }
  private async identity(transaction: ReadTransaction, claim: Pick<LaunchClaim, 'inpatId' | 'hospitalCode'>): Promise<z.infer<typeof identitySchema>> {
    const rows = await transaction.query(encounterIdentitySql, [claim.inpatId, claim.hospitalCode])
    if (rows.length !== 1) throw new EncounterReadError('not-found', 'No unique active encounter matches the authorized hospital and admission.')
    return identitySchema.parse(rows[0])
  }
}

/** Separate historical access policy; current-inpatient encounter grants do not confer access. */
import { z } from 'zod'
import type { HostedRuntimeActor } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { readBoundedFile } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import type { ReadScope } from './protocol.ts'

const text = z.string().min(1).max(512)
const scopeSchema = z.strictObject({
  issuer: text, subject: text, sourceSystem: text, hospitalCode: text,
  departmentCodes: z.array(text).min(1).max(100), departmentBasis: z.enum(['current', 'discharge']),
  admissionFrom: z.iso.datetime({ offset: true }), admissionTo: z.iso.datetime({ offset: true }),
  includeSharedDefinitions: z.boolean().default(false),
}).refine(scope => Date.parse(scope.admissionFrom) < Date.parse(scope.admissionTo), 'Admission window must be nonempty')
const policySchema = z.strictObject({ schemaVersion: z.literal(1), grants: z.array(scopeSchema) })
/** Model filters can narrow but never expand an authenticated policy grant. */
export interface ScopeSelection { hospitalCode?: string | undefined; departmentCodes?: string[] | undefined }

/** Re-read operator-owned grants at admission and before releasing protected results. */
export class PathwayPolicy {
  constructor(private readonly file: string, private readonly maxBytes: number, private readonly sourceSystem: string) {}
  /**
   * Validate required private configuration without reading clinical data.
   * @returns Completion or a safe configuration failure.
   */
  async validate(): Promise<void> { await this.load() }
  private async load(): Promise<z.infer<typeof policySchema>> {
    try {
      const value = policySchema.parse(JSON.parse(await readBoundedFile(this.file, this.maxBytes)))
      const keys = value.grants.map(grant => JSON.stringify([grant.issuer, grant.subject, grant.sourceSystem, grant.hospitalCode]))
      if (new Set(keys).size !== keys.length) throw new Error('Duplicate historical grant')
      return value
    } catch (error) {
      throw new EncounterReadError('source-unavailable', 'Pathway access policy is unavailable or invalid. Ask the operator to repair its configuration.', { cause: error })
    }
  }
  /**
   * Select an exact hospital grant and optionally narrower departments.
   * @param actor - Gateway-authenticated identity, never supplied by model arguments.
   * @param selection - Optional hospital and department filters.
   * @returns Scope whose time and department basis remain operator-owned.
   */
  async select(actor: HostedRuntimeActor, selection: ScopeSelection): Promise<ReadScope> {
    const { grants } = await this.load()
    const own = grants.filter(grant => grant.issuer === actor.issuer && grant.subject === actor.subject
      && grant.sourceSystem === this.sourceSystem)
    const candidates = own.filter(grant => selection.hospitalCode === undefined || grant.hospitalCode === selection.hospitalCode)
    const grant = candidates[0]
    if (grant === undefined) throw new EncounterReadError('forbidden', 'This account has no historical pathway access for the requested hospital.')
    if (candidates.length !== 1) throw new EncounterReadError('invalid-request', 'Specify hospitalCode to select one of this account’s authorized hospitals.')
    const departments = selection.departmentCodes ?? grant.departmentCodes
    if (departments.length === 0 || !departments.every(dept => grant.departmentCodes.includes(dept))) throw new EncounterReadError('forbidden', 'The requested departments are outside this account’s historical access.')
    return { hospitalCode: grant.hospitalCode, departmentCodes: [...new Set(departments)], departmentBasis: grant.departmentBasis,
      admissionFrom: grant.admissionFrom, admissionTo: grant.admissionTo, includeSharedDefinitions: grant.includeSharedDefinitions }
  }
}

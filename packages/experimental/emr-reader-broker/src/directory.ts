/** Fixed-query directory of the authenticated account’s authorized departments and current inpatients. */
import { z } from 'zod'
import {
  EncounterReadError, departmentDirectorySchema, patientDirectorySchema,
  type ClinicalActor, type DepartmentDirectory, type PatientDirectory, type PatientDirectoryRequest,
} from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { Config } from './config.ts'
import type { ReadDatabase } from './database.ts'
import type { ActorAccess, EncounterPolicy } from './policy.ts'

/** Department grants use active source metadata; exact encounter grants contribute only their current inpatient department. */
export const departmentsSql = `WITH authorized AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS a(hospital_code text, department_code text, inpat_id text, inpat_code text)
), departments AS (
  SELECT a.hospital_code, d.dept_code AS department_code, d.dept_name AS department_name
  FROM authorized a JOIN pub_department d ON d.cur_hospital_code = a.hospital_code AND d.dept_code = a.department_code AND d.state = 1
  UNION
  SELECT r.cur_hospital_code, r.current_dept_code, COALESCE(NULLIF(r.current_dept_name, ''), r.current_dept_code)
  FROM authorized a JOIN cpoe_inpat_record r ON r.cur_hospital_code = a.hospital_code AND r.inpat_id::text = a.inpat_id
  AND (a.inpat_code IS NULL OR a.inpat_code = r.inpat_code)
  WHERE r.is_valid = true AND r.inpat_state_code IN ('4', '5') AND r.current_dept_code IS NOT NULL
) SELECT hospital_code, department_code, max(department_name) AS department_name FROM departments
GROUP BY hospital_code, department_code ORDER BY hospital_code, department_code LIMIT $2`

/** Caller search is literal text, and every selector remains a bound value. */
export const patientsSql = `SELECT r.inpat_id::text AS inpat_id, r.inpat_code, r.patient_name, r.bed_name
FROM cpoe_inpat_record r
WHERE r.cur_hospital_code = $1 AND r.current_dept_code = $2 AND r.is_valid = true AND r.inpat_state_code IN ('4', '5')
AND ($3::boolean OR EXISTS (
  SELECT 1 FROM jsonb_to_recordset($4::jsonb) AS allowed(inpat_id text, inpat_code text)
  WHERE allowed.inpat_id = r.inpat_id::text AND (allowed.inpat_code IS NULL OR allowed.inpat_code = r.inpat_code)
))
AND ($5 = '' OR position(lower($5) in lower(r.patient_name)) > 0 OR position(lower($5) in lower(r.inpat_code)) > 0 OR position(lower($5) in lower(r.bed_name)) > 0)
ORDER BY r.bed_name NULLS LAST, r.inpat_id LIMIT $6 OFFSET $7`

const departmentRow = z.strictObject({ hospital_code: z.string(), department_code: z.string(), department_name: z.string() })
const patientRow = z.strictObject({
  inpat_id: z.string(), inpat_code: z.string().nullable(), patient_name: z.string(), bed_name: z.string().nullable(),
})

/** Directory reads carry no clinical evidence and never create encounter permission. */
export class PgEncounterDirectory {
  constructor(private readonly config: Config, private readonly policy: EncounterPolicy, private readonly database: ReadDatabase) {}
  /** List only departments from the current actor’s policy; no caller-selected hospital broadens the query.
   * @param actor - Verified transport account.
   * @param signal - Caller cancellation.
   * @param isActive - Current login admission.
   * @returns Complete authorized department labels, or no partial result on failure.
   */
  async departments(actor: ClinicalActor, signal: AbortSignal, isActive?: () => boolean): Promise<DepartmentDirectory> {
    this.admit(signal, isActive)
    const access = await this.policy.grants(actor)
    if (access.entries.length === 0 && access.departments.length === 0) return { departments: [] }
    const authorized = [
      ...access.entries.map(entry => ({ hospital_code: entry.hospitalCode, inpat_id: entry.inpatId, inpat_code: entry.inpatCode })),
      ...access.departments.map(entry => ({ hospital_code: entry.hospitalCode, department_code: entry.departmentCode })),
    ]
    const result = await this.database.read(signal, async (transaction) => {
      const rows = await transaction.query(departmentsSql, [JSON.stringify(authorized), this.config.maxRowsPerCategory + 1])
      if (rows.length > this.config.maxRowsPerCategory) throw new EncounterReadError('limit-exceeded', 'The authorized department list exceeds its configured limit. Ask the operator to narrow access.')
      return departmentDirectorySchema.parse({ departments: rows.map((value) => {
        const row = departmentRow.parse(value)
        return { sourceSystem: this.config.sourceSystem, hospitalCode: row.hospital_code,
          departmentCode: row.department_code, departmentName: row.department_name }
      }) })
    })
    await this.finish(actor, access, result, signal, isActive)
    return result
  }
  /** Read a bounded inpatient page; guessed department identifiers cannot grant access.
   * @param actor - Verified transport account.
   * @param request - Validated source, hospital, department and page selectors.
   * @param signal - Caller cancellation.
   * @param isActive - Current login admission.
   * @returns Minimal patient identities; no diagnoses or clinical evidence.
   */
  async patients(
    actor: ClinicalActor, request: PatientDirectoryRequest, signal: AbortSignal, isActive?: () => boolean,
  ): Promise<PatientDirectory> {
    this.admit(signal, isActive)
    if (request.sourceSystem !== this.config.sourceSystem) throw new EncounterReadError('forbidden', 'This clinical source is not authorized.')
    if (request.pageSize > this.config.maxDirectoryPageSize) throw new EncounterReadError('limit-exceeded', 'Request fewer patients per page within the configured directory limit.')
    const access = await this.policy.grants(actor)
    const wholeDepartment = access.departments.some(entry => entry.hospitalCode === request.hospitalCode
      && entry.departmentCode === request.departmentCode)
    const entries = access.entries.filter(entry => entry.hospitalCode === request.hospitalCode)
      .map(entry => ({ inpat_id: entry.inpatId, inpat_code: entry.inpatCode }))
    if (!wholeDepartment && entries.length === 0) throw new EncounterReadError('forbidden', 'This account cannot browse the requested hospital or department.')
    const result = await this.database.read(signal, async (transaction) => {
      const rows = await transaction.query(patientsSql, [
        request.hospitalCode, request.departmentCode, String(wholeDepartment), JSON.stringify(entries), request.search ?? '',
        request.pageSize + 1, (request.pageIndex - 1) * request.pageSize,
      ])
      return patientDirectorySchema.parse({
        sourceSystem: request.sourceSystem, hospitalCode: request.hospitalCode, departmentCode: request.departmentCode,
        pageIndex: request.pageIndex, pageSize: request.pageSize, hasMore: rows.length > request.pageSize,
        patients: rows.slice(0, request.pageSize).map((value) => {
          const row = patientRow.parse(value)
          return { inpatId: row.inpat_id, patientName: row.patient_name,
            ...(row.inpat_code === null || row.inpat_code === '' ? {} : { inpatCode: row.inpat_code }),
            ...(row.bed_name === null || row.bed_name === '' ? {} : { bedName: row.bed_name }) }
        }),
      })
    })
    await this.finish(actor, access, result, signal, isActive)
    return result
  }
  private async finish(
    actor: ClinicalActor, before: ActorAccess, value: object, signal: AbortSignal, isActive?: () => boolean,
  ): Promise<void> {
    if (JSON.stringify(before) !== JSON.stringify(await this.policy.grants(actor))) throw new EncounterReadError('forbidden', 'Clinical permissions changed during this directory read. Reload the patient list.')
    this.admit(signal, isActive)
    if (Buffer.byteLength(JSON.stringify(value)) > this.config.maxResponseBytes) throw new EncounterReadError('limit-exceeded', 'The complete patient directory response exceeds its configured limit. Request a smaller page.')
  }
  private admit(signal: AbortSignal, isActive?: () => boolean): void {
    if (signal.aborted) throw new EncounterReadError('cancelled', 'Patient directory loading was cancelled.')
    if (isActive !== undefined && !isActive()) throw new EncounterReadError('forbidden', 'Sign in again before loading the patient directory.')
  }
}

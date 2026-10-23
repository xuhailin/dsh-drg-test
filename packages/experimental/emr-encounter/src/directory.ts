/** Browser-safe requests and minimal encounter directory responses; identity comes from authenticated transport. */
import { z } from 'zod'

const text = z.string().min(1).max(512).refine(value => !/[\x00-\x1f\x7f]/.test(value))
const scope = { sourceSystem: text, hospitalCode: text, departmentCode: text }
/** Department listing admits no caller-selected account or hospital scope. */
export const departmentDirectoryRequestSchema = z.strictObject({})
/** Authorized department labels without patient or clinical content. */
export const departmentDirectorySchema = z.strictObject({ departments: z.array(z.strictObject({ ...scope, departmentName: text })) })
/** A bounded patient page within one server-authorized department. */
export const patientDirectoryRequestSchema = z.strictObject({
  ...scope, pageIndex: z.number().int().min(1).max(1_000_000), pageSize: z.number().int().min(1).max(1000),
  search: z.string().max(100).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
})
/** Only the encounter identity and display labels needed to open a patient. */
export const patientDirectorySchema = z.strictObject({
  ...scope, pageIndex: z.number().int().min(1), pageSize: z.number().int().min(1), hasMore: z.boolean(),
  patients: z.array(z.strictObject({
    inpatId: z.string().regex(/^[1-9][0-9]{0,18}$/), inpatCode: text.optional(),
    patientName: text, bedName: text.optional(),
  })),
})
/** Transport-validated empty department listing request. */
export type DepartmentDirectoryRequest = z.infer<typeof departmentDirectoryRequestSchema>
/** Authorized departments, including their source and hospital identifiers. */
export type DepartmentDirectory = z.infer<typeof departmentDirectorySchema>
/** Caller-selected page within an authorized department. */
export type PatientDirectoryRequest = z.infer<typeof patientDirectoryRequestSchema>
/** Minimal inpatient page without diagnoses or evidence. */
export type PatientDirectory = z.infer<typeof patientDirectorySchema>

/** Validated read-only pathway requests and bounded JSON evidence. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Decimal identity of an admitted source record, kept exact across the database wire. */
export type SourceRecordId = Branded<'ClinicalPathwaySourceRecordId'>
const id = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .transform((value, context) => {
    if (BigInt(value) > 9223372036854775807n) {
      context.addIssue({ code: 'custom', message: 'Source identifier exceeds PostgreSQL bigint range' })
      return z.NEVER
    }
    return brandString<SourceRecordId>(value)
  })
const code = z.string().min(1).max(128)
const timestamp = z.iso.datetime({ offset: true })
const selection = { hospitalCode: code.optional(), departmentCodes: z.array(code).min(1).max(100).optional() }
const page = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(20) }

/** Search definitions or read one exact definition, never an arbitrary SQL fragment. */
export const pathwayRequestSchema = z.strictObject({ ...selection, ...page,
  pathwayId: id.optional(), search: z.string().min(1).max(200).optional(), pathwayCode: code.optional(), versionNo: code.optional(),
})
/** Explicit time, diagnosis, execution and cohort filters; no current-inpatient default. */
export const historyRequestSchema = z.strictObject({ ...selection, ...page,
  from: timestamp, to: timestamp, timeBasis: z.enum(['admission', 'discharge', 'execution']),
  mode: z.enum(['cohort', 'summary']).default('summary'), pathwayId: id.optional(),
  diagnosisCode: code.optional(), diagnosisSystem: z.enum(['hospital', 'icd']).default('icd'),
  diagnosisType: z.enum(['10', '14', '31']).optional(), mainDiagnosisOnly: z.boolean().default(false),
  executionStatus: z.enum(['0', '1', '2', '3', '4']).optional(),
})
/** Select one encounter and a bounded category or document passage. */
export const caseRequestSchema = z.strictObject({ ...selection, ...page,
  inpatId: id, category: z.enum(['encounter', 'diagnoses', 'orders', 'documents']),
  recordId: id.optional(), contentId: id.optional(), start: z.number().int().min(0).max(10000000).default(0),
  length: z.number().int().min(1).max(12000).default(4000),
}).refine(args => args.category === 'documents' || (args.recordId === undefined && args.contentId === undefined && args.start === 0),
  'Document selectors and passage offsets require category documents')
/** Arguments accepted by the definition reader. */
export type PathwayRequest = z.infer<typeof pathwayRequestSchema>
/** Arguments accepted by the historical-cohort reader. */
export type HistoryRequest = z.infer<typeof historyRequestSchema>
/** Arguments accepted by the encounter reader. */
export type CaseRequest = z.infer<typeof caseRequestSchema>
/** JSON-only row fields survive transport and Session logging without driver objects. */
export type ClinicalSourceRow = Record<string, z.infer<ReturnType<typeof z.json>>>
/** One fixed-query result before trusted source and scope metadata are added. */
export interface QueryResult {
  collections: Record<string, ClinicalSourceRow[]>
  measures: Record<string, number | string | null>
  nextOffset: number | null
  truncated: boolean
  coverage: string[]
}
/** Exact analysis admission scope granted by the operator to the authenticated account. */
export interface ReadScope {
  hospitalCode: string
  departmentCodes: string[]
  departmentBasis: 'current' | 'discharge'
  admissionFrom: string
  admissionTo: string
  includeSharedDefinitions?: boolean
}
/** Deployment bounds also apply to child collections and source text. */
export interface QueryLimits {
  maxRows: number
  maxRowBytes: number
  maxQueryBytes: number
  maxTextChars: number
  maxBranchDepth: number
  maxBranches: number
  herbalTables: boolean
  operationTables?: boolean
  dictionaryTables?: boolean
  allowWritableDevelopmentRole?: boolean
}
/** Complete accepted read result, including actual filters and per-call consistency limits. */
export const resultSchema = z.strictObject({
  schemaVersion: z.literal(1), tool: z.enum(['pathway_read', 'history_query', 'case_read']), sourceSystem: code,
  scope: z.strictObject({ hospitalCode: code, departmentCodes: z.array(code), departmentBasis: z.enum(['current', 'discharge']), admissionFrom: timestamp, admissionTo: timestamp, includeSharedDefinitions: z.boolean().default(false) }),
  readStartedAt: timestamp, readCompletedAt: timestamp, filters: z.record(z.string(), z.json()),
  collections: z.record(z.string(), z.array(z.record(z.string(), z.json()))),
  measures: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  nextOffset: z.number().int().nullable(), truncated: z.boolean(), coverage: z.array(z.string()),
})
/** Canonical programmatic and logged result returned by all three tools. */
export type ReadResult = z.infer<typeof resultSchema>

/** Fixed-query helpers share trusted scope and never accept model-chosen SQL identifiers. */
import { z } from 'zod'
import type { ReadTransaction } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { QueryLimits, QueryResult, ReadScope, ClinicalSourceRow } from './protocol.ts'

/** Per-call query capability; a transaction is owned by the gateway operation. */
export interface QueryContext {
  tx: ReadTransaction
  scope: ReadScope
  limits: QueryLimits
  signal: AbortSignal
}
/**
 * Read explicit columns selected by package-owned SQL as JSON records.
 * @param ctx - Authorized transaction and cancellation.
 * @param sql - Package-owned fixed SQL returning one `data` JSON column.
 * @param values - Bound values, including JSON-encoded lists where needed.
 * @returns Validated records; driver or malformed source values fail the read.
 */
export async function rows(ctx: QueryContext, sql: string, values: readonly (string | number)[]): Promise<ClinicalSourceRow[]> {
  ctx.signal.throwIfAborted()
  const n = values.length
  const raw = await ctx.tx.query(`WITH dsh_source AS (${sql})
    SELECT CASE WHEN octet_length(data::text)>$${n + 1}::int OR sum(octet_length(data::text)) OVER ()>$${n + 2}::int
      THEN NULL ELSE data END AS data FROM dsh_source LIMIT $${n + 3}::int`,
  [...values, ctx.limits.maxRowBytes, ctx.limits.maxQueryBytes, ctx.limits.maxRows + 1])
  ctx.signal.throwIfAborted()
  const parsed = z.array(z.object({ data: z.record(z.string(), z.json()).nullable() })).safeParse(raw)
  if (!parsed.success) throw new EncounterReadError('source-unavailable', 'The clinical source returned invalid row fields. Check its schema and reader configuration.', { cause: parsed.error })
  const result: ClinicalSourceRow[] = []
  for (const item of parsed.data) {
    if (item.data === null) throw new EncounterReadError('limit-exceeded', 'Source data exceeds the configured read limit. Narrow the requested scope or passage.')
    result.push(item.data)
  }
  return result
}
/**
 * Build the admission scope for a fixed, package-owned table alias.
 * @param ctx - Trusted hospital, department and admission-time grants.
 * @param alias - Literal alias owned by the calling query module.
 * @returns SQL predicate using parameters $1 through $4.
 */
export function admissionScope(ctx: QueryContext, alias: 'p' | 'r'): string {
  const dept = ctx.scope.departmentBasis === 'current' ? 'current_dept_code' : 'out_dept_code'
  return `${alias}.cur_hospital_code=$1 AND ${alias}.is_valid=true AND ${alias}.${dept} IN (SELECT jsonb_array_elements_text($2::jsonb)) AND ${alias}.in_time >= $3::timestamptz AND ${alias}.in_time < $4::timestamptz`
}
/**
 * Bind the scope used by admissionScope.
 * @param ctx - Trusted operation scope.
 * @returns Four bound values, with departments encoded as JSON rather than SQL.
 */
export function scopeValues(ctx: QueryContext): (string | number)[] {
  return [ctx.scope.hospitalCode, JSON.stringify(ctx.scope.departmentCodes), ctx.scope.admissionFrom, ctx.scope.admissionTo]
}
/**
 * Initialize an empty successful result; missing evidence must be described by its caller.
 * @returns Mutable operation-local result used during bounded assembly.
 */
export function emptyResult(): QueryResult {
  return { collections: {}, measures: {}, nextOffset: null, truncated: false, coverage: [] }
}

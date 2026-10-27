/** Authenticated gateway owns database access, current grants and complete response bounds. */
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import type { HostedRuntimeRequest } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { readClinicalRequestBody, writeClinicalReadFailure, type ReadDatabase } from '@deepseek-ai/dsh-experimental-emr-reader-broker'
import type { Config } from './config.ts'
import { caseRequestSchema, historyRequestSchema, pathwayRequestSchema, resultSchema, type QueryLimits, type ReadResult } from './protocol.ts'
import type { PathwayPolicy } from './policy.ts'
import { readPathway } from './pathway-query.ts'
import { readHistory } from './history-query.ts'
import { readCase } from './case-query.ts'
import { verifySource } from './source-check.ts'

const operations = ['pathway_read', 'history_query', 'case_read'] as const
type Operation = typeof operations[number]
function operationAt(url: string | undefined): Operation | undefined {
  const path = url?.split('?')[0]
  return operations.find(operation => path === `/runtime/clinical-pathway/${operation}`)
}
function write(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}
function parseRequest(operation: Operation, body: unknown) {
  try {
    return operation === 'pathway_read' ? pathwayRequestSchema.parse(body)
      : operation === 'history_query' ? historyRequestSchema.parse(body) : caseRequestSchema.parse(body)
  } catch (error) {
    throw new EncounterReadError('invalid-request', 'Pathway filters are invalid. Check identifiers, categories, limits and offset-aware ISO timestamps.', { cause: error })
  }
}

/** Cancels and drains admitted operations before provider disposal. */
export class PathwayGateway {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly limits: QueryLimits
  constructor(private readonly config: Config, private readonly sourceSystem: string,
    private readonly database: ReadDatabase, private readonly policy: PathwayPolicy) {
    this.limits = { maxRows: config.maxRows, maxRowBytes: config.maxRowBytes, maxQueryBytes: config.maxResponseBytes,
      maxTextChars: config.maxTextChars, maxBranchDepth: config.maxBranchDepth, maxBranches: config.maxBranches,
      herbalTables: config.herbalTables, operationTables: config.operationTables, dictionaryTables: config.dictionaryTables,
      allowWritableDevelopmentRole: config.readRolePolicy === 'development-transaction-only' }
  }
  /**
   * Verify schema and read-only privileges before the route is registered.
   * @returns Completion, or a visible deployment configuration failure.
   */
  async validate(): Promise<void> {
    await this.policy.validate()
    await this.database.read(AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)]),
      async (tx) => { await verifySource(tx, this.config.schema, this.limits) })
  }
  /**
   * Serve only the three fixed historical read operations.
   * @param request - Trusted runtime actor, live-login check and request lifetime.
   * @returns Whether this provider owns the path and response.
   */
  async handle(request: HostedRuntimeRequest): Promise<boolean> {
    const operation = operationAt(request.request.url)
    if (operation === undefined) return false
    if (this.pending.size >= this.config.maxConcurrentReads) {
      write(request.response, 429, { error: { code: 'limit-exceeded', message: 'Pathway reads are busy. Retry after the current read completes.' } })
      return true
    }
    const work = this.serve(request, operation)
    this.pending.add(work)
    try { await work } finally { this.pending.delete(work) }
    return true
  }
  private async serve(request: HostedRuntimeRequest, operation: Operation): Promise<void> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)])
    const admit = (): void => {
      if (signal.aborted) throw new EncounterReadError('cancelled', 'Pathway read was cancelled or timed out.')
      if (!request.isActive()) throw new EncounterReadError('forbidden', 'Sign in again before reading pathway data.')
    }
    try {
      admit()
      if (request.request.method !== 'POST' || request.request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        throw new EncounterReadError('invalid-request', 'Use POST with an application/json request.')
      }
      const body = await readClinicalRequestBody(request.request, this.config.maxRequestBytes, signal)
      const args = parseRequest(operation, body)
      if ('from' in args && Date.parse(args.from) >= Date.parse(args.to)) throw new EncounterReadError('invalid-request', 'Choose a nonempty time window with from before to.')
      admit()
      const scope = await this.policy.select(request.actor, args)
      const readStartedAt = new Date().toISOString()
      const data = await this.database.read(signal, async (tx) => {
        const timeZone = await verifySource(tx, this.config.schema, this.limits)
        const query = { tx, scope, limits: this.limits, signal }
        const result = operation === 'pathway_read' ? await readPathway(query, pathwayRequestSchema.parse(args))
          : operation === 'history_query' ? await readHistory(query, historyRequestSchema.parse(args))
            : await readCase(query, caseRequestSchema.parse(args))
        result.coverage.push(`Source connection TimeZone: ${timeZone}; source timestamps without offsets are interpreted in this timezone.`)
        return result
      })
      admit()
      const current = await this.policy.select(request.actor, args)
      if (JSON.stringify(current) !== JSON.stringify(scope)) throw new EncounterReadError('forbidden', 'Historical access changed during the read. Repeat with the current permitted scope.')
      const result: ReadResult = resultSchema.parse({ schemaVersion: 1, tool: operation, sourceSystem: this.sourceSystem,
        scope, readStartedAt, readCompletedAt: new Date().toISOString(), filters: args, ...data,
        coverage: [...data.coverage,
          `Read role policy: ${this.config.readRolePolicy}. Fixed queries always execute in a verified read-only transaction.`,
          'Each call uses its own read-only snapshot. Pages and tools do not share an immutable snapshot.'] })
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxResponseBytes) throw new EncounterReadError('limit-exceeded', 'The complete result exceeds the configured limit. Narrow the cohort, page or passage.')
      admit()
      write(request.response, 200, result)
    } catch (error) {
      const failure = error instanceof EncounterReadError ? error : error instanceof z.ZodError
        ? new EncounterReadError('source-unavailable', 'Pathway source fields are invalid. Check the configured source schema and reader.')
        : new EncounterReadError('source-unavailable', 'Pathway data is unavailable. Check the read-only source configuration and retry.')
      writeClinicalReadFailure(request.response, failure)
    }
  }
  /**
   * Stop admission and await all active reads before disposing dependencies.
   * @returns Gateway quiescence.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }
}

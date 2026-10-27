/** Bounded authenticated runtime requests and expiring one-use clinical launch grants. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { EncounterReadError, bindingSchema, departmentDirectoryRequestSchema, patientDirectoryRequestSchema, grantResultSchema, launchClaimSchema, type EncounterBinding } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { HostedRuntimeRequest } from '@deepseek-ai/dsh-experimental-hosted-workspaces'
import type { Config } from './config.ts'
import { newGrant, type EncounterPolicy } from './policy.ts'
import type { PgEncounterReader } from './reader.ts'
import type { PgEncounterDirectory } from './directory.ts'

const consumeSchema = z.strictObject({ grant: grantResultSchema.shape.grant })
const captureSchema = z.strictObject({ binding: bindingSchema })
interface PendingGrant { actorId: string; expiresAt: number; binding: EncounterBinding }

/** Read one bounded JSON body and release transport listeners on settlement.
 * @param request - Owned HTTP request stream.
 * @param maxBytes - Complete accepted body byte limit.
 * @param signal - Request cancellation or deadline.
 * @returns Parsed untrusted JSON for the owning request schema.
 */
export function readBody(request: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => { request.off('data', data); request.off('end', end); request.off('error', fail); signal.removeEventListener('abort', abort) }
    const fail = (error: Error): void => { cleanup(); request.resume(); reject(error) }
    const abort = (): void => { fail(new EncounterReadError('cancelled', 'Clinical request was cancelled or timed out.')) }
    const data = (chunk: Buffer): void => {
      size += chunk.length
      if (size > maxBytes) { fail(new EncounterReadError('limit-exceeded', 'Clinical request exceeds its configured byte limit.')); return }
      chunks.push(chunk)
    }
    const end = (): void => {
      cleanup()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(new EncounterReadError('invalid-request', 'Send a valid clinical request object.', { cause: error })) }
    }
    request.on('data', data); request.once('end', end); request.once('error', fail)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function write(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** Release a safe clinical read failure using its shared HTTP handling category.
 * @param response - Response owned by the authenticated read operation.
 * @param failure - Safe diagnostic without SQL, source values or credentials.
 */
export function writeClinicalReadFailure(response: ServerResponse, failure: EncounterReadError): void {
  const code = failure.code
  const status = code === 'forbidden' || code === 'invalid-binding' ? 403 : code === 'expired-grant' ? 410
    : code === 'invalid-request' ? 400 : code === 'not-found' ? 404 : code === 'limit-exceeded' ? 413 : code === 'cancelled' ? 408 : 503
  write(response, status, { error: { code, message: failure.message } })
}

/** Owns transport admission, launch grants and request cancellation until plugin disposal. */
export class ClinicalBroker {
  private readonly grants = new Map<string, PendingGrant>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  constructor(
    private readonly config: Config, private readonly policy: EncounterPolicy,
    private readonly reader: PgEncounterReader, private readonly directory: PgEncounterDirectory,
  ) {}
  /**
   * Handle only fixed clinical runtime routes; other plugins may own remaining paths.
   * @param request - Gateway-authenticated actor and current login admission.
   * @returns Whether the broker owns this path and response.
   */
  async handle(request: HostedRuntimeRequest): Promise<boolean> {
    const path = request.request.url?.split('?')[0]
    if (path === undefined || !['/runtime/emr/launch', '/runtime/emr/consume', '/runtime/emr/authorize', '/runtime/emr/capture', '/runtime/emr/departments', '/runtime/emr/patients'].includes(path)) return false
    if (this.pending.size >= this.config.maxConcurrentReads) {
      write(request.response, 429, { error: { code: 'limit-exceeded', message: 'Clinical reads are busy. Retry after the current read completes.' } })
      return true
    }
    const operation = this.serve(request, path)
    this.pending.add(operation)
    try { await operation } finally { this.pending.delete(operation) }
    return true
  }
  private async serve(request: HostedRuntimeRequest, path: string): Promise<void> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    try {
      const admit = (): void => {
        if (signal.aborted) throw new EncounterReadError('cancelled', 'Clinical request was cancelled or timed out.')
        if (!request.isActive()) throw new EncounterReadError('forbidden', 'Sign in again before opening clinical data.')
      }
      admit()
      if (request.request.method !== 'POST' || request.request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new EncounterReadError('invalid-request', 'Use POST with an application/json request.')
      const body = await readBody(request.request, this.config.maxRequestBytes, signal)
      admit()
      let value: unknown
      if (path === '/runtime/emr/launch') {
        const claim = launchClaimSchema.parse(body)
        for (const [key, grant] of this.grants) if (grant.expiresAt <= Date.now()) this.grants.delete(key)
        if (this.grants.size >= this.config.maxPendingGrants) throw new EncounterReadError('limit-exceeded', 'Too many pending encounter launches. Finish or retry after they expire.')
        const binding = await this.reader.resolve(request.actor, claim, signal, request.isActive)
        admit()
        await this.reader.authorize(request.actor, binding, signal, request.isActive)
        if (this.grants.size >= this.config.maxPendingGrants) throw new EncounterReadError('limit-exceeded', 'Too many pending encounter launches. Finish or retry after they expire.')
        const grant = newGrant()
        const expiresAt = Date.now() + this.config.grantTtlMs
        this.grants.set(grant, { actorId: request.actor.id, expiresAt, binding })
        value = { grant, expiresAt: new Date(expiresAt).toISOString() }
      } else if (path === '/runtime/emr/consume') {
        const { grant } = consumeSchema.parse(body)
        const pending = this.grants.get(grant)
        if (!pending || pending.expiresAt <= Date.now()) { this.grants.delete(grant); throw new EncounterReadError('expired-grant', 'Reopen the encounter; this launch grant expired or was already used.') }
        if (pending.actorId !== request.actor.id) throw new EncounterReadError('forbidden', 'This launch grant belongs to another account.')
        this.grants.delete(grant)
        this.policy.verify(request.actor, pending.binding)
        await this.reader.authorize(request.actor, pending.binding, signal, request.isActive)
        value = pending.binding
      } else if (path === '/runtime/emr/authorize') {
        const { binding } = captureSchema.parse(body)
        value = await this.reader.authorize(request.actor, binding, signal, request.isActive)
      } else if (path === '/runtime/emr/departments') {
        departmentDirectoryRequestSchema.parse(body)
        value = await this.directory.departments(request.actor, signal, request.isActive)
      } else if (path === '/runtime/emr/patients') {
        value = await this.directory.patients(request.actor, patientDirectoryRequestSchema.parse(body), signal, request.isActive)
      } else {
        const { binding } = captureSchema.parse(body)
        value = await this.reader.capture(request.actor, binding, signal, request.isActive)
      }
      admit()
      if (Buffer.byteLength(JSON.stringify(value)) > this.config.maxResponseBytes) throw new EncounterReadError('limit-exceeded', 'The complete clinical response exceeds its configured byte limit.')
      write(request.response, 200, value)
    } catch (error) {
      const failure = error instanceof EncounterReadError ? error : error instanceof z.ZodError
        ? new EncounterReadError('invalid-request', 'The clinical request or source fields are invalid.')
        : new EncounterReadError('source-unavailable', 'Clinical data is unavailable. Check the reader configuration and retry.')
      writeClinicalReadFailure(request.response, failure)
    }
  }
  /**
 * Abort active reads and discard unconsumed grants before unloading.
 * @returns Request quiescence.
 */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.grants.clear()
    await Promise.allSettled(this.pending)
  }
}

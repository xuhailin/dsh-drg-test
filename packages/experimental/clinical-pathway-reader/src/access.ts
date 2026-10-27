/** Scoped tools use the server-owned runtime credential without model-visible connection data. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { z } from 'zod'
import type { Config } from './config.ts'
import { resultSchema, type ReadResult } from './protocol.ts'

const failureSchema = z.object({ error: z.object({ code: z.string(), message: z.string().max(2000) }) })

async function waitForCredential<T>(resolution: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = Promise.withResolvers<never>()
  const abort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    // Providers own uncancellable credential resolution. Late settlement never continues this read.
    return await Promise.race([resolution, cancelled.promise])
  } finally { signal.removeEventListener('abort', abort) }
}

/** Bounded client for the fixed authenticated pathway routes. */
export class PathwayAccess {
  private readonly base: URL
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<ReadResult>>()
  constructor(private readonly ctx: Context, private readonly config: Config) {
    if (config.brokerBaseUrl === undefined) throw new Error('clinical-pathway-reader: tools mode requires brokerBaseUrl')
    this.base = new URL(config.brokerBaseUrl)
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash
      || !/^[A-Z_][A-Z0-9_]*$/.test(config.runtimeTokenEnv)) throw new Error('clinical-pathway-reader: configure an HTTP(S) broker without URL credentials and an explicit runtime credential name')
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/'
  }
  /**
   * Execute one fixed read through the current runtime login.
   * @param operation - One of the three declared read tools.
   * @param args - Parsed model filters; no credentials or actor fields.
   * @param signal - Owning tool lifetime.
   * @returns Complete validated canonical evidence or a safe read error.
   */
  async read(operation: ReadResult['tool'], args: object, signal: AbortSignal): Promise<ReadResult> {
    if (this.lifetime.signal.aborted) throw new EncounterReadError('cancelled', 'The pathway reader was unloaded. Start a read from an active pathway analysis session.')
    const work = this.perform(operation, args, signal)
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  private async perform(operation: ReadResult['tool'], args: object, signal: AbortSignal): Promise<ReadResult> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([signal, this.lifetime.signal, deadline])
    let response: Response | undefined
    try {
      combined.throwIfAborted()
      const credentials = this.ctx.get('credentials')
      const token = credentials === undefined ? launchEnvironmentOf(this.ctx).getFrom(this.config.runtimeTokenEnv, ['process'])?.value
        : (await waitForCredential(credentials.resolve(credentialRef(this.config.runtimeTokenEnv)), combined))?.value
      combined.throwIfAborted()
      if (!token) throw new EncounterReadError('forbidden', 'The pathway runtime credential is unavailable. Check its server-side credential configuration.')
      response = await fetch(new URL(operation, this.base), { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', 'x-api-key': token }, body: JSON.stringify(args) })
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body !== null) {
        const reader = response.body.getReader()
        try {
          for (;;) {
            combined.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > this.config.maxResponseBytes) {
              await reader.cancel()
              throw new EncounterReadError('limit-exceeded', 'The complete pathway response exceeds its configured limit. Narrow the query.')
            }
            chunks.push(chunk.value)
          }
        } finally { reader.releaseLock() }
      }
      combined.throwIfAborted()
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!response.ok) {
        const failure = failureSchema.safeParse(value)
        if (failure.success) {
          const code = failure.data.error.code
          if (code === 'forbidden' || code === 'invalid-request' || code === 'not-found' || code === 'limit-exceeded' || code === 'cancelled' || code === 'source-unavailable') {
            throw new EncounterReadError(code, failure.data.error.message)
          }
        }
        throw new EncounterReadError('source-unavailable', 'The pathway reader did not return an accepted result. Check source access and retry.')
      }
      const result = resultSchema.parse(value)
      if (result.tool !== operation) throw new EncounterReadError('source-mismatch', 'The reader returned evidence for a different operation.')
      if (Buffer.byteLength(JSON.stringify([{ type: 'text', text: JSON.stringify(result) }])) > this.config.maxResponseBytes) {
        throw new EncounterReadError('limit-exceeded', 'The complete model-visible result exceeds its configured limit. Narrow the query.')
      }
      return result
    } catch (error) {
      if (combined.aborted && (error === combined.reason || error instanceof Error && error.name === 'AbortError')) {
        if (deadline.aborted && combined.reason === deadline.reason) {
          throw new EncounterReadError('source-unavailable',
            'The pathway read exceeded its configured time limit. Retry with a narrower query or ask the operator to check the source.',
            { cause: error })
        }
        throw new EncounterReadError('cancelled', this.lifetime.signal.aborted && combined.reason === this.lifetime.signal.reason
          ? 'The pathway reader was unloaded. Start a read from an active pathway analysis session.' : 'Pathway read was cancelled.')
      }
      if (error instanceof EncounterReadError) throw error
      throw new EncounterReadError('source-unavailable', 'The pathway reader returned an unavailable or invalid response. Check source access and retry.', { cause: error })
    } finally {
      if (response?.body !== null && response?.body !== undefined && !response.body.locked) {
        await response.body.cancel().catch((error: unknown) => { void error /* The settled body may already be closed. */ })
      }
    }
  }

  /**
   * Stop new reads, cancel transport and credential waits, and drain consumer-owned operations.
   * @returns Completion after no read can publish a result; providers retain ownership of uncancellable credential resolution.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }
}

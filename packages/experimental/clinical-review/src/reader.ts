/** HTTP provider for the replaceable reader; gateway authentication owns the actor identity. */
import { createHash } from 'node:crypto'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { EncounterReader, EncounterReadError, parseBinding, parseLaunchGrantResult, parseSnapshot } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { departmentDirectorySchema, patientDirectorySchema, type DepartmentDirectoryRequest, type DepartmentDirectory,
  type PatientDirectoryRequest, type PatientDirectory } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { ClinicalActor, EncounterBinding, EncounterSnapshot, LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { Config } from './config.ts'
import { ClinicalReviewError } from './error.ts'

/** Launch admission remains independent of evidence-provider replacement. */
export interface ReviewLaunchAccess {
  /** Authorize raw EMR claims and consume their one-use grant.
 * @param claim - Untrusted claims.
 * @param signal - Cancellation.
 * @returns Verified binding.
 */
  authorize(claim: LaunchClaim, signal: AbortSignal): Promise<EncounterBinding>
  /** Verify current account, signed binding and encounter access without source reads.
   * @param binding - Existing owned encounter binding.
   * @param signal - Cancellation.
   * @returns Completion after current authorization succeeds.
   */
  reauthorize(binding: EncounterBinding, signal: AbortSignal): Promise<void>
}

/** Bounded HTTP client; no upstream response diagnostics or credentials enter model output. */
export class BrokerAccess implements ReviewLaunchAccess {
  private readonly base: URL
  /**
 * @param config - Validated private endpoint, credential, identity, and response limits.
 */
  constructor(private readonly ctx: Context, private readonly config: Config) {
    this.base = new URL(config.brokerBaseUrl)
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username !== '' || this.base.password !== ''
      || this.base.search !== '' || this.base.hash !== '' || !/^[A-Z_][A-Z0-9_]*$/.test(config.runtimeTokenEnv) || config.ownerId.length === 0) {
      throw new ClinicalReviewError('invalid-config', 'Configure an HTTP(S) broker base without URL credentials, a runtime token, and its fixed owner.')
    }
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/'
  }

  /**
 * @param claim - Browser claims, still requiring broker authorization.
 * @param signal - Caller cancellation.
 * @returns Broker-verified binding.
 */
  async authorize(claim: LaunchClaim, signal: AbortSignal): Promise<EncounterBinding> {
    const grant = parseLaunchGrantResult(await this.request('launch', claim, signal))
    const binding = parseBinding(await this.request('consume', { grant: grant.grant }, signal))
    this.checkOwner(binding)
    return binding
  }

  /** Recheck access to an unchanged binding independently from evidence capture.
   * @param binding - Existing Session binding.
   * @param signal - Caller cancellation.
   * @returns Completion, or a denied/unavailable authorization failure.
   */
  async reauthorize(binding: EncounterBinding, signal: AbortSignal): Promise<void> {
    this.checkOwner(binding)
    const current = parseBinding(await this.request('authorize', { binding }, signal))
    if (JSON.stringify(current) !== JSON.stringify(binding)) throw new ClinicalReviewError('source-mismatch', 'The encounter binding changed. Reopen the authorized encounter.')
  }

  /** List only departments granted to the currently authenticated runtime account.
   * @param request - Empty directory request; actor and grants come from transport.
   * @param signal - Caller cancellation.
   * @returns Authorized department labels.
   */
  async departments(request: DepartmentDirectoryRequest, signal: AbortSignal): Promise<DepartmentDirectory> {
    return departmentDirectorySchema.parse(await this.request('departments', request, signal))
  }

  /** Read one bounded authorized department patient page without clinical bodies.
   * @param request - Exact department, hospital, source, search and page selection.
   * @param signal - Caller cancellation.
   * @returns Current minimal inpatient page, or an authorization/source failure.
   */
  async patients(request: PatientDirectoryRequest, signal: AbortSignal): Promise<PatientDirectory> {
    return patientDirectorySchema.parse(await this.request('patients', request, signal))
  }

  /** Reauthorize one existing binding and validate its complete evidence response.
 * @param binding - Existing binding.
 * @param signal - Caller cancellation.
 * @returns Fresh authorized evidence.
 */
  async capture(binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot> {
    this.checkOwner(binding)
    const snapshot = parseSnapshot(await this.request('capture', { binding }, signal))
    if (snapshot.bindingId !== binding.bindingId) throw new ClinicalReviewError('source-mismatch', 'The reader returned evidence for another binding.')
    for (const source of snapshot.sources) {
      if (createHash('sha256').update(source.content).digest('hex') !== source.contentDigest) {
        throw new ClinicalReviewError('source-mismatch', 'The reader returned content with an invalid source digest.')
      }
    }
    return snapshot
  }

  private checkOwner(binding: EncounterBinding): void {
    if (binding.actorId !== this.config.ownerId) throw new ClinicalReviewError('forbidden', 'The encounter belongs to another authenticated account.')
  }

  private async token(): Promise<string> {
    const credentials = this.ctx.get('credentials')
    const value = credentials === undefined ? launchEnvironmentOf(this.ctx).getFrom(this.config.runtimeTokenEnv, ['process'])?.value
      : (await credentials.resolve(credentialRef(this.config.runtimeTokenEnv)))?.value
    if (value === undefined || value.length === 0) throw new ClinicalReviewError('missing-credential', 'The runtime encounter credential is unavailable. Check its configured environment reference.')
    return value
  }

  private async request(operation: string, body: object, signal: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(new URL(operation, this.base), {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', 'x-api-key': await this.token() }, body: JSON.stringify(body),
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new EncounterReadError('source-unavailable', 'The encounter reader could not be reached. Retry the review later.', { cause: error })
    }
    try {
      const bytes: Uint8Array[] = []
      let size = 0
      if (response.body !== null) {
        const reader = response.body.getReader()
        try {
          while (true) {
            combined.throwIfAborted()
            const part = await reader.read()
            if (part.done) break
            size += part.value.byteLength
            if (size > this.config.maxResponseBytes) {
              await reader.cancel()
              throw new ClinicalReviewError('limit-exceeded', 'The complete encounter response exceeds the configured limit; no partial snapshot was accepted.')
            }
            bytes.push(part.value)
          }
        } finally { reader.releaseLock() }
      }
      signal.throwIfAborted()
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'forbidden' : 'source-unavailable'
        throw new EncounterReadError(code, code === 'forbidden'
          ? 'The current account is not authorized to read this encounter. Sign in again or request encounter access.'
          : 'The encounter reader did not return an accepted snapshot. Check its availability and retry.')
      }
      const value: unknown = JSON.parse(Buffer.concat(bytes).toString('utf8'))
      return value
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ClinicalReviewError || error instanceof EncounterReadError) throw error
      throw new EncounterReadError('source-unavailable', 'The encounter reader returned an incomplete or invalid response.', { cause: error })
    }
  }
}

/** Provider registration uses the shared EncounterReader interface so MCP can replace capture. */
export class HttpEncounterReader extends EncounterReader {
  /**
 * @param ctx - Provider scope.
 * @param access - HTTP authorization and evidence client.
 */
  constructor(ctx: Context, private readonly access: BrokerAccess) { super(ctx) }
  /**
 * @param actor - Verified binding actor.
 * @param binding - Session-held binding.
 * @param signal - Cancellation.
 * @returns Authorized immutable evidence.
 */
  override capture(actor: ClinicalActor, binding: EncounterBinding, signal: AbortSignal): Promise<EncounterSnapshot> {
    if (actor.id !== binding.actorId || actor.issuer !== binding.actorIssuer || actor.subject !== binding.actorSubject) {
      throw new ClinicalReviewError('forbidden', 'The current reader identity does not match the encounter binding.')
    }
    return this.access.capture(binding, signal)
  }
}

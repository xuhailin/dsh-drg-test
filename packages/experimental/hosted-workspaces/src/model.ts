/** Restricted streaming model access; upstream keys never enter user runtimes. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { z } from 'zod'
import { resolveModel, type Config, type ResolvedModel } from './config.ts'
import type { HostedState, HostedUser } from './state.ts'

const messageRequest = z.object({
  model: z.string(), max_tokens: z.number().int().positive(), stream: z.literal(true),
}).loose()

const responsesRequest = z.object({
  model: z.string(), max_output_tokens: z.number().int().positive(), stream: z.literal(true),
  store: z.literal(false).default(false), background: z.literal(false).optional(),
  previous_response_id: z.never().optional(), conversation: z.never().optional(), prompt: z.never().optional(),
  tools: z.array(z.object({ type: z.literal('function') }).loose()).optional(),
}).loose()

/** Authenticated extension requests expose identity without the reusable runtime credential. */
export type RuntimeRequestHandler = (
  user: Pick<HostedUser, 'id' | 'issuer' | 'subject'>,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
) => Promise<boolean>

/** Stable JSON errors intentionally omit upstream payloads and credentials. */
function reject(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'error', error: { type: code, message: code } }))
}

/** One account's admission window, separate from the credential or model input. */
interface Usage { start: number; count: number; active: number }

function hasUpstreamFile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUpstreamFile)
  if (value === null || typeof value !== 'object') return false
  if ('file_id' in value || ('type' in value && value.type === 'item_reference')) return true
  return Object.values(value).some(hasUpstreamFile)
}

function runtimeCredential(req: IncomingMessage): string | undefined {
  const key = req.headers['x-api-key']
  const authorization = req.headers.authorization
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/iu)?.[1]
  if (key !== undefined && (typeof key !== 'string' || (bearer !== undefined && key !== bearer))) return undefined
  return typeof key === 'string' ? key : bearer
}

/** Bounded per-user request admission and streaming to the configured upstream. */
export class ModelProxy {
  private readonly usage = new Map<string, Usage>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly listeners = new Map<string, Promise<Server>>()
  private readonly route: ResolvedModel
  /**
   * @param config - deployment limits.
   * @param state - account registry.
   * @param upstreamKey - gateway-only key.
   * @param runtimeHandler - optional authenticated extension; must settle when its signal aborts.
   */
  constructor(
    private readonly config: Config,
    private readonly state: HostedState,
    private readonly upstreamKey: string,
    private readonly runtimeHandler?: RuntimeRequestHandler,
  ) { this.route = resolveModel(config) }

  /**
   * Serve model requests on one newly attached private Docker interface.
   * @param host - exact gateway IPv4 allocated by the private Docker network.
   * @returns completion of the interface-specific listener bind; rejects after disposal starts.
   */
  async listenOn(host: string): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error('hosted-workspaces: model proxy is shutting down')
    let listener = this.listeners.get(host)
    if (listener === undefined) {
      listener = new Promise<Server>((resolve, rejectBind) => {
        const server = createServer((req, res) => { void this.handle(req, res) })
        server.on('upgrade', (_req, socket) => { socket.destroy() })
        server.once('error', rejectBind)
        server.listen(this.config.gatewayPort, host, () => {
          server.removeListener('error', rejectBind)
          // A later listener failure closes its interface instead of escaping the process.
          server.on('error', () => { server.closeAllConnections() })
          resolve(server)
        })
      })
      this.listeners.set(host, listener)
      void listener.catch(() => this.listeners.delete(host))
    }
    await listener
  }

  /**
   * Serve one model request using a restricted runtime credential.
   * @param req - raw request, never a browser authentication source.
   * @param res - owned response.
   * @returns settles after streaming or a visible failure.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const task = this.serve(req, res)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.lifetime.signal.aborted) { reject(res, 503, 'model_proxy_unavailable'); return }
    const user = this.state.modelUser(runtimeCredential(req))
    if (user === undefined) { reject(res, 401, 'invalid_runtime_credential'); return }
    const path = req.url?.split('?')[0]
    const runtimeRequest = path?.startsWith('/runtime/') === true
    const modelPath = this.route.protocol === 'openai-responses' ? '/model/v1/responses' : '/model/v1/messages'
    if (!runtimeRequest && (path !== modelPath || req.method !== 'POST')) {
      reject(res, 404, 'unsupported_model_operation'); return
    }
    let admitted: Usage | undefined
    const lifetime = new AbortController()
    const disconnected = () => { lifetime.abort() }
    res.on('close', disconnected)
    const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const abortInput = () => { if (!req.complete) req.destroy() }
    signal.addEventListener('abort', abortInput, { once: true })
    try {
      if (runtimeRequest) {
        const handled = await this.runtimeHandler?.({ id: user.id, issuer: user.issuer, subject: user.subject }, req, res, signal)
        if (handled !== true) reject(res, 404, 'unsupported_runtime_operation')
        return
      }
      const now = Date.now()
      let usage = this.usage.get(user.id)
      if (usage === undefined) {
        usage = { start: now, count: 0, active: 0 }
        this.usage.set(user.id, usage)
      }
      if (now - usage.start >= this.config.rateWindowMs) { usage.start = now; usage.count = 0 }
      if (usage.count >= this.config.maxRequestsPerWindow || usage.active >= this.config.maxConcurrentModelRequests) {
        res.setHeader('retry-after', Math.ceil(this.config.rateWindowMs / 1000))
        reject(res, 429, 'runtime_rate_limit'); return
      }
      usage.count++
      usage.active++
      admitted = usage
      let size = 0
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        signal.throwIfAborted()
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        size += bytes.length
        if (size > this.config.maxModelRequestBytes) {
          req.resume()
          reject(res, 413, 'model_request_too_large'); return
        }
        chunks.push(bytes)
      }
      let raw: unknown
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch (_invalidJson) { reject(res, 400, 'invalid_model_json'); return }
      const parsed = this.route.protocol === 'openai-responses' ? responsesRequest.safeParse(raw) : messageRequest.safeParse(raw)
      if (!parsed.success) { reject(res, 400, 'model_request_not_allowed'); return }
      const outputTokens = this.route.protocol === 'openai-responses' ? parsed.data.max_output_tokens : parsed.data.max_tokens
      if (!this.config.allowedModels.includes(parsed.data.model) || typeof outputTokens !== 'number'
        || outputTokens > this.config.maxOutputTokens || hasUpstreamFile(parsed.data)) {
        reject(res, 400, 'model_request_not_allowed'); return
      }
      const responses = this.route.protocol === 'openai-responses'
      const upstream = await fetch(`${this.route.baseUrl}${responses ? '/responses' : '/v1/messages'}`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...responses
          ? { authorization: `Bearer ${this.upstreamKey}` }
          : { 'x-api-key': this.upstreamKey, 'anthropic-version': '2023-06-01' } },
        body: JSON.stringify(parsed.data),
      })
      if (!upstream.ok || upstream.body === null) {
        await upstream.body?.cancel()
        reject(res, upstream.status === 429 ? 429 : 502, 'model_upstream_failed'); return
      }
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      // DOM and Node disagree on BYOB generic parameters for the same native fetch stream.
      await pipeline(Readable.fromWeb(upstream.body as ReadableStream<Uint8Array>), res, { signal })
    } catch (_requestError) {
      // pipeline closes a failed downstream response before rejecting.
      if (!res.headersSent && !res.destroyed) reject(res, 502, runtimeRequest ? 'runtime_request_failed' : 'model_request_failed')
    } finally {
      res.removeListener('close', disconnected)
      signal.removeEventListener('abort', abortInput)
      if (admitted !== undefined) admitted.active--
    }
  }

  /** Stop admitting work and await aborted upstream requests. @returns quiescent completion. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
    for (const listener of this.listeners.values()) {
      const server = await listener.catch(() => undefined)
      if (server !== undefined) {
        await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
      }
    }
    this.listeners.clear()
  }
}

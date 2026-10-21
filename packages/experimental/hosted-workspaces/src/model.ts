/** Restricted streaming model access; upstream keys never enter user runtimes. */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { HostedState } from './state.ts'

const messageRequest = z.object({
  model: z.string(), max_tokens: z.number().int().positive(), stream: z.literal(true),
}).loose()

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
  if ('type' in value && value.type === 'file' && 'file_id' in value) return true
  return Object.values(value).some(hasUpstreamFile)
}

/** Bounded per-user request admission and streaming to the configured upstream. */
export class ModelProxy {
  private readonly usage = new Map<string, Usage>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly listeners = new Map<string, Promise<Server>>()
  /** @param config - deployment limits. @param state - account registry. @param upstreamKey - gateway-only key. */
  constructor(private readonly config: Config, private readonly state: HostedState, private readonly upstreamKey: string) {}

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
    const token = req.headers['x-api-key']
    const user = this.state.modelUser(typeof token === 'string' ? token : undefined)
    if (user === undefined) { reject(res, 401, 'invalid_runtime_credential'); return }
    // Files are intentionally unavailable: DSH's Messages adapter falls back to inline images.
    if (req.url?.split('?')[0] !== '/model/v1/messages' || req.method !== 'POST') {
      reject(res, 404, 'unsupported_model_operation'); return
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
    const lifetime = new AbortController()
    const disconnected = () => { lifetime.abort() }
    res.on('close', disconnected)
    const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const abortInput = () => { if (!req.complete) req.destroy() }
    signal.addEventListener('abort', abortInput, { once: true })
    try {
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
      const parsed = messageRequest.safeParse(raw)
      if (!parsed.success || !this.config.allowedModels.includes(parsed.data.model)
        || parsed.data.max_tokens > this.config.maxOutputTokens || hasUpstreamFile(parsed.data)) {
        reject(res, 400, 'model_request_not_allowed'); return
      }
      const upstream = await fetch(`${this.config.deepseekBaseUrl.replace(/\/$/u, '')}/v1/messages`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': this.upstreamKey, 'anthropic-version': '2023-06-01' },
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
      if (!res.headersSent && !res.destroyed) reject(res, 502, 'model_request_failed')
    } finally {
      res.removeListener('close', disconnected)
      signal.removeEventListener('abort', abortInput)
      usage.active--
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

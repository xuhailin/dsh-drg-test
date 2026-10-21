/** Streaming HTTP/WebSocket transport to an already authorized user's DSH runtime. */
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex, Transform } from 'node:stream'
import { Socket } from 'node:net'
import { finished } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { createProxyMiddleware, type Plugin } from 'http-proxy-middleware'
import { withLogout } from './pages.ts'

/** Server-selected target and backend-only owner credential. */
export interface RuntimeBinding {
  readonly target: string
  readonly cookie: string
  readonly origin: string
  readonly name: string
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function stripCookies(upstream: IncomingMessage): void {
  Reflect.deleteProperty(upstream.headers, 'set-cookie')
  Reflect.deleteProperty(upstream.headers, 'set-cookie2')
}

/** Two shared proxy instances; decoded HTML is bounded before adding the account control. */
export class WorkspaceProxy {
  private readonly bindings = new WeakMap<IncomingMessage, RuntimeBinding>()
  private readonly closes: Array<() => void> = []
  private readonly transports = new Map<ClientRequest | Socket, Promise<void>>()
  private readonly pending = new Set<Promise<void>>()
  private closed = false
  private readonly streaming
  private readonly index

  /** @param maxIndexResponseBytes - maximum decoded and modified HTML response bytes. */
  constructor(private readonly maxIndexResponseBytes: number) {
    const lifecycle: Plugin = (proxy) => {
      this.closes.push(() => { proxy.close() })
      const outgoing = (request: ClientRequest): void => {
        this.track(request)
        request.once('socket', (socket) => { this.track(socket) })
        if (request.socket !== null) this.track(request.socket)
        request.prependListener('response', stripCookies)
        request.prependListener('upgrade', stripCookies)
      }
      proxy.on('proxyReq', outgoing)
      proxy.on('proxyReqWs', outgoing)
      proxy.on('open', (socket) => { this.track(socket) })
    }
    const common = {
      target: 'http://127.0.0.1', ws: false, xfwd: false,
      router: (req: IncomingMessage) => this.require(req).target,
      plugins: [lifecycle],
    }
    const error = (_error: Error, _req: IncomingMessage, response: ServerResponse | Socket): void => {
      if (response instanceof Socket) response.destroy()
      else this.fail(response, 'Workspace connection failed')
    }
    this.streaming = createProxyMiddleware({ ...common, on: { proxyRes: stripCookies, error } })
    this.index = createProxyMiddleware({ ...common, selfHandleResponse: true, on: {
      proxyRes: (upstream, req, res) => {
        const task = this.indexResponse(upstream, req, res)
        this.pending.add(task)
        void task.finally(() => this.pending.delete(task))
      },
      error,
    } })
  }

  /**
   * Forward an authenticated HTTP request without sending SSO credentials to DSH.
   * @param req - request owned by this gateway.
   * @param res - browser response.
   * @param binding - server-selected owner runtime.
   * @returns proxy admission completion; streaming owns the response thereafter.
   */
  async request(req: IncomingMessage, res: ServerResponse, binding: RuntimeBinding): Promise<void> {
    if (this.closed) throw new Error('hosted-workspaces: workspace proxy is disposed')
    this.track(req.socket)
    this.bind(req, binding)
    const pathname = new URL(req.url as string, binding.origin).pathname
    const task = (pathname === '/' || pathname === '/index.html' ? this.index : this.streaming)(req, res)
    this.pending.add(task)
    try { await task } finally { this.pending.delete(task) }
  }

  /**
   * Forward an authenticated WebSocket upgrade.
   * @param req - upgrade request after identity and Origin validation.
   * @param socket - owned browser connection.
   * @param head - already-read protocol bytes.
   * @param binding - server-selected owner runtime.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, binding: RuntimeBinding): void {
    if (this.closed) { socket.destroy(); return }
    this.bind(req, binding)
    if (!(socket instanceof Socket)) { socket.destroy(); return }
    this.track(socket)
    this.streaming.upgrade(req, socket, head)
  }

  private bind(req: IncomingMessage, binding: RuntimeBinding): void {
    this.bindings.set(req, binding)
    for (const key of Object.keys(req.headers)) {
      if (['authorization', 'cookie', 'proxy-authorization', 'forwarded', 'x-real-ip', 'remote-user'].includes(key)
        || /^(?:x-forwarded-|x-dsh-|x-auth-|x-authenticated-|x-user-|x-remote-|x-original-|x-proxy-|x-identity-)/u.test(key)) {
        Reflect.deleteProperty(req.headers, key)
      }
    }
    req.headers.cookie = binding.cookie
    req.headers.host = new URL(binding.origin).host
  }

  private require(req: IncomingMessage): RuntimeBinding {
    return this.bindings.get(req) as RuntimeBinding
  }

  private headers(upstream: IncomingMessage, res: ServerResponse, decoded: boolean): void {
    for (const [key, value] of Object.entries(upstream.headers)) {
      if (value === undefined || HOP_HEADERS.has(key) || key === 'set-cookie' || key === 'set-cookie2') continue
      if (decoded && ['content-encoding', 'content-length', 'etag', 'content-md5'].includes(key)) continue
      res.setHeader(key, value)
    }
    res.removeHeader('set-cookie')
    res.removeHeader('set-cookie2')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'same-origin')
  }

  private async indexResponse(upstream: IncomingMessage, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let decoder: Transform | undefined
    let forwarded = false
    const closed = (): void => { upstream.destroy(); decoder?.destroy() }
    try {
      stripCookies(upstream)
      if (upstream.statusCode !== 200 || !upstream.headers['content-type']?.includes('text/html') || req.method === 'HEAD') {
        this.headers(upstream, res, false)
        res.writeHead(upstream.statusCode as number)
        upstream.pipe(res)
        forwarded = true
        return
      }
      const encoding = upstream.headers['content-encoding']?.trim().toLowerCase() ?? 'identity'
      switch (encoding) {
        case 'identity': case '': break
        case 'gzip': decoder = createGunzip(); break
        case 'deflate': decoder = createInflate(); break
        case 'br': decoder = createBrotliDecompress(); break
        default:
          this.fail(res, 'Workspace page uses an unsupported content encoding')
          await this.responseFinished(res)
          return
      }
      res.once('close', closed)
      const readable = decoder === undefined ? upstream : upstream.pipe(decoder)
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const raw of readable) {
        // Node HTTP and zlib readers yield Buffer chunks without a text decoder.
        const chunk = raw as Buffer
        bytes += chunk.byteLength
        if (bytes > this.maxIndexResponseBytes) {
          this.fail(res, 'Workspace page exceeds the configured size limit')
          throw new Error('hosted-workspaces: oversized workspace page')
        }
        chunks.push(chunk)
      }
      const binding = this.require(req)
      const output = withLogout(Buffer.concat(chunks, bytes).toString('utf8'), binding.name, req.headers['accept-language'])
      if (Buffer.byteLength(output) > this.maxIndexResponseBytes) {
        this.fail(res, 'Workspace page exceeds the configured size limit')
        await this.responseFinished(res)
        return
      }
      this.headers(upstream, res, true)
      res.setHeader('content-length', Buffer.byteLength(output))
      res.writeHead(200)
      res.end(output)
    } catch (_readError) {
      this.fail(res, 'Workspace page could not be read')
      await this.responseFinished(res)
    } finally {
      res.removeListener('close', closed)
      decoder?.destroy()
      if (!forwarded) upstream.destroy()
    }
  }

  private async responseFinished(res: ServerResponse): Promise<void> {
    try { await finished(res, { cleanup: true }) } catch (_closedResponse) {
      // A disconnected browser has no remaining response bytes to flush.
    }
  }

  private fail(res: ServerResponse, message: string): void {
    if (res.destroyed || res.writableEnded) return
    if (res.headersSent) { res.destroy(); return }
    for (const key of res.getHeaderNames()) res.removeHeader(key)
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(message)
  }

  private track(transport: ClientRequest | Socket): void {
    if (this.transports.has(transport) || transport.closed) return
    const settled = new Promise<void>((resolve) => {
      transport.once('close', () => { this.transports.delete(transport); resolve() })
    })
    this.transports.set(transport, settled)
    if (this.closed) transport.destroy()
  }

  /** Close admission and await all owned HTTP requests, sockets, and index readers. @returns quiescent completion. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const close of this.closes) close()
    do {
      for (const transport of this.transports.keys()) transport.destroy()
      await Promise.allSettled(this.pending)
      await Promise.all(this.transports.values())
    } while (this.pending.size > 0 || this.transports.size > 0)
  }
}

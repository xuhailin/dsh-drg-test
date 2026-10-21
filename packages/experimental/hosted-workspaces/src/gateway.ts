/** Authenticated entry, browser-session lifetime and private workspace routing. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Config, publicOrigin } from './config.ts'
import { DockerRuntimes } from './docker.ts'
import { ModelProxy } from './model.ts'
import { OidcLogin } from './oidc.ts'
import { implicitCallbackPage, page } from './pages.ts'
import { WorkspaceProxy } from './proxy.ts'
import { HostedState, randomCredential, sessionKey, type HostedLogin, type HostedUser } from './state.ts'

/** A short-lived, single-use transition between the portal and a private origin. */
interface Handoff { readonly login: HostedLogin; readonly expiresAt: number; readonly origin: string }

type CallbackBody = { readonly status: 200; readonly parameters: URLSearchParams } | { readonly status: 400 | 408 | 413 }

/**
 * Read a unique opaque cookie; ambiguous duplicate cookies are rejected.
 * @param header - browser Cookie header.
 * @param name - exact gateway cookie name.
 * @returns credential or undefined.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined
}

/** Gateway owns every response and socket admitted through one browser session. */
export class HostedGateway {
  private readonly entry: URL
  private readonly cookieName: string
  private readonly handoffs = new Map<string, Handoff>()
  private readonly connections = new Map<string, Set<ServerResponse | Duplex>>()
  private readonly proxy: WorkspaceProxy
  private readonly userConnections = new Map<string, Set<ServerResponse | Duplex>>()
  private readonly pending = new Set<Promise<void>>()
  private readonly callbackRequests = new Set<IncomingMessage>()
  private closed = false

  /**
   * @param config - validated deployment.
   * @param state - gateway-only records.
   * @param oidc - OIDC flows.
   * @param runtimes - Docker owner.
   * @param model - key-holding proxy.
   */
  constructor(private readonly config: Config, private readonly state: HostedState, private readonly oidc: Pick<OidcLogin, 'begin' | 'finish' | 'dispose'>,
    private readonly runtimes: Pick<DockerRuntimes, 'ensure' | 'dispose'>, private readonly model: ModelProxy) {
    this.entry = publicOrigin(config)
    this.cookieName = this.entry.protocol === 'https:' ? '__Host-dsh-sso' : 'dsh-sso-dev'
    this.proxy = new WorkspaceProxy(config.maxIndexResponseBytes)
  }

  /**
   * Handle a request without allowing client fields to select a runtime.
   * @param req - HTTP request.
   * @param res - owned response.
   * @returns settles after admission or rejection.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const task = this.serve(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) this.html(res, 503, 'failure', req)
      else if (!res.destroyed) res.destroy()
    })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return task
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) { res.writeHead(503); res.end(); return }
    if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200); res.end('ok'); return }
    if (req.url?.startsWith('/model/')) return this.model.handle(req, res)
    const origin = this.requestOrigin(req)
    if (origin === undefined || !req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(421); res.end(); return }
    const url = new URL(req.url, origin)
    const login = this.state.find(readCookie(req.headers.cookie, this.cookieName))
    if (url.pathname.startsWith('/auth/')) return this.auth(req, res, url, origin, login)
    if (origin === this.entry.origin) {
      if (req.method !== 'GET' || url.pathname !== '/') { res.writeHead(404); res.end(); return }
      if (login !== undefined && !url.searchParams.has('signedout')) { this.handoff(res, login); return }
      this.html(res, 200, url.searchParams.has('signedout') ? 'signedOut' : 'entry', req); return
    }
    if (login === undefined) {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        this.redirect(res, `${this.entry.origin}/auth/login?target=${encodeURIComponent(origin)}`); return
      }
      res.writeHead(401); res.end(); return
    }
    if (this.userOrigin(login.user) !== origin) { res.writeHead(403); res.end(); return }
    if (req.headers.origin !== undefined && req.headers.origin !== origin) { res.writeHead(403); res.end(); return }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end(); return }
    if (!this.track(login, res)) { res.writeHead(429); res.end(); return }
    const runtime = await this.runtimes.ensure({ id: login.user.id, modelToken: login.user.modelToken, origin })
    if (this.state.find(login.token) === undefined || res.destroyed) { if (!res.destroyed) { res.writeHead(401); res.end() }; return }
    await this.proxy.request(req, res, { ...runtime, origin, name: login.user.name })
  }

  private async auth(req: IncomingMessage, res: ServerResponse, url: URL, origin: string, login: HostedLogin | undefined): Promise<void> {
    if (url.pathname === '/auth/login' && req.method === 'GET' && origin === this.entry.origin) {
      const target = url.searchParams.get('target') ?? this.entry.origin
      if (!this.allowedOrigin(target)) { res.writeHead(400); res.end(); return }
      if (login !== undefined) {
        if (target !== this.entry.origin && target !== this.userOrigin(login.user)) { res.writeHead(403); res.end(); return }
        this.handoff(res, login); return
      }
      const flow = await this.oidc.begin(target)
      this.cookie(res, `${this.cookieName}-flow`, flow.flowCookie, this.config.flowTtlMs)
      this.redirect(res, flow.authorizationUrl); return
    }
    if (url.pathname === '/auth/callback' && origin === this.entry.origin) {
      const flowCookie = readCookie(req.headers.cookie, `${this.cookieName}-flow`)
      if (this.config.oidcFlow === 'implicit') {
        if (url.search !== '') { this.html(res, 400, 'failure', req); return }
        if (req.method === 'GET') {
          const bridge = implicitCallbackPage(req.headers['accept-language'])
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'none'; script-src 'sha256-${bridge.scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` })
          res.end(bridge.html); return
        }
        if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }); res.end(); return }
        if (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end(); return }
        if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') { res.writeHead(415); res.end(); return }
        if (flowCookie === undefined) { this.cookie(res, `${this.cookieName}-flow`, '', 0); this.html(res, 400, 'failure', req); return }
        if (this.callbackRequests.size >= this.config.maxPendingFlows) { res.writeHead(503, { connection: 'close' }); res.end(); return }
        const body = await this.callbackBody(req)
        if (body.status !== 200) {
          if (!res.destroyed) { res.setHeader('connection', 'close'); this.html(res, body.status, 'failure', req) }
          return
        }
        url.hash = body.parameters.toString()
      } else if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
      this.cookie(res, `${this.cookieName}-flow`, '', 0)
      let completed: Awaited<ReturnType<OidcLogin['finish']>>
      try { completed = await this.oidc.finish(url, flowCookie) }
      catch (_failedLogin) { this.html(res, 400, 'failure', req); return }
      if (this.callbackAbandoned(res)) return
      const user = await this.state.user(completed.identity)
      if (this.callbackAbandoned(res)) return
      if (completed.returnOrigin !== this.entry.origin && completed.returnOrigin !== this.userOrigin(user)) {
        res.writeHead(403); res.end(); return
      }
      const created = await this.state.login(user, this.config.sessionTtlMs)
      if (this.callbackAbandoned(res)) { await this.state.logout(created.token); return }
      this.cookie(res, this.cookieName, created.token, this.config.sessionTtlMs)
      this.handoff(res, created, this.config.oidcFlow === 'implicit' ? req : undefined); return
    }
    if (url.pathname === '/auth/handoff' && req.method === 'GET' && origin !== this.entry.origin) {
      const ticket = url.searchParams.get('ticket') ?? ''
      const saved = this.handoffs.get(ticket)
      this.handoffs.delete(ticket)
      if (saved === undefined || saved.expiresAt <= Date.now() || saved.origin !== origin
        || this.state.find(saved.login.token) === undefined) { res.writeHead(401); res.end(); return }
      this.cookie(res, this.cookieName, saved.login.token, saved.login.expiresAt - Date.now())
      this.html(res, 200, 'handoff', req); return
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      if (req.headers.origin !== origin || login === undefined
        || (origin !== this.entry.origin && origin !== this.userOrigin(login.user))) { res.writeHead(403); res.end(); return }
      await this.state.logout(login.token)
      this.closeLogin(login.token)
      this.cookie(res, this.cookieName, '', 0)
      this.redirect(res, `${this.entry.origin}/?signedout=1`); return
    }
    res.writeHead(404); res.end()
  }

  private callbackAbandoned(res: ServerResponse): boolean {
    if (this.closed) res.destroy()
    return res.destroyed
  }

  private callbackBody(req: IncomingMessage): Promise<CallbackBody> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let bytes = 0
      const finish = (result: CallbackBody): void => {
        clearTimeout(timer)
        req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed)
        this.callbackRequests.delete(req)
        if (result.status !== 200) req.pause()
        resolve(result)
      }
      const data = (chunk: Buffer): void => {
        bytes += chunk.length
        if (bytes > this.config.maxCallbackBytes) finish({ status: 413 })
        else chunks.push(chunk)
      }
      const end = (): void => { finish({ status: 200, parameters: new URLSearchParams(Buffer.concat(chunks).toString('utf8')) }) }
      const failed = (): void => { finish({ status: 400 }) }
      const timer = setTimeout(() => { finish({ status: 408 }) }, this.config.requestTimeoutMs)
      timer.unref()
      this.callbackRequests.add(req)
      req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed)
    })
  }

  /**
   * Admit a WebSocket only for the live browser session's exact private origin.
   * @param req - upgrade request.
   * @param socket - owned connection.
   * @param head - buffered protocol bytes.
   * @returns settles after upgrade admission.
   */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const origin = this.requestOrigin(req)
      const login = this.state.find(readCookie(req.headers.cookie, this.cookieName))
      if (this.closed || origin === undefined || login === undefined || origin !== this.userOrigin(login.user)
        || req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return
      }
      if (!this.track(login, socket)) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return }
      const runtime = await this.runtimes.ensure({ id: login.user.id, modelToken: login.user.modelToken, origin })
      if (this.state.find(login.token) === undefined || socket.destroyed) { socket.destroy(); return }
      this.proxy.upgrade(req, socket, head, { ...runtime, origin, name: login.user.name })
    } catch (_upgradeError) { socket.destroy(new Error('Workspace upgrade failed')) }
  }

  private requestOrigin(req: IncomingMessage): string | undefined {
    if (req.headers.host === undefined) return undefined
    try {
      const url = new URL(`${this.entry.protocol}//${req.headers.host}`)
      return this.allowedOrigin(url.origin) ? url.origin : undefined
    } catch (_invalidAuthority) { return undefined }
  }

  private allowedOrigin(value: string): boolean {
    try {
      const url = new URL(value)
      const prefix = url.hostname.slice(0, -(this.entry.hostname.length + 1))
      return url.origin === value && url.protocol === this.entry.protocol && url.port === this.entry.port
        && (url.hostname === this.entry.hostname || (url.hostname.endsWith(`.${this.entry.hostname}`) && /^u-[a-f0-9]{40}$/u.test(prefix)))
    } catch (_invalidOrigin) { return false }
  }

  private userOrigin(user: HostedUser): string {
    const url = new URL(this.entry)
    url.hostname = `u-${user.id.slice(0, 40)}.${this.entry.hostname}`
    return url.origin
  }

  private handoff(res: ServerResponse, login: HostedLogin, callback?: IncomingMessage): void {
    const now = Date.now()
    for (const [key, value] of this.handoffs) if (value.expiresAt <= now) this.handoffs.delete(key)
    if (this.handoffs.size >= this.config.maxPendingFlows) { res.writeHead(503); res.end(); return }
    const ticket = randomCredential()
    const origin = this.userOrigin(login.user)
    this.handoffs.set(ticket, { login, expiresAt: now + this.config.flowTtlMs, origin })
    const target = `${origin}/auth/handoff?ticket=${encodeURIComponent(ticket)}`
    if (callback === undefined) this.redirect(res, target)
    else this.html(res, 200, 'handoff', callback, target)
  }

  private cookie(res: ServerResponse, name: string, value: string, ttl: number): void {
    const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ttl / 1000))}${this.entry.protocol === 'https:' ? '; Secure' : ''}`
    const existing = res.getHeader('set-cookie')
    res.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : []), cookie])
  }

  private redirect(res: ServerResponse, target: string): void {
    res.writeHead(303, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end()
  }

  private html(res: ServerResponse, status: number, state: 'entry' | 'failure' | 'handoff' | 'signedOut', req: IncomingMessage, handoffTarget?: string): void {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" })
    res.end(page(req.headers['accept-language'], state, this.entry.origin, handoffTarget))
  }

  private track(login: HostedLogin, connection: ServerResponse | Duplex): boolean {
    let owned = this.userConnections.get(login.user.id)
    if (owned === undefined) { owned = new Set(); this.userConnections.set(login.user.id, owned) }
    if (owned.size >= this.config.maxProxyConnectionsPerUser) return false
    owned.add(connection)
    const key = sessionKey(login.token)
    let set = this.connections.get(key)
    if (set === undefined) { set = new Set(); this.connections.set(key, set) }
    set.add(connection)
    const expiry = setTimeout(() => connection.destroy(), Math.max(1, login.expiresAt - Date.now()))
    expiry.unref()
    connection.once('close', () => {
      clearTimeout(expiry); set.delete(connection); owned.delete(connection)
      if (set.size === 0) this.connections.delete(key)
      if (owned.size === 0) this.userConnections.delete(login.user.id)
    })
    return true
  }

  private closeLogin(token: string): void {
    const connections = this.connections.get(sessionKey(token))
    if (connections !== undefined) for (const connection of connections) connection.destroy()
  }

  /** Stop entry and model work, close browser connections, and preserve user containers. @returns quiescent completion. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const request of this.callbackRequests) request.destroy()
    for (const connections of this.connections.values()) for (const connection of connections) connection.destroy()
    this.handoffs.clear()
    await this.oidc.dispose()
    await this.runtimes.dispose()
    await this.model.dispose()
    await Promise.allSettled(this.pending)
    await this.proxy.dispose()
  }
}

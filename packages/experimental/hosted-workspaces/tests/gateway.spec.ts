/** Authorization and connection-lifetime tests through real HTTP and WebSocket transports. */
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { connect } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { HostedGateway, readCookie } from '../src/gateway.ts'
import { ModelProxy } from '../src/model.ts'
import { WorkspaceProxy } from '../src/proxy.ts'
import { HostedState, hostedDomain } from '../src/state.ts'

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function socketText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString()
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString()
  return data.toString()
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing bound server address')
  return address.port
}

async function stop(server: Server) {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
}

function call(port: number, host: string | undefined, path: string, options: {
  method?: string
  cookie?: string
  origin?: string
  headers?: Record<string, string>
} = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, setHost: false, method: options.method ?? 'GET', headers: {
      ...host === undefined ? {} : { host }, ...options.headers, ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function harness(ttlMs = 60000, connectionLimit = 64, overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosted-gateway-'))
  const ctx = new Context()
  const resources: { gateway?: HostedGateway } = {}
  const server = createServer((req, res) => { void resources.gateway?.handle(req, res) })
  const backends: Server[] = []
  const sockets: WebSocket[] = []
  const wsServers: WebSocketServer[] = []
  onTestFinished(async () => {
    for (const socket of sockets) socket.terminate()
    await resources.gateway?.dispose()
    for (const ws of wsServers) {
      for (const client of ws.clients) client.terminate()
      await new Promise<void>((resolve) => { ws.close(() => { resolve() }) })
    }
    await Promise.all([stop(server), ...backends.map(stop)])
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(hostedDomain)
  const state = new HostedState(domain, 10, 100)
  const port = await listen(server)
  const origin = overrides.publicOrigin ?? `http://chat.localhost:${port}`
  const config = Config({ publicOrigin: origin, image: 'test', issuer: 'http://issuer.test', clientId: 'test', deepseekKeyFile: 'unused', gatewayContainer: 'test', allowHttp: true, sessionTtlMs: ttlMs, maxProxyConnectionsPerUser: connectionLimit, ...overrides })
  const targets = new Map<string, string>()
  const forwarded: IncomingHttpHeaders[] = []
  const manager = {
    async ensure(user: { id: string; modelToken: string; origin: string }) {
      let target = targets.get(user.id)
      if (target === undefined) {
        const backend = createServer((req, res) => {
          forwarded.push({ ...req.headers })
          if (req.url === '/') {
            res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'backend-secret=hidden' })
            res.end('<!doctype html><body>DSH workspace</body>')
          } else { res.writeHead(200); res.end(user.id) }
        })
        const ws = new WebSocketServer({ noServer: true })
        wsServers.push(ws)
        backend.on('upgrade', (req, socket, head) => {
          forwarded.push({ ...req.headers })
          ws.handleUpgrade(req, socket, head, (peer) => {
            peer.on('message', (data) => { peer.send(`${user.id}:${socketText(data)}`) })
          })
        })
        backends.push(backend)
        target = `http://127.0.0.1:${await listen(backend)}`
        targets.set(user.id, target)
      }
      return { target, cookie: `dsh-owner=${user.id}`, containerId: user.id }
    },
    async dispose() {},
  }
  const oidc = {
    async begin(returnOrigin: string) { return { authorizationUrl: `https://issuer.test/login?target=${encodeURIComponent(returnOrigin)}`, flowCookie: 'flow-binding' } },
    async finish(url: URL, cookie: string | undefined) {
      if (cookie !== 'flow-binding') throw new Error('invalid flow cookie')
      const subject = url.searchParams.get('user') ?? 'alice'
      return { identity: { issuer: 'http://issuer.test', subject, name: subject }, returnOrigin: url.searchParams.get('target') ?? origin }
    },
    async dispose() {},
  }
  config.gatewayPort = 0
  const model = new ModelProxy(config, state, 'upstream-secret')
  const gateway = new HostedGateway(config, state, oidc, manager, model)
  resources.gateway = gateway
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    void resources.gateway?.upgrade(req, socket, head)
  })
  const cookieName = new URL(origin).protocol === 'https:' ? '__Host-dsh-sso' : 'dsh-sso-dev'
  async function login(user: string, target?: string) {
    const result = await call(port, new URL(origin).host, `/auth/callback?user=${encodeURIComponent(user)}${target === undefined ? '' : `&target=${encodeURIComponent(target)}`}`, { cookie: `${cookieName}-flow=flow-binding` })
    const location = result.headers.location
    if (result.status !== 303 || location === undefined) throw new Error(`unexpected login response ${result.status}`)
    const handoff = new URL(location)
    const response = await call(port, handoff.host, handoff.pathname + handoff.search)
    if (response.status !== 200) throw new Error(`unexpected handoff response ${response.status}`)
    const cookie = response.headers['set-cookie']?.find(value => value.startsWith(`${cookieName}=`))?.split(';')[0]
    if (cookie === undefined) throw new Error('missing private origin cookie')
    return { cookie, origin: handoff.origin, host: handoff.host, ticketUrl: handoff, user: await state.user({ issuer: 'http://issuer.test', subject: user, name: user }) }
  }
  async function socket(account: Awaited<ReturnType<typeof login>>) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { host: account.host, origin: account.origin, cookie: account.cookie } })
    sockets.push(ws)
    await once(ws, 'open')
    return ws
  }
  return { port, origin, gateway, model, manager, state, domain, login, socket, forwarded, targets, config, oidc, server }
}

describe('HostedGateway', () => {
  it('serves health, rejects malformed authority/request targets, and stops new admission after disposal', async () => {
    const h = await harness()
    const host = new URL(h.origin).host
    expect((await call(h.port, host, '/healthz')).body).toBe('ok')
    expect((await call(h.port, host, '/model/v1/messages')).status).toBe(401)
    for (const [authority, path] of [['[', '/'], [host, '//other/path'], [host, 'http://other/path']] as const) {
      expect((await call(h.port, authority, path)).status).toBe(421)
    }
    expect((await call(h.port, host, '/', { method: 'POST' })).status).toBe(404)
    expect((await call(h.port, host, '/missing')).status).toBe(404)
    expect((await call(h.port, host, '/auth/missing')).status).toBe(404)
    const noAuthority = await new Promise<string>((resolve, reject) => {
      const socket = connect(h.port, '127.0.0.1')
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      socket.once('error', reject)
      socket.once('close', () => { resolve(Buffer.concat(chunks).toString()) })
      socket.end('GET / HTTP/1.0\r\n\r\n')
    })
    expect(noAuthority).toContain('421')
    await h.gateway.dispose()
    expect((await call(h.port, host, '/healthz')).status).toBe(503)
  })

  it('redirects anonymous document requests to company login and checks browser request origins', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    for (const path of ['/', '/index.html']) {
      const response = await call(h.port, alice.host, path)
      expect(response.status).toBe(303)
      expect(response.headers.location).toContain('/auth/login?target=')
    }
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie, origin: 'https://wrong.example' })).status).toBe(403)
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  it('ends a cross-origin SSO POST redirect chain before loading the authenticated workspace document', async () => {
    const h = await harness()
    const redirected = { origin: 'http://localhost:8090', headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site', 'accept-language': 'zh-CN' } }
    const callback = await call(h.port, new URL(h.origin).host, '/auth/callback?user=alice', { ...redirected, cookie: 'dsh-sso-dev-flow=flow-binding' })
    expect(callback.status).toBe(303)
    const target = new URL(callback.headers.location ?? '')
    const handoff = await call(h.port, target.host, target.pathname + target.search, redirected)
    expect(handoff.status).toBe(200)
    expect(handoff.headers.location).toBeUndefined()
    expect(handoff.headers['cache-control']).toBe('no-store')
    expect(handoff.headers['referrer-policy']).toBe('no-referrer')
    expect(handoff.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    expect(handoff.body).toContain('<meta http-equiv="refresh" content="0;url=/">')
    expect(handoff.body).toContain('<a href="/">进入工作区</a>')
    expect(handoff.body).not.toContain(target.searchParams.get('ticket'))
    const cookie = handoff.headers['set-cookie']?.find(value => value.startsWith('dsh-sso-dev='))?.split(';')[0]
    if (cookie === undefined) throw new Error('missing private origin cookie')
    const workspace = await call(h.port, target.host, '/', { cookie, headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' } })
    expect(workspace.status).toBe(200)
    expect(workspace.body).toContain('DSH workspace')
    expect((await call(h.port, target.host, '/', { ...redirected, cookie })).status).toBe(403)
    expect((await call(h.port, target.host, '/api/data', { ...redirected, cookie })).status).toBe(403)
    expect((await call(h.port, target.host, target.pathname + target.search, redirected)).status).toBe(401)
  })

  it('reserves login flows only for allowed origins and reuses a live company login', async () => {
    const h = await harness()
    const host = new URL(h.origin).host
    const started = await call(h.port, host, '/auth/login')
    expect(started.status).toBe(303)
    expect(started.headers['set-cookie']?.[0]).toContain('dsh-sso-dev-flow=flow-binding')
    for (const target of ['not a URL', 'https://outside.example', `${h.origin}/path`, `http://wrong.${host}`]) {
      expect((await call(h.port, host, `/auth/login?target=${encodeURIComponent(target)}`)).status).toBe(400)
    }
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    expect((await call(h.port, host, '/', { cookie: alice.cookie })).status).toBe(303)
    expect((await call(h.port, host, '/?signedout=1', { cookie: alice.cookie })).body).toContain('Company sign in')
    expect((await call(h.port, host, `/auth/login?target=${encodeURIComponent(alice.origin)}`, { cookie: alice.cookie })).status).toBe(303)
    expect((await call(h.port, host, `/auth/login?target=${encodeURIComponent(bob.origin)}`, { cookie: alice.cookie })).status).toBe(403)
  })

  it('reports identity-provider failures without creating a browser session', async () => {
    const h = await harness()
    const host = new URL(h.origin).host
    expect((await call(h.port, host, '/auth/callback', { cookie: 'wrong-flow=invalid' })).status).toBe(400)
    const failure = vi.spyOn(h.oidc, 'begin').mockRejectedValueOnce(new Error('provider unavailable'))
    onTestFinished(() => { failure.mockRestore() })
    const response = await call(h.port, host, '/auth/login')
    expect(response.status).toBe(503)
    expect(response.body).not.toContain('provider unavailable')
  })

  it('issues Secure host-only browser cookies and preserves cookies installed by another HTTP layer', async () => {
    const h = await harness(60000, 64, { publicOrigin: 'https://chat.example.test' })
    h.server.prependListener('request', (_req, res) => { res.setHeader('set-cookie', 'other-layer=value; Path=/') })
    const response = await call(h.port, new URL(h.origin).host, '/auth/login')
    expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([
      'other-layer=value; Path=/', expect.stringContaining('__Host-dsh-sso-flow=flow-binding'),
    ]))
    expect(response.headers['set-cookie']?.at(-1)).toContain('; Secure')
    const alice = await h.login('alice')
    expect(alice.cookie).toContain('__Host-dsh-sso=')
  })

  it('expires and bounds one-use handoffs without changing the authenticated identity', async () => {
    const h = await harness(60000, 64, { maxPendingFlows: 1, flowTtlMs: 1000 })
    const alice = await h.login('alice')
    const host = new URL(h.origin).host
    const first = await call(h.port, host, '/', { cookie: alice.cookie })
    expect(first.status).toBe(303)
    expect((await call(h.port, host, '/', { cookie: alice.cookie })).status).toBe(503)
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001)
    onTestFinished(() => { time.mockRestore() })
    const expired = new URL(first.headers.location ?? '')
    expect((await call(h.port, expired.host, expired.pathname + expired.search)).status).toBe(401)
    expect((await call(h.port, alice.host, '/auth/handoff')).status).toBe(401)
    const fresh = await call(h.port, host, '/', { cookie: alice.cookie })
    expect(fresh.status).toBe(303)
    time.mockReturnValue(Date.now() + 1001)
    expect((await call(h.port, host, '/', { cookie: alice.cookie })).status).toBe(303)
  })

  it('rejects a handoff used on a sibling origin or after browser-session revocation', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    const host = new URL(h.origin).host
    const first = await call(h.port, host, '/', { cookie: alice.cookie })
    const ticket = new URL(first.headers.location ?? '')
    expect((await call(h.port, bob.host, ticket.pathname + ticket.search)).status).toBe(401)
    const next = await call(h.port, host, '/', { cookie: alice.cookie })
    await h.state.logout(alice.cookie.slice(alice.cookie.indexOf('=') + 1))
    const revoked = new URL(next.headers.location ?? '')
    expect((await call(h.port, revoked.host, revoked.pathname + revoked.search)).status).toBe(401)
  })

  it('does not proxy a startup that completes after its browser login is revoked', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const entered = deferred()
    const release = deferred()
    const startup = vi.spyOn(h.manager, 'ensure').mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { target: 'http://127.0.0.1:1', cookie: 'unused', containerId: 'unused' }
    })
    onTestFinished(() => { release.resolve(); startup.mockRestore() })
    const response = call(h.port, alice.host, '/api/data', { cookie: alice.cookie })
    await entered.promise
    await h.state.logout(alice.cookie.slice(alice.cookie.indexOf('=') + 1))
    release.resolve()
    expect((await response).status).toBe(401)
  })

  it('contains a failed startup and a proxy failure after response headers', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const startup = vi.spyOn(h.manager, 'ensure').mockRejectedValueOnce(new Error('private Docker detail'))
    onTestFinished(() => { startup.mockRestore() })
    const rejected = await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })
    expect(rejected.status).toBe(503)
    expect(rejected.body).not.toContain('private Docker detail')
    const transport = vi.spyOn(WorkspaceProxy.prototype, 'request').mockImplementationOnce(async (_req, res) => {
      res.writeHead(200)
      res.write('partial')
      throw new Error('transport failed after headers')
    })
    onTestFinished(() => { transport.mockRestore() })
    await expect(call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).rejects.toBeInstanceOf(Error)
  })

  it('contains a startup failure after its browser connection has already closed', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const entered = deferred()
    const release = deferred()
    const disconnected = deferred()
    h.server.prependListener('request', (_req, res) => { res.once('close', () => { disconnected.resolve() }) })
    const startup = vi.spyOn(h.manager, 'ensure').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('startup failed after browser exit')
    })
    onTestFinished(() => { release.resolve(); startup.mockRestore() })
    const browser = request({ host: '127.0.0.1', port: h.port, path: '/api/data', headers: { host: alice.host, cookie: alice.cookie } })
    browser.on('error', () => {})
    try {
      browser.end()
      await entered.promise
      browser.destroy()
      await disconnected.promise
      release.resolve()
      await Promise.allSettled(h.gateway['pending'])
    } finally { browser.destroy(); release.resolve() }
  })

  it('rejects unauthenticated, cross-origin, and over-capacity WebSocket upgrades', async () => {
    const h = await harness(60000, 1)
    const alice = await h.login('alice')
    const headers = { connection: 'Upgrade', upgrade: 'websocket' }
    expect((await call(h.port, alice.host, '/api/remote.mux', { headers })).status).toBe(401)
    expect((await call(h.port, 'untrusted.example', '/api/remote.mux', { headers, cookie: alice.cookie })).status).toBe(401)
    expect((await call(h.port, alice.host, '/api/remote.mux', { headers, cookie: alice.cookie, origin: h.origin })).status).toBe(401)
    expect((await call(h.port, alice.host, '/api/remote.mux', { headers: { ...headers, 'sec-fetch-site': 'cross-site' }, cookie: alice.cookie, origin: alice.origin })).status).toBe(401)
    await h.socket(alice)
    expect((await call(h.port, alice.host, '/api/remote.mux', { headers, cookie: alice.cookie, origin: alice.origin })).status).toBe(429)
    await h.gateway.dispose()
    expect((await call(h.port, alice.host, '/api/remote.mux', { headers, cookie: alice.cookie, origin: alice.origin })).status).toBe(401)
  })

  it('contains a Docker failure while admitting a WebSocket', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const startup = vi.spyOn(h.manager, 'ensure').mockRejectedValueOnce(new Error('private Docker detail'))
    onTestFinished(() => { startup.mockRestore() })
    await expect(call(h.port, alice.host, '/api/remote.mux', {
      headers: { connection: 'Upgrade', upgrade: 'websocket' }, cookie: alice.cookie, origin: alice.origin,
    })).rejects.toBeInstanceOf(Error)
  })

  it('does not admit a WebSocket whose login is revoked during startup', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const entered = deferred()
    const release = deferred()
    const startup = vi.spyOn(h.manager, 'ensure').mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { target: 'http://127.0.0.1:1', cookie: 'unused', containerId: 'unused' }
    })
    onTestFinished(() => { release.resolve(); startup.mockRestore() })
    const connection = expect(h.socket(alice)).rejects.toBeInstanceOf(Error)
    await entered.promise
    await h.state.logout(alice.cookie.slice(alice.cookie.indexOf('=') + 1))
    release.resolve()
    await connection
  })

  it('closes an existing browser stream when its absolute login timer expires', async () => {
    const h = await harness(5000)
    const alice = await h.login('alice')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const browser = await h.socket(alice)
    const closed = once(browser, 'close')
    await vi.advanceTimersByTimeAsync(6000)
    await closed
    expect(browser.readyState).toBe(WebSocket.CLOSED)
  })

  it('logs out a portal session without requiring an open private connection', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    const host = new URL(h.origin).host
    expect((await call(h.port, bob.host, '/auth/logout', { method: 'POST', origin: bob.origin, cookie: alice.cookie })).status).toBe(403)
    expect((await call(h.port, host, '/auth/logout', { method: 'POST', origin: h.origin })).status).toBe(403)
    expect((await call(h.port, host, '/auth/logout', { method: 'POST', origin: h.origin, cookie: alice.cookie })).status).toBe(303)
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).status).toBe(401)
  })

  it('settles held runtime acquisition before disposing its private model listener', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).body).toBe(alice.user.id)
    const reached = deferred()
    const release = deferred()
    const settled = deferred()
    const ensure = h.manager.ensure.bind(h.manager)
    let acquired = false
    h.manager.ensure = async (user) => {
      reached.resolve()
      try {
        await release.promise
        await h.model.listenOn('127.0.0.1')
        acquired = true
        return await ensure(user)
      } finally { settled.resolve() }
    }
    h.manager.dispose = async () => { release.resolve(); await settled.promise }
    const request = call(h.port, alice.host, '/api/data', { cookie: alice.cookie }).then(() => 'completed', () => 'disconnected')
    try {
      await reached.promise
      await h.gateway.dispose()
      expect(await request).toBe('disconnected')
      expect(acquired).toBe(true)
      await expect(h.model.listenOn('127.0.0.1')).rejects.toThrow()
    } finally { release.resolve() }
  })

  it('requires authentication, confines callback and handoff, and proxies only the owning identity', async () => {
    const h = await harness()
    expect((await call(h.port, 'untrusted.example', '/')).status).toBe(421)
    expect((await call(h.port, new URL(h.origin).host, '/')).body).toContain('Company sign in')
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    expect(alice.origin).not.toBe(bob.origin)
    expect((await call(h.port, alice.host, '/api/data')).status).toBe(401)
    expect((await call(h.port, alice.host, '/api/data', { cookie: bob.cookie })).status).toBe(403)
    expect((await call(h.port, bob.host, '/api/data', { cookie: bob.cookie })).body).toBe(bob.user.id)
    const html = await call(h.port, alice.host, '/', { cookie: alice.cookie })
    expect(html.status).toBe(200)
    expect(html.body).toContain('/auth/logout')
    expect(html.headers['set-cookie']).toBeUndefined()
    expect(h.forwarded.at(-1)?.cookie).toBe(`dsh-owner=${alice.user.id}`)
    expect(h.forwarded.at(-1)?.cookie).not.toContain(alice.cookie)
    expect((await call(h.port, alice.host, alice.ticketUrl.pathname + alice.ticketUrl.search)).status).toBe(401)
  })

  it('rejects a callback targeting another origin without creating a browser login', async () => {
    const h = await harness()
    const target = `http://u-${'b'.repeat(40)}.${new URL(h.origin).host}`
    const denied = await call(h.port, new URL(h.origin).host, `/auth/callback?user=alice&target=${encodeURIComponent(target)}`, { cookie: 'dsh-sso-dev-flow=flow-binding' })
    expect(denied.status).toBe(403)
    expect([...h.domain.table('sessions').entries()]).toEqual([])
  })

  it.each([
    ['en-US', 'Signed out. Background tasks and private files are retained.', 'Company sign in'],
    ['zh-CN', '已退出登录。后台任务和私有文件予以保留。', '公司账号登录'],
  ])('shows retained work and a direct company sign-in action after logout (%s)', async (locale, message, action) => {
    const h = await harness()
    const alice = await h.login('alice')
    const logout = await call(h.port, alice.host, '/auth/logout', { method: 'POST', cookie: alice.cookie, origin: alice.origin })
    expect(logout.status).toBe(303)
    const landing = new URL(logout.headers.location ?? '')
    expect(landing.origin).toBe(h.origin)
    expect(landing.searchParams.get('signedout')).toBe('1')
    const response = await call(h.port, landing.host, landing.pathname + landing.search, { cookie: alice.cookie, headers: { 'accept-language': locale } })
    expect(response.status).toBe(200)
    expect(response.body).toContain(message)
    expect(response.body).toContain(`<a href="/auth/login">${action}</a>`)
    expect(response.headers.location).toBeUndefined()
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).status).toBe(401)
  })

  it('revokes only the selected browser login and its open WebSocket after same-origin logout', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    const a = await h.socket(alice)
    const b = await h.socket(bob)
    expect((await call(h.port, alice.host, '/auth/logout', { method: 'POST', cookie: alice.cookie, origin: bob.origin })).status).toBe(403)
    const closed = once(a, 'close')
    expect((await call(h.port, alice.host, '/auth/logout', { method: 'POST', cookie: alice.cookie, origin: alice.origin })).status).toBe(303)
    await closed
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).status).toBe(401)
    const reply = once(b, 'message')
    b.send('still connected')
    expect(String((await reply)[0])).toBe(`${bob.user.id}:still connected`)
    expect((await call(h.port, bob.host, '/api/data', { cookie: bob.cookie })).body).toBe(bob.user.id)
  })

  it('bounds persistent connections per user without consuming another user capacity', async () => {
    const h = await harness(60000, 1)
    const alice = await h.login('alice')
    const bob = await h.login('bob')
    await h.socket(alice)
    expect((await call(h.port, alice.host, '/api/data', { cookie: alice.cookie })).status).toBe(429)
    expect((await call(h.port, bob.host, '/api/data', { cookie: bob.cookie })).status).toBe(200)
  })

  it('rejects ambiguous cookie names instead of accepting a sibling-domain shadow cookie', () => {
    expect(readCookie('dsh=one; dsh=two', 'dsh')).toBeUndefined()
    expect(readCookie('other=one; dsh=two', 'dsh')).toBe('two')
    expect(readCookie(undefined, 'dsh')).toBeUndefined()
  })
})

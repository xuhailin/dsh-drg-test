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
import { DockerRuntimeError } from '../src/docker.ts'
import { HostedGateway, readCookie } from '../src/gateway.ts'
import { OidcLoginError } from '../src/oidc.ts'
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
  body?: string | Buffer
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
    req.end(options.body)
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
      const parameters = url.hash ? new URLSearchParams(url.hash.slice(1)) : url.searchParams
      const subject = parameters.get('user') ?? 'alice'
      return { identity: { issuer: 'http://issuer.test', subject, name: subject }, returnOrigin: parameters.get('target') ?? origin }
    },
    async dispose() {},
  }
  config.gatewayPort = 0
  const model = new ModelProxy(config, state, 'upstream-secret')
  const failures = vi.fn()
  const gateway = new HostedGateway(config, state, oidc, manager, model, failures)
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
  return { port, origin, gateway, model, manager, state, domain, login, socket, forwarded, targets, config, oidc, server, failures }
}

describe('HostedGateway', () => {
  it('starts company sign-in automatically and leaves an explicit logout page without restarting login', async () => {
    const h = await harness()
    const begin = vi.spyOn(h.oidc, 'begin')
    onTestFinished(() => { begin.mockRestore() })
    const response = await call(h.port, new URL(h.origin).host, '/')
    expect(response.status).toBe(303)
    expect(response.headers.location).toBe(`https://issuer.test/login?target=${encodeURIComponent(h.origin)}`)
    expect(response.headers['set-cookie']?.[0]).toContain('dsh-sso-dev-flow=flow-binding')
    expect(begin).toHaveBeenCalledWith(h.origin)
    const loggedOut = await call(h.port, new URL(h.origin).host, '/?signedout=1')
    expect(loggedOut.status).toBe(200)
    expect(loggedOut.headers.location).toBeUndefined()
    expect(begin).toHaveBeenCalledOnce()
  })

  it('opens the verified account after an expired cookie on an old private document URL', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    const staleHost = `u-${'5'.repeat(40)}.${new URL(h.origin).host}`
    const oldPage = await call(h.port, staleHost, '/', { cookie: 'dsh-sso-dev=expired-demo-cookie' })
    expect(oldPage.status).toBe(303)
    expect(oldPage.headers.location).toBe(`${h.origin}/auth/login`)
    expect(oldPage.headers.location).not.toContain(staleHost)
    const portal = await call(h.port, new URL(h.origin).host, '/auth/login', { cookie: alice.cookie })
    expect(new URL(portal.headers.location ?? '').origin).toBe(alice.origin)
    expect((await call(h.port, staleHost, '/api/data', { cookie: alice.cookie })).status).toBe(403)
    expect((await call(h.port, staleHost, '/api/data')).status).toBe(401)
  })

  it('allows an empty implicit callback to resume a live login without bypassing new fragment validation', async () => {
    const h = await harness()
    const alice = await h.login('alice')
    h.config.oidcFlow = 'implicit'
    const callback = await call(h.port, new URL(h.origin).host, '/auth/callback', { cookie: alice.cookie })
    expect(callback.status).toBe(200)
    expect(callback.body).toContain('data-signed-in="true"')
    expect(callback.headers.location).toBeUndefined()
    expect(callback.body).toContain('location.replace')
  })

  it('separates login and workspace failures and reports only safe operation codes', async () => {
    const h = await harness()
    const host = new URL(h.origin).host
    const provider = vi.spyOn(h.oidc, 'begin').mockRejectedValueOnce(new OidcLoginError('discovery', 'private provider credential'))
    onTestFinished(() => { provider.mockRestore() })
    const login = await call(h.port, host, '/', { headers: { 'accept-language': 'zh-CN' } })
    expect(login.status).toBe(503)
    expect(login.body).toContain('登录未完成')
    expect(login.body).not.toContain('private provider credential')
    expect(h.failures).toHaveBeenLastCalledWith('login', 'discovery')
    const alice = await h.login('alice')
    const docker = vi.spyOn(h.manager, 'ensure').mockRejectedValueOnce(new DockerRuntimeError('startup_failed'))
    onTestFinished(() => { docker.mockRestore() })
    const workspace = await call(h.port, alice.host, '/', { cookie: alice.cookie, headers: { 'accept-language': 'zh-CN' } })
    expect(workspace.status).toBe(503)
    expect(workspace.body).toContain('暂时无法打开工作区')
    expect(workspace.body).not.toContain('startup_failed')
    expect(workspace.body).toContain(`href="${h.origin}"`)
    expect(h.failures).toHaveBeenLastCalledWith('workspace', 'startup_failed')
  })

  it('provides safe default operator diagnostics when a caller does not inject a reporter', async () => {
    const h = await harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = vi.spyOn(h.oidc, 'begin').mockRejectedValueOnce(new Error('credential-must-not-be-logged'))
    onTestFinished(() => { warn.mockRestore(); provider.mockRestore() })
    const gateway = new HostedGateway(h.config, h.state, h.oidc, h.manager, h.model)
    const server = createServer((req, res) => { void gateway.handle(req, res) })
    onTestFinished(async () => { await gateway.dispose(); await stop(server) })
    const port = await listen(server)
    expect((await call(port, new URL(h.origin).host, '/')).status).toBe(503)
    expect(warn).toHaveBeenCalledWith('hosted-workspaces: login failed (unexpected)')
  })

  it('bridges an implicit fragment using a hash-pinned script before creating a verified browser session', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit' })
    const host = new URL(h.origin).host
    const finish = vi.spyOn(h.oidc, 'finish')
    onTestFinished(() => { finish.mockRestore() })
    const bridge = await call(h.port, host, '/auth/callback', { cookie: 'dsh-sso-dev-flow=flow-binding', headers: { 'accept-language': 'zh-CN' } })
    expect(bridge.status).toBe(200)
    expect(bridge.headers['cache-control']).toBe('no-store')
    expect(bridge.headers['referrer-policy']).toBe('same-origin')
    expect(bridge.headers['content-security-policy']).toMatch(/script-src 'sha256-[^']+';.*form-action 'self'/u)
    expect(bridge.body).toContain('正在验证登录')
    expect(bridge.headers['set-cookie']).toBeUndefined()
    expect(finish).not.toHaveBeenCalled()
    const callback = await call(h.port, host, '/auth/callback', {
      method: 'POST', cookie: 'dsh-sso-dev-flow=flow-binding', origin: h.origin,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'sec-fetch-site': 'same-origin' },
      body: 'id_token=private-token&state=state&user=alice',
    })
    expect(callback.status).toBe(200)
    expect(callback.headers.location).toBeUndefined()
    expect(callback.headers['content-security-policy']).toContain("form-action 'none'")
    expect(callback.body).not.toContain('private-token')
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]?.[0].search).toBe('')
    expect(finish.mock.calls[0]?.[0].hash).toContain('id_token=private-token')
    expect(finish.mock.calls[0]?.[1]).toBe('flow-binding')
    expect(callback.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    const handoff = new URL(callback.body.match(/<a href="([^"]+)"/u)?.[1] ?? '')
    expect(callback.body).toContain(`<meta http-equiv="refresh" content="0;url=${handoff.href}">`)
    const landed = await call(h.port, handoff.host, handoff.pathname + handoff.search)
    expect(landed.status).toBe(200)
    const cookie = landed.headers['set-cookie']?.find(value => value.startsWith('dsh-sso-dev='))?.split(';')[0]
    if (cookie === undefined) throw new Error('missing private origin cookie')
    expect((await call(h.port, handoff.host, '/', { cookie })).status).toBe(200)
  })

  it('rejects implicit query tokens, foreign POST origins, wrong methods and content types before login validation', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit' })
    const host = new URL(h.origin).host
    const finish = vi.spyOn(h.oidc, 'finish')
    onTestFinished(() => { finish.mockRestore() })
    expect((await call(h.port, host, '/auth/callback?id_token=untrusted')).status).toBe(400)
    expect((await call(h.port, host, '/auth/callback', { method: 'PUT' })).status).toBe(405)
    for (const origin of [undefined, 'null', 'https://attacker.test']) {
      expect((await call(h.port, host, '/auth/callback', { method: 'POST', ...origin === undefined ? {} : { origin } })).status).toBe(403)
    }
    expect((await call(h.port, host, '/auth/callback', { method: 'POST', origin: h.origin, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    for (const contentType of [undefined, 'application/json', 'text/plain']) {
      expect((await call(h.port, host, '/auth/callback', { method: 'POST', origin: h.origin, headers: contentType === undefined ? {} : { 'content-type': contentType } })).status).toBe(415)
    }
    expect(finish).not.toHaveBeenCalled()
    expect([...h.domain.table('sessions').entries()]).toEqual([])
    const invalid = await call(h.port, host, '/auth/callback', { method: 'POST', origin: h.origin, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'state=invalid' })
    expect(invalid.status).toBe(400)
    expect(invalid.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    const code = await harness()
    expect((await call(code.port, new URL(code.origin).host, '/auth/callback', { method: 'POST' })).status).toBe(405)
  })

  it('counts streamed implicit callback bytes and rejects an oversized body without creating a session', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit', maxCallbackBytes: 10 })
    const finish = vi.spyOn(h.oidc, 'finish')
    onTestFinished(() => { finish.mockRestore() })
    const response = await call(h.port, new URL(h.origin).host, '/auth/callback', {
      method: 'POST', origin: h.origin, cookie: 'dsh-sso-dev-flow=flow-binding', headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' }, body: 'state=医医生',
    })
    expect(response.status).toBe(413)
    expect(response.headers.connection).toBe('close')
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(finish).not.toHaveBeenCalled()
    expect([...h.domain.table('sessions').entries()]).toEqual([])
  })

  it('bounds an unfinished callback and cancels its body reader during gateway disposal', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit', requestTimeoutMs: 25 })
    const headers = { host: new URL(h.origin).host, origin: h.origin, cookie: 'dsh-sso-dev-flow=flow-binding', 'content-type': 'application/x-www-form-urlencoded' }
    const timedOut = new Promise<number | undefined>((resolve, reject) => {
      const browser = request({ host: '127.0.0.1', port: h.port, path: '/auth/callback', method: 'POST', headers }, (res) => { res.resume(); res.once('end', () => { resolve(res.statusCode) }) })
      onTestFinished(() => { browser.destroy() })
      browser.once('error', reject)
      browser.write('state=')
    })
    expect(await timedOut).toBe(408)
    h.config.requestTimeoutMs = 60000
    const reading = deferred()
    h.server.on('request', () => { reading.resolve() })
    const browser = request({ host: '127.0.0.1', port: h.port, path: '/auth/callback', method: 'POST', headers })
    onTestFinished(() => { browser.destroy() })
    const closed = new Promise<void>((resolve) => { browser.on('error', () => {}); browser.once('close', resolve) })
    browser.write('state=')
    await reading.promise
    await h.gateway.dispose()
    await closed
    expect([...h.domain.table('sessions').entries()]).toEqual([])
  })

  it('settles a callback after the browser disconnects during its body upload', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit' })
    const entered = deferred()
    const serverClosed = deferred()
    h.server.on('request', (req, res) => { req.once('data', () => { entered.resolve() }); res.once('close', () => { serverClosed.resolve() }) })
    const browser = request({ host: '127.0.0.1', port: h.port, path: '/auth/callback', method: 'POST', headers: {
      host: new URL(h.origin).host, origin: h.origin, cookie: 'dsh-sso-dev-flow=flow-binding', 'content-type': 'application/x-www-form-urlencoded',
    } })
    browser.on('error', () => {})
    onTestFinished(() => { browser.destroy() })
    browser.write('state=')
    await entered.promise
    browser.destroy()
    await serverClosed.promise
    await Promise.allSettled(h.gateway['pending'])
    expect([...h.domain.table('sessions').entries()]).toEqual([])
  })

  it.each(['identity', 'user', 'login'] as const)('abandons %s completion after a callback browser disconnects or the gateway stops', async (stage) => {
    for (const dispose of [false, true]) {
      const h = await harness()
      const entered = deferred()
      const release = deferred()
      onTestFinished(() => { release.resolve() })
      if (stage === 'identity') {
        const original = h.oidc.finish.bind(h.oidc)
        const spy = vi.spyOn(h.oidc, 'finish').mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result })
        onTestFinished(() => { spy.mockRestore() })
      } else if (stage === 'user') {
        const original = h.state.user.bind(h.state)
        const spy = vi.spyOn(h.state, 'user').mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result })
        onTestFinished(() => { spy.mockRestore() })
      } else {
        const original = h.state.login.bind(h.state)
        const spy = vi.spyOn(h.state, 'login').mockImplementation(async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result })
        onTestFinished(() => { spy.mockRestore() })
      }
      const serverClosed = deferred()
      h.server.on('request', (_req, res) => { res.once('close', () => { serverClosed.resolve() }) })
      const browser = request({ host: '127.0.0.1', port: h.port, path: '/auth/callback?user=alice', headers: { host: new URL(h.origin).host, cookie: 'dsh-sso-dev-flow=flow-binding' } })
      browser.on('error', () => {})
      onTestFinished(() => { browser.destroy() })
      browser.end()
      await entered.promise
      if (dispose) {
        const disposing = h.gateway.dispose()
        release.resolve()
        await disposing
      } else {
        browser.destroy()
        await serverClosed.promise
        release.resolve()
        await Promise.allSettled(h.gateway['pending'])
      }
      expect([...h.domain.table('sessions').entries()]).toEqual([])
      expect(h.gateway['handoffs'].size).toBe(0)
    }
  })

  it('bounds concurrent callback readers and releases capacity when an upload completes', async () => {
    const h = await harness(60000, 64, { oidcFlow: 'implicit', maxPendingFlows: 1 })
    const entered = deferred()
    h.server.on('request', (req) => { req.once('data', () => { entered.resolve() }) })
    const host = new URL(h.origin).host
    const headers = { host, origin: h.origin, cookie: 'dsh-sso-dev-flow=flow-binding', 'content-type': 'application/x-www-form-urlencoded' }
    const browser = request({ host: '127.0.0.1', port: h.port, path: '/auth/callback', method: 'POST', headers })
    browser.on('error', () => {})
    onTestFinished(() => { browser.destroy() })
    const complete = new Promise<string>((resolve) => { browser.on('response', (res) => { const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => { chunks.push(chunk) }); res.once('end', () => { resolve(Buffer.concat(chunks).toString()) }) }) })
    browser.write('state=')
    await entered.promise
    expect((await call(h.port, host, '/auth/callback', { method: 'POST', origin: h.origin, headers, body: 'state=another' })).status).toBe(503)
    browser.end('bound')
    const handoff = new URL((await complete).match(/<a href="([^"]+)"/u)?.[1] ?? '')
    expect((await call(h.port, handoff.host, handoff.pathname + handoff.search)).status).toBe(200)
    expect((await call(h.port, host, '/auth/callback', { method: 'POST', origin: h.origin, headers, body: 'state=again' })).status).toBe(200)
  })

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
      expect(response.headers.location).toBe(`${h.origin}/auth/login`)
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
    expect((await call(h.port, new URL(h.origin).host, '/')).status).toBe(303)
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
    ['en-US', 'Background tasks and private files are retained.', 'Company sign in'],
    ['zh-CN', '后台任务和私有文件予以保留', '公司账号登录'],
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

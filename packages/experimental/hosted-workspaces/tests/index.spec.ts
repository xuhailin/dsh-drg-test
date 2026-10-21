/** Plugin activation owns real HTTP routes and storage; external OIDC and Docker are fixture adapters. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { WebSocket, WebSocketServer } from 'ws'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DockerRuntime, DockerRuntimeDependencies, DockerRuntimeOptions, DockerRuntimeUser } from '../src/docker.ts'
import type { OidcLogin, OidcLoginOptions } from '../src/oidc.ts'
import { Config } from '../src/config.ts'
import { ModelProxy } from '../src/model.ts'
import * as Hosted from '../src/index.ts'

const external = vi.hoisted(() => ({
  createOidc: vi.fn<(options: OidcLoginOptions) => Promise<Pick<OidcLogin, 'begin' | 'finish' | 'dispose'>>>(),
  begin: vi.fn<OidcLogin['begin']>(),
  finish: vi.fn<OidcLogin['finish']>(),
  oidcClosed: vi.fn<OidcLogin['dispose']>(),
  networkReady: vi.fn<(host: string) => Promise<void>>(),
  ensure: vi.fn<(user: DockerRuntimeUser) => Promise<DockerRuntime>>(),
  dockerClosed: vi.fn<() => Promise<void>>(),
}))

vi.mock('../src/oidc.ts', () => ({ OidcLogin: { create: external.createOidc } }))
vi.mock('../src/docker.ts', () => ({
  DockerRuntimes: class {
    constructor(_options: DockerRuntimeOptions, dependencies: DockerRuntimeDependencies) {
      external.networkReady.mockImplementation(dependencies.onNetwork ?? (async () => {}))
    }
    async ensure(user: DockerRuntimeUser): Promise<DockerRuntime> {
      await external.networkReady('127.0.0.2')
      return external.ensure(user)
    }
    async dispose(): Promise<void> { await external.dockerClosed() }
  },
}))

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture failed to bind TCP')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  server.closeAllConnections()
  await closed
}

function call(target: string, origin: string, path: string, options: { cookie?: string; credential?: string; body?: object } = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(`${target}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        host: new URL(origin).host,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.credential === undefined ? {} : { 'x-api-key': options.credential }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosted-entry-'))
  const ctx = new Context()
  const servers: Server[] = []
  const clients: WebSocket[] = []
  const sockets = new WebSocketServer({ noServer: true })
  onTestFinished(async () => {
    for (const client of clients) client.terminate()
    for (const client of sockets.clients) client.terminate()
    await ctx.fiber.dispose()
    await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
    await Promise.all(servers.map(close))
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  const keyFile = join(root, 'model-key')
  const clientSecretFile = join(root, 'oidc-secret')
  await writeFile(keyFile, '  synthetic-upstream-key\n', { mode: 0o600 })
  await writeFile(clientSecretFile, '  synthetic-oidc-secret\n', { mode: 0o600 })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const target = ctx.webServer.getOrigin()
  const origin = `http://chat.localhost:${ctx.webServer.port}`
  const backend = createServer((_req, res) => { res.writeHead(200); res.end('private runtime response') })
  backend.on('upgrade', (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head, (client) => { client.send('private runtime ready') })
  })
  servers.push(backend)
  const runtimeTarget = await listen(backend)
  const upstream = createServer((req, res) => {
    if (req.headers['x-api-key'] !== 'synthetic-upstream-key') { res.writeHead(401); res.end(); return }
    req.resume()
    req.once('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
  })
  servers.push(upstream)
  const upstreamOrigin = await listen(upstream)
  const config = Config({
    publicOrigin: origin, image: 'fixture/runtime', issuer: 'http://identity.test', clientId: 'fixture-client',
    deepseekKeyFile: keyFile, deepseekBaseUrl: `${upstreamOrigin}/anthropic`, allowedModels: ['fixture-model'],
    gatewayContainer: 'fixture-gateway', allowHttp: true,
  })
  external.finish.mockResolvedValue({ identity: { issuer: config.issuer, subject: 'doctor', name: 'Doctor' }, returnOrigin: origin })
  external.ensure.mockResolvedValue({ target: runtimeTarget, cookie: 'dsh-auth-fixture=backend-only', containerId: 'fixture-runtime' })
  const listener = vi.spyOn(ModelProxy.prototype, 'listenOn').mockResolvedValue(undefined)
  return { root, ctx, keyFile, clientSecretFile, config, target, origin, clients, listener }
}

beforeEach(() => {
  vi.resetAllMocks()
  external.createOidc.mockResolvedValue({ begin: external.begin, finish: external.finish, dispose: external.oidcClosed })
  external.begin.mockResolvedValue({ authorizationUrl: 'http://identity.test/authorize', flowCookie: 'synthetic-flow' })
  external.oidcClosed.mockResolvedValue(undefined)
  external.dockerClosed.mockResolvedValue(undefined)
})

describe('hosted workspace profile activation', () => {
  it('serves login, authenticated HTTP and WebSocket routes, then removes them and releases storage on unload', async () => {
    const world = await harness()
    world.config.clientSecretFile = world.clientSecretFile
    world.config.discoveryUrl = 'http://internal-identity.test/.well-known/openid-configuration'
    const mounted = await world.ctx.plugin(Hosted, world.config)
    const entry = await call(world.target, world.origin, '/')
    expect(entry.status).toBe(200)
    expect(entry.body).toContain('Company sign in')
    const beginning = await call(world.target, world.origin, '/auth/login')
    expect(beginning.status).toBe(303)
    expect(beginning.headers.location).toBe('http://identity.test/authorize')
    const callback = await call(world.target, world.origin, '/auth/callback?code=fixture')
    expect(callback.status).toBe(303)
    expect(external.createOidc.mock.calls[0]?.[0]).toMatchObject({ flow: 'authorization-code', clientSecret: 'synthetic-oidc-secret' })
    const cookie = callback.headers['set-cookie']?.find(value => value.startsWith('dsh-sso-dev='))?.split(';', 1)[0]
    if (cookie === undefined || callback.headers.location === undefined) throw new Error('Login did not publish its browser handoff')
    const privateUrl = new URL(callback.headers.location)
    const handoff = await call(world.target, privateUrl.origin, `${privateUrl.pathname}${privateUrl.search}`)
    expect(handoff.status).toBe(200)
    expect(handoff.headers.location).toBeUndefined()
    expect(handoff.body).toContain('<meta http-equiv="refresh" content="0;url=/">')
    const privateResponse = await call(world.target, privateUrl.origin, '/api/fixture', { cookie })
    expect(privateResponse.status).toBe(200)
    expect(privateResponse.body).toBe('private runtime response')
    expect(world.listener).toHaveBeenCalledWith('127.0.0.2')
    const modelToken = external.ensure.mock.calls[0]?.[0].modelToken
    if (modelToken === undefined) throw new Error('Runtime did not receive its scoped credential')
    const model = await call(world.target, world.origin, '/model/v1/messages', {
      credential: modelToken, body: { model: 'fixture-model', max_tokens: 1, stream: true, messages: [] },
    })
    expect(model.status).toBe(200)
    expect(model.body).toContain('message_stop')
    expect(model.body).not.toContain('synthetic-upstream-key')
    const websocket = new WebSocket(`${world.target.replace('http:', 'ws:')}/api/remote.mux`, {
      headers: { host: privateUrl.host, origin: privateUrl.origin, cookie },
    })
    world.clients.push(websocket)
    const message = once(websocket, 'message')
    await once(websocket, 'open')
    expect(String((await message)[0])).toBe('private runtime ready')
    const closed = once(websocket, 'close')
    await mounted.dispose()
    await closed
    expect((await call(world.target, world.origin, '/')).status).toBe(404)
    expect(world.ctx.storageDomain.get('hosted_workspaces')).toBeUndefined()
    expect(external.oidcClosed).toHaveBeenCalledTimes(1)
    expect(external.dockerClosed).toHaveBeenCalledTimes(1)
    const reopened = await world.ctx.storageDomain.open((await import('../src/state.ts')).hostedDomain)
    expect([...reopened.table('users').entries()]).toHaveLength(1)
    await reopened.close()
  })

  it('activates implicit login without reading a configured client-secret file', async () => {
    const world = await harness()
    world.config.oidcFlow = 'implicit'
    world.config.clientSecretFile = join(world.root, 'absent-implicit-secret')
    const mounted = await world.ctx.plugin(Hosted, world.config)
    try {
      const options = external.createOidc.mock.calls[0]?.[0]
      expect(options).toMatchObject({ flow: 'implicit', clientId: 'fixture-client' })
      expect(options).not.toHaveProperty('clientSecret')
      expect((await call(world.target, world.origin, '/')).status).toBe(200)
    } finally { await mounted.dispose() }
  })

  it.each(['missing', 'empty'])('rejects a %s model key before exposing any login route', async (kind) => {
    const world = await harness()
    if (kind === 'empty') await writeFile(world.keyFile, ' \n')
    world.config.deepseekKeyFile = kind === 'missing' ? join(world.root, 'missing-key') : world.keyFile
    const mounted = world.ctx.plugin(Hosted, world.config)
    await expect(mounted).rejects.toThrow(kind === 'missing' ? 'ENOENT' : 'secret file is empty')
    await mounted.dispose()
    expect((await call(world.target, world.origin, '/')).status).toBe(404)
    expect(external.createOidc).not.toHaveBeenCalled()
  })

  it('releases its private domain after a configured client-secret file cannot be read', async () => {
    const world = await harness()
    world.config.clientSecretFile = join(world.root, 'missing-secret')
    const mounted = world.ctx.plugin(Hosted, world.config)
    await expect(mounted).rejects.toThrow('ENOENT')
    await mounted.dispose()
    expect(world.ctx.storageDomain.get('hosted_workspaces')).toBeUndefined()
    expect((await call(world.target, world.origin, '/')).status).toBe(404)
  })

  it('reports discovery failure and permits a fresh activation after releasing the failed owner', async () => {
    const world = await harness()
    external.createOidc.mockRejectedValueOnce(new Error('identity discovery unavailable'))
    const failed = world.ctx.plugin(Hosted, world.config)
    await expect(failed).rejects.toThrow('identity discovery unavailable')
    await failed.dispose()
    expect(world.ctx.storageDomain.get('hosted_workspaces')).toBeUndefined()
    expect((await call(world.target, world.origin, '/')).status).toBe(404)
    const retried = await world.ctx.plugin(Hosted, world.config)
    expect((await call(world.target, world.origin, '/')).status).toBe(200)
    await retried.dispose()
  })

  it('leaves an existing fallback intact and releases acquired login resources when route installation fails', async () => {
    const world = await harness()
    const release = world.ctx.webServer.registerFallback((_req, res) => { res.writeHead(418); res.end('existing handler') })
    onTestFinished(release)
    const mounted = world.ctx.plugin(Hosted, world.config)
    await expect(mounted).rejects.toThrow('fallback already registered')
    await mounted.dispose()
    expect((await call(world.target, world.origin, '/')).body).toBe('existing handler')
    expect(world.ctx.storageDomain.get('hosted_workspaces')).toBeUndefined()
    expect(external.oidcClosed).toHaveBeenCalledTimes(1)
    expect(external.dockerClosed).toHaveBeenCalledTimes(1)
  })
})

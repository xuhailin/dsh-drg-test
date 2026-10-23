/** Real HTTP model requests exercise credential replacement, admission, and stream ownership. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { text as readText } from 'node:stream/consumers'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { BlockAssembler, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { ModelProxy, type RuntimeRequestHandler } from '../src/model.ts'
import { HostedState, hostedDomain } from '../src/state.ts'

const UPSTREAM_KEY = 'fixture-upstream-secret-marker'
const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

interface UpstreamRequest {
  headers: IncomingHttpHeaders
  path: string | undefined
  body: string
  response: ServerResponse
  closed: Promise<void>
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind TCP')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  server.closeAllConnections()
  await closed
}

async function harness(overrides: Partial<Config> = {}, runtimeHandler?: RuntimeRequestHandler) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hosted-model-'))
  const ctx = new Context()
  const servers: Server[] = []
  const failures: unknown[] = []
  const resources: { model?: ModelProxy } = {}
  onTestFinished(async () => {
    for (const server of servers) server.closeAllConnections()
    await resources.model?.dispose()
    for (const server of servers) await close(server)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    expect(failures).toEqual([])
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const domain = await ctx.storageDomain.open(hostedDomain)
  const state = new HostedState(domain, 4, 200)
  const user = await state.user({ issuer: 'https://sso.example.test', subject: 'alice', name: 'Alice' })
  const records: UpstreamRequest[] = []
  const firstUpstream = deferred<UpstreamRequest>()
  let respond: (request: UpstreamRequest) => void = ({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(SSE)
  }
  const upstream = createServer((request, response) => {
    const closed = new Promise<void>((resolve) => { response.once('close', resolve) })
    void readText(request).then((body) => {
      const record = { headers: request.headers, path: request.url, body, response, closed }
      records.push(record)
      firstUpstream.resolve(record)
      respond(record)
    }).catch((error: unknown) => {
      failures.push(error)
      response.destroy(error instanceof Error ? error : undefined)
    })
  })
  servers.push(upstream)
  const upstreamOrigin = await listen(upstream)
  const config = Config({
    publicOrigin: 'http://chat.example.test', image: 'test/runtime', issuer: 'https://sso.example.test',
    clientId: 'test-client', deepseekKeyFile: '/unused/key', gatewayContainer: 'test-gateway', allowHttp: true,
    allowedModels: ['allowed-model'], requestTimeoutMs: 30_000, ...overrides,
    deepseekBaseUrl: `${upstreamOrigin}/anthropic`,
    ...(overrides.modelProtocol === 'openai-responses' ? {
      modelKeyFile: '/unused/company-key', modelBaseUrl: `${upstreamOrigin}/v1`, runtimeModel: 'gpt-5.5', runtimeMaxTokens: 256,
    } : {}),
  })
  const model = new ModelProxy(config, state, UPSTREAM_KEY, runtimeHandler)
  resources.model = model
  const tasks: Promise<void>[] = []
  const firstGateway = deferred<undefined>()
  const gateway = createServer((request, response) => {
    const task = model.handle(request, response)
    tasks.push(task)
    firstGateway.resolve(undefined)
    void task.catch((error: unknown) => { failures.push(error); response.destroy(error instanceof Error ? error : undefined) })
  })
  servers.push(gateway)
  const gatewayOrigin = await listen(gateway)
  const valid = { model: 'allowed-model', max_tokens: 128, stream: true, messages: [{ role: 'user', content: 'hello' }] }
  function request(options: {
    path?: string
    method?: string
    credential?: string | null
    body?: string | object
    signal?: AbortSignal
    headers?: Record<string, string>
  } = {}) {
    const method = options.method ?? 'POST'
    const credential = options.credential === null ? undefined : options.credential ?? user.modelToken
    return fetch(`${gatewayOrigin}${options.path ?? '/model/v1/messages'}`, {
      method,
      headers: { 'content-type': 'application/json', ...credential === undefined ? {} : { 'x-api-key': credential }, ...options.headers },
      ...method === 'GET' ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? valid) },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
  }
  return {
    ctx, root, state, user, model, config, records, tasks, valid, request, gatewayOrigin,
    firstUpstream: firstUpstream.promise, firstGateway: firstGateway.promise,
    respond: (handler: typeof respond) => { respond = handler },
    extraServer: async (server: Server) => { servers.push(server); return listen(server) },
  }
}

describe('ModelProxy', () => {
  it('forwards stateless Responses with gateway bearer authentication and an explicit token cap', async () => {
    const world = await harness({ modelProtocol: 'openai-responses', allowedModels: ['gpt-5.5'], maxOutputTokens: 256 })
    const body = { model: 'gpt-5.5', input: 'hello', stream: true, max_output_tokens: 256 }
    const response = await world.request({ path: '/model/v1/responses', credential: null, headers: { authorization: `Bearer ${world.user.modelToken}` }, body })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(SSE)
    const upstream = await world.firstUpstream
    expect(upstream.path).toBe('/v1/responses')
    expect(upstream.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(upstream.headers['x-api-key']).toBeUndefined()
    expect(JSON.parse(upstream.body)).toEqual({ ...body, store: false })
    const wrongProtocol = await world.request()
    expect(wrongProtocol.status).toBe(404)
    await wrongProtocol.text()
  })

  it.each([
    { max_output_tokens: 257 }, { max_output_tokens: 257, max_tokens: 1 }, { max_output_tokens: undefined },
    { max_output_tokens: 0 }, { stream: false },
    { model: 'other-model' }, { store: true }, { background: true },
    { previous_response_id: 'another-user-response' }, { conversation: 'another-user-conversation' },
    { prompt: { id: 'shared-prompt' } }, { tools: [{ type: 'file_search', vector_store_ids: ['shared-store'] }] },
    { tools: [{ type: 'mcp', server_url: 'https://other-service.test' }] },
    { input: [{ type: 'item_reference', id: 'another-user-item' }] },
    { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'another-user-file' }] }] },
  ])('denies Responses outside limits or referencing shared upstream state (%j)', async (extra) => {
    const world = await harness({ modelProtocol: 'openai-responses', allowedModels: ['gpt-5.5'], maxOutputTokens: 256 })
    const response = await world.request({ path: '/model/v1/responses', body: { model: 'gpt-5.5', stream: true, max_output_tokens: 256, input: 'hello', ...extra } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('model_request_not_allowed')
    expect(world.records).toHaveLength(0)
  })

  it('denies conflicting runtime credentials rather than selecting an identity', async () => {
    const world = await harness()
    const response = await world.request({ headers: { authorization: 'Bearer different-token' } })
    expect(response.status).toBe(401)
    await response.text()
    expect(world.records).toHaveLength(0)
  })

  it('dispatches only authenticated runtime extensions and omits the reusable credential', async () => {
    const handler = vi.fn<RuntimeRequestHandler>(async (identity, _request, response) => {
      response.end(JSON.stringify(identity))
      return true
    })
    const world = await harness({}, handler)
    const denied = await world.request({ path: '/runtime/clinical/context', credential: null })
    expect(denied.status).toBe(401)
    await denied.text()
    expect(handler).not.toHaveBeenCalled()
    const accepted = await world.request({ path: '/runtime/clinical/context' })
    expect(await accepted.json()).toEqual({ id: world.user.id, issuer: world.user.issuer, subject: world.user.subject })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(world.records).toHaveLength(0)
  })

  it.each([undefined, async () => false])('rejects unhandled runtime routes (%s)', async (handler) => {
    const world = await harness({}, handler)
    const response = await world.request({ path: '/runtime/unknown' })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('unsupported_runtime_operation')
  })

  it('aborts and awaits a runtime extension before disposal settles', async () => {
    const entered = deferred<AbortSignal>()
    let settled = false
    const world = await harness({}, async (_identity, request, _response, signal) => {
      await readText(request)
      entered.resolve(signal)
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      settled = true
      signal.throwIfAborted()
      return true
    })
    const pending = world.request({ path: '/runtime/clinical/context' })
    const signal = await entered.promise
    await world.model.dispose()
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(true)
    const response = await pending
    expect(response.status).toBe(502)
    expect(await response.text()).toContain('runtime_request_failed')
  })

  it('runs a Loader-configured pi-ai tool round trip through the Responses proxy', async () => {
    const world = await harness({ modelProtocol: 'openai-responses', allowedModels: ['gpt-5.5'] })
    const credentials = join(world.root, 'runtime-credentials.yaml')
    await writeFile(credentials, `version: 1\nrefs:\n  HOSTED_MODEL_API_KEY: ${world.user.modelToken}\n`, { mode: 0o600 })
    const configPath = join(world.root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      { id: 'llm', name: 'cordis:llm' },
      { id: 'credentials', name: 'cordis:credentials', config: { path: credentials, watch: false } },
      { id: 'company-model', name: 'cordis:company-model', config: { providers: { company: {
        displayName: 'Company models', apiKeyEnv: 'HOSTED_MODEL_API_KEY', api: 'openai-responses',
        baseURL: `${world.gatewayOrigin}/model/v1`, transport: 'sse',
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5', maxTokens: 256, contextWindow: 32768 }],
      } } } },
    ]))
    world.ctx.baseUrl = pathToFileURL(world.root).href + '/'
    await world.ctx.plugin(Loader)
    Object.assign(world.ctx.loader.builtins, { include: Include, llm: LlmRuntime, credentials: LocalCredentialProvider, 'company-model': LlmPiAi })
    await world.ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await world.ctx.loader.await()
    world.respond(({ response }) => {
      const item = world.records.length === 1
        ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo_status', arguments: '{"status":"OK"}' }
        : { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
      const events = [
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', output_index: 0, item },
        ...(world.records.length === 1 ? [] : [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' }]),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
    async function run(options: GenerateOptions) {
      const assembler = new BlockAssembler()
      for await (const chunk of world.ctx.llm.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind === 'error') throw new Error(JSON.stringify(assembler.finish.failure))
      return assembler.message({ provider: options.provider, model: options.model,
        ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState } })
    }
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Return the test status.' }] })
    const options: GenerateOptions = { provider: 'company', model: 'gpt-5.5', messages: [input], tools: [{
      name: 'echo_status', description: 'Return the supplied status.',
      parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
    }] }
    const first = await run(options)
    const call = first.content.find(block => block.type === 'tool-call')
    expect(call).toMatchObject({ name: 'echo_status', arguments: '{"status":"OK"}' })
    if (call?.type !== 'tool-call') throw new Error('Expected tool call')
    const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'OK' }] })
    const last = await run({ ...options, messages: [input, first, result] })
    expect(last.content).toEqual([{ type: 'text', text: 'OK' }])
    expect(world.records).toHaveLength(2)
    const requests = world.records.map((record): unknown => JSON.parse(record.body))
    expect(requests[0]).toMatchObject({ model: 'gpt-5.5', max_output_tokens: 256, store: false })
    expect(requests[1]).toHaveProperty('input', expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call_1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1', output: 'OK' }),
    ]))
    expect(world.records.every(record => record.headers.authorization === `Bearer ${UPSTREAM_KEY}`)).toBe(true)
    const entry = [...world.ctx.loader.entries()].find(candidate => candidate.options.id === 'company-model')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(world.ctx.llm.listProviders()).toEqual([])
  })

  it('serves and reuses a private-interface listener and refuses protocol upgrades', async () => {
    const world = await harness()
    world.config.gatewayPort = 0
    await world.model.listenOn('127.0.0.1')
    await world.model.listenOn('127.0.0.1')
    const server = await world.model['listeners'].get('127.0.0.1')
    const address = server?.address()
    if (address === undefined || address === null || typeof address === 'string') throw new Error('missing private listener')
    const origin = `http://127.0.0.1:${address.port}`
    const response = await fetch(`${origin}/model/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': world.user.modelToken }, body: JSON.stringify(world.valid),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(SSE)
    await expect(new Promise<void>((resolve, reject) => {
      const upgrade = httpRequest(origin, { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
      upgrade.once('error', reject)
      upgrade.once('response', () => { resolve() })
      upgrade.end()
    })).rejects.toBeInstanceOf(Error)
    server?.emit('error', new Error('listener transport failed'))
  })

  it('reports an occupied listener address and settles a concurrent shutdown', async () => {
    const world = await harness()
    world.config.gatewayPort = Number(new URL(world.gatewayOrigin).port)
    const binding = expect(world.model.listenOn('127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await Promise.all([binding, world.model.dispose()])
    expect(world.model['listeners'].size).toBe(0)
  })

  it('accepts a request whose owning HTTP middleware already installed UTF-8 text decoding', async () => {
    const world = await harness()
    const address = await world.extraServer(createServer((request, response) => {
      request.setEncoding('utf8')
      void world.model.handle(request, response)
    }))
    const response = await fetch(`${address}/model/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': world.user.modelToken }, body: JSON.stringify(world.valid),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(SSE)
  })

  it('releases failed admission work when the credential store is unavailable', async () => {
    const world = await harness()
    const lookup = vi.spyOn(world.state, 'modelUser').mockImplementationOnce(() => { throw new Error('credential storage unavailable') })
    onTestFinished(() => { lookup.mockRestore() })
    const address = await world.extraServer(createServer((request, response) => {
      void world.model.handle(request, response).catch(() => { response.writeHead(503); response.end('storage unavailable') })
    }))
    const response = await fetch(`${address}/model/v1/messages`, { method: 'POST' })
    expect(response.status).toBe(503)
    await response.text()
    await world.model.dispose()
  })

  it('uses the streaming content type when an upstream omits that response header', async () => {
    const world = await harness()
    world.respond(({ response }) => { response.writeHead(200); response.end(SSE) })
    const response = await world.request()
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe(SSE)
  })

  it('binds a private interface while live and refuses listener acquisition after disposal', async () => {
    const world = await harness()
    world.config.gatewayPort = 0
    const model = new ModelProxy(world.config, world.state, UPSTREAM_KEY)
    onTestFinished(async () => { await model.dispose() })
    await model.listenOn('127.0.0.1')
    await model.dispose()
    await expect(model.listenOn('127.0.0.1')).rejects.toThrow('model proxy is shutting down')
  })

  it('rejects new model work after disposal without contacting the upstream', async () => {
    const world = await harness()
    await world.model.dispose()
    const response = await world.request()
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('model_proxy_unavailable')
    expect(world.records).toHaveLength(0)
  })

  it('streams upstream bytes using the gateway key and strips runtime authentication', async () => {
    const world = await harness()
    const response = await world.request({ headers: { cookie: 'private-cookie=runtime-only' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe(SSE)
    const upstream = await world.firstUpstream
    expect(upstream.path).toBe('/anthropic/v1/messages')
    expect(upstream.headers['x-api-key']).toBe(UPSTREAM_KEY)
    expect(upstream.headers.authorization).toBeUndefined()
    expect(upstream.headers.cookie).toBeUndefined()
    expect(upstream.body).not.toContain(world.user.modelToken)
    expect(JSON.parse(upstream.body)).toEqual(world.valid)
  })

  it.each([null, 'short', 'x'.repeat(43)])('rejects an absent or unknown runtime credential (%s)', async (credential) => {
    const world = await harness()
    const response = await world.request({ credential })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('invalid_runtime_credential')
    expect(world.records).toHaveLength(0)
  })

  it.each([
    { path: '/model/v1/files' },
    { path: '/model/v1/files/private-file' },
    { path: '/model/v1/messages', method: 'GET' },
    { path: '/model/v1/messages/other' },
  ])('denies unsupported model and file operations ($path $method)', async (options) => {
    const world = await harness()
    const response = await world.request(options)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('unsupported_model_operation')
    expect(world.records).toHaveLength(0)
  })

  it.each([
    { model: 'unapproved-model' },
    { max_tokens: 257 },
    { max_tokens: 257, max_output_tokens: 1 },
    { max_tokens: 0 },
    { max_tokens: 1.5 },
    { stream: false },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'other-runtime-file' } }] }] },
  ])('denies model or output settings outside the deployment allowance (%j)', async (body) => {
    const world = await harness({ maxOutputTokens: 256 })
    const response = await world.request({ body: { ...world.valid, ...body } })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('model_request_not_allowed')
    expect(world.records).toHaveLength(0)
  })

  it('rejects malformed JSON and byte limits before calling the upstream', async () => {
    const world = await harness({ maxModelRequestBytes: 256 })
    const malformed = await world.request({ body: '{' })
    expect(malformed.status).toBe(400)
    expect(await malformed.text()).toContain('invalid_model_json')
    const exactBody = JSON.stringify(world.valid).padEnd(256, ' ')
    const exact = await world.request({ body: exactBody })
    expect(exact.status).toBe(200)
    await exact.text()
    const oversized = await world.request({ body: { ...world.valid, padding: '界'.repeat(128) } })
    expect(oversized.status).toBe(413)
    expect(await oversized.text()).toContain('model_request_too_large')
    expect(world.records).toHaveLength(1)
  })

  it('enforces independent account request windows and admits the next window', async () => {
    const world = await harness({ maxRequestsPerWindow: 2, rateWindowMs: 60_000 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    onTestFinished(() => { clock.mockRestore() })
    for (let index = 0; index < 2; index++) {
      const response = await world.request()
      expect(response.status).toBe(200)
      await response.text()
    }
    const denied = await world.request()
    expect(denied.status).toBe(429)
    expect(denied.headers.get('retry-after')).toBe('60')
    await denied.text()
    const bob = await world.state.user({ issuer: 'https://sso.example.test', subject: 'bob', name: 'Bob' })
    const independent = await world.request({ credential: bob.modelToken })
    expect(independent.status).toBe(200)
    await independent.text()
    clock.mockReturnValue(now + world.config.rateWindowMs)
    const next = await world.request()
    expect(next.status).toBe(200)
    await next.text()
    expect(world.records).toHaveLength(4)
  })

  it('holds a concurrency slot until the client closes its streaming response', async () => {
    const world = await harness({ maxConcurrentModelRequests: 1 })
    world.respond(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': held stream\n\n') })
    const first = await world.request()
    const upstream = await world.firstUpstream
    const denied = await world.request()
    expect(denied.status).toBe(429)
    await denied.text()
    expect(world.records).toHaveLength(1)
    await first.body?.cancel()
    await upstream.closed
    await Promise.allSettled([...world.tasks])
    world.respond(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(SSE) })
    const next = await world.request()
    expect(next.status).toBe(200)
    expect(await next.text()).toBe(SSE)
    expect(world.records).toHaveLength(2)
  })

  it('retains accurate active slots when a stream spans a request-window rollover', async () => {
    const world = await harness({ maxConcurrentModelRequests: 2, rateWindowMs: 60_000 })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    onTestFinished(() => { clock.mockRestore() })
    world.respond(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': held stream\n\n') })
    const first = await world.request()
    const firstUpstream = await world.firstUpstream
    clock.mockReturnValue(now + world.config.rateWindowMs)
    const second = await world.request()
    const secondUpstream = world.records.at(-1)
    if (secondUpstream === undefined) throw new Error('Second upstream request is missing')
    expect(world.records).toHaveLength(2)
    firstUpstream.response.end()
    await first.text()
    await world.tasks[0]
    world.respond(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(SSE) })
    const third = await world.request()
    expect(third.status).toBe(200)
    expect(await third.text()).toBe(SSE)
    secondUpstream.response.end()
    await second.text()
  })

  it.each([429, 500])('sanitizes upstream error payloads and credentials (%i)', async (status) => {
    const world = await harness()
    world.respond(({ response }) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: UPSTREAM_KEY })) })
    const response = await world.request()
    expect(response.status).toBe(status === 429 ? 429 : 502)
    const payload = await response.text()
    expect(payload).toContain('model_upstream_failed')
    expect(payload).not.toContain(UPSTREAM_KEY)
    expect(payload).not.toContain(world.user.modelToken)
  })

  it('cancels the upstream request when a client disconnects before response headers', async () => {
    const world = await harness()
    world.respond(() => {})
    const controller = new AbortController()
    const response = world.request({ signal: controller.signal }).then(() => 'completed', () => 'aborted')
    const upstream = await world.firstUpstream
    controller.abort()
    expect(await response).toBe('aborted')
    await upstream.closed
    await Promise.allSettled([...world.tasks])
  })

  it('rejects cross-origin upstream redirects without sending the upstream key to their target', async () => {
    const world = await harness()
    let redirectedRequests = 0
    const target = await world.extraServer(createServer((_request, response) => { redirectedRequests++; response.end(SSE) }))
    world.respond(({ response }) => { response.writeHead(307, { location: `${target}/stolen-key` }); response.end() })
    const response = await world.request()
    expect(response.status).toBe(502)
    const payload = await response.text()
    expect(payload).not.toContain(UPSTREAM_KEY)
    expect(redirectedRequests).toBe(0)
  })

  it('closes an unfinished incoming request body before disposal settles', async () => {
    const world = await harness()
    const upload = httpRequest(`${world.gatewayOrigin}/model/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': world.user.modelToken, 'content-type': 'application/json' },
    })
    const closed = new Promise<void>((resolve) => { upload.once('close', resolve) })
    let uploadError: Error | undefined
    upload.once('error', (error) => { uploadError = error })
    try {
      upload.write('{"model":')
      await world.firstGateway
      await world.model.dispose()
      await closed
      expect(uploadError).toBeInstanceOf(Error)
      expect(world.records).toHaveLength(0)
    } finally {
      upload.destroy()
    }
  })

  it('aborts and awaits an active upstream stream during disposal', async () => {
    const world = await harness()
    world.respond(({ response }) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': held stream\n\n') })
    const response = await world.request()
    const upstream = await world.firstUpstream
    const completed = response.text().then(() => 'completed', () => 'aborted')
    await world.model.dispose()
    await upstream.closed
    expect(await completed).toBe('aborted')
    expect(world.records).toHaveLength(1)
  })
})

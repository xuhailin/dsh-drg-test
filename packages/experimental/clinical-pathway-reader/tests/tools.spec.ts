/** Real preset scopes and tool execution with a synthetic external HTTP reader. */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { PathwayAccess } from '../src/access.ts'
import { Config } from '../src/config.ts'
import * as Reader from '../src/index.ts'
import { resultSchema, type ReadResult } from '../src/protocol.ts'
import { registerPathwayTools } from '../src/tools.ts'

const names = ['pathway_read', 'history_query', 'case_read'] as const
const history = { from: '2025-04-01T00:00:00Z', to: '2025-05-01T00:00:00Z', timeBasis: 'admission' }

async function fixture() {
  const ctx = new Context()
  const received = Promise.withResolvers<undefined>()
  const requests: { tool: ReadResult['tool']; args: ReadResult['filters'] }[] = []
  const state = { hold: false }
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const tool = z.enum(names).parse(request.url?.split('/').at(-1))
      const args = z.record(z.string(), z.json()).parse(JSON.parse(body))
      requests.push({ tool, args })
      if (request.headers['x-api-key'] !== 'synthetic-tool-runtime-token') {
        response.writeHead(403).end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      if (state.hold) {
        response.write('{')
        received.resolve(undefined)
        return
      }
      const evidence: ReadResult = { schemaVersion: 1, tool, sourceSystem: 'synthetic-reader',
        scope: { hospitalCode: 'hospital-one', departmentCodes: ['department-one'], departmentBasis: 'discharge',
          admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z', includeSharedDefinitions: false },
        readStartedAt: '2025-05-01T00:00:00Z', readCompletedAt: '2025-05-01T00:00:01Z', filters: args,
        collections: { evidence: [{ sourceId: '123', note: 'Synthetic retained source text' }] }, measures: {},
        nextOffset: null, truncated: false, coverage: ['reference-only'] }
      response.end(JSON.stringify(evidence))
    })
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic reader did not bind TCP')
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    HOSTED_RUNTIME_API_KEY: 'synthetic-tool-runtime-token',
  } }]))
  await ctx.plugin(Loader)
  ctx.loader.builtins['synthetic-pathway-reader'] = Reader
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(AgentPresets, { default: 'pathway' })
  const config = Config({ mode: 'tools', brokerBaseUrl: `http://127.0.0.1:${address.port}/runtime/pathway` })
  const unregister = await ctx.agentPresets.register({ id: 'pathway', plugins: [
    { id: 'pathway-reader', name: 'cordis:synthetic-pathway-reader', config },
  ] })
  ctx.effect(() => unregister)
  const handle = await ctx.agents.create({ sessionId: SessionId('pathway-tools'), setup: async (agentCtx) => {
    await ctx.agentPresets.mount(agentCtx, 'pathway')
  } })
  return { ctx, agent: handle.agent, handle, config, requests, state, received: received.promise, unregister }
}

it('executes all three tools under the real preset ancestor and renders the same canonical evidence', async () => {
  const world = await fixture()
  expect(world.ctx.agentPresets.composedPreset(world.agent.ctx)).toBe('pathway')
  expect(world.ctx.tools.schemas(world.agent).map(tool => tool.name).sort()).toEqual([...names].sort())
  expect(world.ctx.tools.schemas()).toEqual([])
  for (const [name, args, kind] of [
    ['pathway_read', { pathwayId: '101' }, 'read'],
    ['history_query', history, 'search'],
    ['case_read', { inpatId: '123', category: 'documents', recordId: '10', contentId: '20', start: 1, length: 12 }, 'read'],
  ] as const) {
    const result = await world.ctx.tools.execute({ name, arguments: args, agent: world.agent,
      signal: new AbortController().signal, callId: ToolCallId(`read-${name}`) })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('Expected an accepted synthetic read')
    const evidence = resultSchema.parse(result.value)
    expect(evidence).toMatchObject({ tool: name, filters: { ...args, offset: 0, limit: 20 } })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(evidence) }])
    const definition = world.ctx.tools.get(name, world.agent)
    expect(definition?.presentCall?.(args)).toEqual({ card: 'generic', title: name, kind, rawInput: args })
    expect(definition?.output.render(args, evidence)).toEqual(result.content)
  }
  expect(world.requests.map(request => request.tool)).toEqual(names)
})

it('rejects leaked tool functions for absent or unrelated Agents without making another HTTP request', async () => {
  const world = await fixture()
  const definition = world.ctx.tools.get('pathway_read', world.agent)
  if (definition === undefined) throw new Error('Scoped read tool is unavailable')
  const execution = vi.spyOn(definition, 'execute')
  await world.ctx.tools.execute({ name: 'pathway_read', arguments: {}, agent: world.agent,
    signal: new AbortController().signal, callId: ToolCallId('capture-real-execution') })
  const exec = execution.mock.calls[0]?.[1]
  if (exec === undefined) throw new Error('Registry did not dispatch the scoped read')
  const unrelated = await world.ctx.agents.create({ sessionId: SessionId('unrelated-tools') })
  const noAgent = { ...exec }
  delete noAgent.agent
  for (const denied of [noAgent, { ...exec, agent: unrelated.agent }]) {
    await expect(definition.execute({}, denied)).rejects.toMatchObject({ code: 'forbidden' })
    const hidden = await world.ctx.tools.execute({ ...denied, callId: ToolCallId('unavailable-read') })
    expect(hidden.isError).toBe(true)
    expect(JSON.stringify(hidden.content)).toContain('unknown tool')
  }
  expect(world.requests).toHaveLength(1)
  execution.mockRestore()
})

it('rejects invalid model selectors before sending them to the external reader', async () => {
  const world = await fixture()
  for (const [name, args] of [
    ['pathway_read', { pathwayId: '9223372036854775808' }],
    ['history_query', { ...history, from: '2025-04-01' }],
    ['case_read', { inpatId: '123', category: 'orders', contentId: '20' }],
  ] as const) {
    const result = await world.ctx.tools.execute({ name, arguments: args, agent: world.agent,
      signal: new AbortController().signal, callId: ToolCallId(`invalid-${name}`) })
    expect(result.isError).toBe(true)
  }
  expect(world.requests).toEqual([])
})

it('retires a preset after its last Agent, cancelling its HTTP read and removing all registrations', async () => {
  const world = await fixture()
  world.state.hold = true
  const pending = world.ctx.tools.execute({ name: 'case_read', arguments: { inpatId: '123', category: 'encounter' },
    agent: world.agent, signal: new AbortController().signal, callId: ToolCallId('unload-read') })
  await world.received
  await world.unregister()
  expect(world.ctx.tools.schemas(world.agent)).toHaveLength(3)
  await world.handle.dispose()
  const result = await pending
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('reader was unloaded')
  expect(world.ctx.tools.schemas(world.agent)).toEqual([])
  expect(world.ctx.tools.schemas()).toEqual([])
  expect(world.requests).toHaveLength(1)
})

it('rejects registration without a tools service or without a preset scope', async () => {
  const world = await fixture()
  const access = new PathwayAccess(world.ctx, world.config)
  const missing = new Context()
  onTestFinished(async () => { await access.dispose(); await missing.fiber.dispose() })
  expect(() => { registerPathwayTools(missing, access) }).toThrow('mount tools inside the clinical pathway preset')
  expect(() => { registerPathwayTools(world.ctx, access) }).toThrow('mount tools inside the clinical pathway preset')
})

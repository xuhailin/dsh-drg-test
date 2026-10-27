/** Synthetic HTTP gateway and optional model script around the production pathway preset. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { generateClinicalPathwayPreset } from '../../../../deploy/hosted-workspaces/company-presets.mjs'
import { resultSchema, type ReadResult, type ClinicalSourceRow } from '../src/protocol.ts'

export const name = 'clinical-pathway-reader-fixture'
export const inject = ['agents', 'agentPresets', 'tools', 'llm']
export const Config = s.object({ scriptModel: s.boolean().default(false), saveRequests: s.boolean().default(false) })

const token = 'synthetic-pathway-runtime-token'
const calls = [
  { name: 'pathway_read', args: { pathwayId: '101' } },
  { name: 'history_query', args: { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z', timeBasis: 'admission', mode: 'cohort' } },
  { name: 'case_read', args: { inpatId: '999', category: 'documents', recordId: '10', contentId: '20' } },
  { name: 'case_read', args: { inpatId: '123', category: 'documents', recordId: '10', contentId: '20' } },
]
const summary = '参考分析（未写入临床系统）：路径基线为 101／版本 2；合成历史人群共 3 次住院，其中 1 次未入径。文书 10:20 记载“合成病程：已记录复评计划”。越范围病例 999 已被拒绝读取。检验、检查和实际执行来源未支持，不能据此判断任务完成或给出完成率。建议核对复评要求及其证据，供临床负责人判断；未创建业务草案、修改路径或发布版本。'

interface RequestLog { method: string; path: string; authorized: boolean; args: ClinicalSourceRow }

function responseFor(tool: ReadResult['tool'], args: ClinicalSourceRow): ReadResult {
  const result: ReadResult = {
    schemaVersion: 1, tool, sourceSystem: 'synthetic-emr',
    scope: { hospitalCode: '1001', departmentCodes: ['dept-one'], departmentBasis: 'discharge',
      admissionFrom: '2025-01-01T00:00:00Z', admissionTo: '2026-01-01T00:00:00Z', includeSharedDefinitions: false },
    readStartedAt: '2026-10-22T00:00:00.000Z', readCompletedAt: '2026-10-22T00:00:01.000Z', filters: args,
    collections: {}, measures: {}, nextOffset: null, truncated: false, coverage: [],
  }
  if (tool === 'pathway_read') {
    const other = args.pathwayId === '202'
    result.collections.pathways = [{ id: other ? '202' : '101', pathway_code: other ? 'synthetic-other-pathway' : 'synthetic-pathway',
      version_no: '2', pathway_name: other ? '合成第二路径' : '合成复评路径', state_code: 1 }]
    result.collections.nodes = [{ id: other ? '302' : '201', clinical_pathway_id: other ? '202' : '101',
      node_name: other ? '第二路径阶段' : '复评阶段', last_node_id: null, sequence: 0 }]
    result.coverage = ['Definition identity is the exact source version; this response does not create or publish a version.']
  } else if (tool === 'history_query') {
    result.collections.admissions = [{ inpatId: '123', stateCode: '6', outTime: '2025-10-21T00:00:00Z' }]
    result.measures = { admissionCount: 3, executionCount: 2, admissionsWithoutExecutionCount: 1 }
    result.coverage = ['Counts cover the entire filtered cohort, not just the displayed page.', 'Recorded execution status does not prove actual clinical delivery.']
  } else {
    result.collections.documents = [{ id: '10:20', recordId: '10', contentId: '20', state: 'signed', readable: true,
      occurredAt: '2025-10-20T00:00:00Z', availableAt: '2025-10-20T01:00:00Z',
      text: '合成病程：已记录复评计划。', start: 0, length: 4000, totalChars: 13, nextStart: null }]
    result.coverage = ['labs:unsupported', 'checks:unsupported', 'operations:unsupported', 'administration:unsupported']
  }
  return resultSchema.parse(result)
}

class ScriptedModel extends LlmAdapter {
  private step = 0
  constructor(private readonly ctx: Context) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const agent = this.ctx.agents.requireInitiator()
    const names = new Set(this.ctx.tools.schemas(agent).map(tool => tool.name))
    for (const name of ['pathway_read', 'history_query', 'case_read']) if (!names.has(name)) throw new Error(`Preset omitted ${name}`)
    const messages = JSON.stringify(options.messages)
    if (!messages.includes('你是“临床路径分析”助手')) throw new Error('Pathway persona did not reach the model request')
    const call = calls[this.step++]
    if (call !== undefined) {
      const id = ToolCallId(`pathway-fixture-${String(this.step)}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    for (const evidence of ['synthetic-pathway', 'admissionCount', '合成病程：已记录复评计划。', 'Synthetic encounter is outside the authorized scope.']) {
      if (!messages.includes(evidence)) throw new Error(`Tool evidence missing from model history: ${evidence}`)
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: summary }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount the production scoped tools and replace only their external gateway and model. */
export async function apply(ctx: Context, config: { scriptModel: boolean; saveRequests: boolean }): Promise<void> {
  const requests: RequestLog[] = []
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const args = z.record(z.string(), z.json()).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const path = request.url ?? ''
    const authorized = request.headers['x-api-key'] === token
    requests.push({ method: request.method ?? '', path, authorized, args })
    if (config.saveRequests) await writeFile(join(process.cwd(), '.dsh/pathway-requests.json'), JSON.stringify(requests))
    response.setHeader('content-type', 'application/json')
    if (!authorized || request.method !== 'POST' || args.inpatId === '999') {
      response.statusCode = 403
      response.end(JSON.stringify({ error: { code: 'forbidden', message: 'Synthetic encounter is outside the authorized scope.' } }))
      return
    }
    const tool = z.enum(['pathway_read', 'history_query', 'case_read']).parse(path.slice('/runtime/pathway/'.length))
    response.end(JSON.stringify(responseFor(tool, args)))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      void error // A malformed synthetic request returns a deterministic external failure.
      response.statusCode = 500
      response.end(JSON.stringify({ error: { code: 'source-unavailable', message: 'Synthetic gateway request failed.' } }))
    })
  })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error === undefined) resolve(); else reject(error) }) })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic gateway did not bind a TCP port')
  const preset = generateClinicalPathwayPreset(fileURLToPath(new URL('../../../../', import.meta.url)))
  const row = preset.config.plugins.find(plugin => plugin.id === 'pathway-reader')
  if (row === undefined) throw new Error('Production pathway preset omitted the reader declaration')
  row.disabled = false
  row.config = { ...z.record(z.string(), z.unknown()).parse(row.config), mode: 'tools',
    brokerBaseUrl: `http://127.0.0.1:${String(address.port)}/runtime/pathway/`, runtimeTokenEnv: 'PATHWAY_FIXTURE_TOKEN' }
  const dispose = await ctx.agentPresets.register(preset.config)
  ctx.effect(() => dispose)
  if (config.scriptModel) ctx.effect(() => ctx.llm.registerAdapter(['pathway-fixture'], new ScriptedModel(ctx)))
  ctx.on('agent/pre-step', async (_payload, next) => {
    const now = Date.now
    Date.now = () => 1792700000000
    try { return await next() }
    finally { Date.now = now }
  }, { prepend: true })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    await ctx.agentPresets.select(agent, preset.config.id)
  }, { prepend: true })
}

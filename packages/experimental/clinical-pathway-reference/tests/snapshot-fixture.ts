/** Synthetic model/source inputs around the production pathway reference plugin. */
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import s from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { generateClinicalPathwayPreset } from '../../../../deploy/hosted-workspaces/company-presets.mjs'
import { viewSchema } from '../src/protocol.ts'
import type { ReferenceConfig, ReferenceView } from '../src/types.ts'

export const name = 'clinical-pathway-reference-fixture'
export const inject = ['agents', 'agentPresets', 'tools', 'llm', 'sessionController', 'sessionProjections']
export const Config = s.object({ scriptModel: s.boolean().default(false), restore: s.boolean().default(false) })

const token = 'synthetic-reference-read-token'
const epoch = Date.parse('2026-10-27T00:00:00.000Z')
const scope = { sourceSystem: 'synthetic-emr', hospitalCode: '1001', departmentCodes: ['99999'], departmentBasis: 'current',
  admissionFrom: '2025-10-27T00:00:00Z', admissionTo: '2026-10-27T00:00:00Z' } as const
const source = { schemaVersion: 1, tool: 'pathway_read', sourceSystem: scope.sourceSystem,
  scope: { hospitalCode: scope.hospitalCode, departmentCodes: scope.departmentCodes, departmentBasis: scope.departmentBasis,
    admissionFrom: scope.admissionFrom, admissionTo: scope.admissionTo, includeSharedDefinitions: false }, readStartedAt: '2026-10-27T00:00:00.000Z', readCompletedAt: '2026-10-27T00:00:00.000Z',
  filters: { pathwayId: '101' }, collections: {
    pathways: [{ id: '101', pathway_code: 'SYNTHETIC-PATHWAY', pathway_name: '合成参考路径', version_no: '2', dept_code: '99999', dept_name: '合成科室', fee_lower_limit: '0', fee_upper_limit: null, days_lower_limit: 1, days_upper_limit: 2 }],
    departments: [{ id: '102', clinical_pathway_id: '101', dept_code: '99999', dept_name: '合成科室' }], diagnoses: [], assessments: [],
    nodes: [{ id: '201', clinical_pathway_id: '101', node_name: '合成阶段', node_attribute: 0, last_node_id: null, sequence: 0, days_lower_limit: 1, days_upper_limit: 2 }],
    items: [{ id: '301', node_id: '201', item_type: 0, item_code: 'SYNTHETIC-ORDER', item_name: '合成医嘱', once_dose: 0,
      group_flag: 0, group_package_flag: 0, group_package_sn: 1, group_sign: 1, group_sort: 1,
      is_multiple_choice: false, is_required: true, is_once_dose_change: false }],
    branches: [], operations: [], herbalRecipes: [], herbalDetails: [],
  }, measures: { rootPathwayId: '101' }, nextOffset: null, truncated: false,
  coverage: ['Synthetic exact definition; no hospital write capability.'],
}

function referenceResult(agent: Agent): ReferenceView & { config?: ReferenceConfig } {
  for (const event of agent.session.snapshotEvents().toReversed()) {
    if (event.type !== 'tool/result' || event.data.message.isError) continue
    for (const block of event.data.message.content) {
      if (block.type !== 'text') continue
      const parsed: unknown = JSON.parse(block.text)
      const view = viewSchema.safeParse(parsed)
      if (view.success) return view.data
      if (parsed !== null && typeof parsed === 'object' && 'state' in parsed && 'sources' in parsed && 'config' in parsed) {
        return { ...viewSchema.parse({ state: parsed.state, sources: parsed.sources }), config: parsed.config as ReferenceConfig }
      }
    }
  }
  throw new Error('Scripted model did not receive a reference tool result')
}

class ScriptedModel extends LlmAdapter {
  private step = 0
  constructor(private readonly ctx: Context, private readonly restore: boolean) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const agent = this.ctx.agents.requireInitiator()
    if (!this.ctx.tools.schemas(agent).some(tool => tool.name === 'pathway_reference')) throw new Error('Production reference tool is missing')
    const lastResult = agent.session.snapshotEvents().toReversed().find(event => event.type === 'tool/result')
    if (lastResult?.type === 'tool/result' && lastResult.data.message.isError) throw new Error(JSON.stringify(lastResult.data.message.content))
    if (this.restore) {
      const id = SessionId(await readFile(join(process.cwd(), '.dsh/reference-owner.txt'), 'utf8'))
      const loaded = await this.ctx.sessionController.resolveAgent(id)
      if ('error' in loaded) throw loaded.error
      const saved = this.ctx.sessionProjections.stateOf(loaded.agent.session, 'clinicalPathwayReference')
      if (saved?.revisions.length !== 3 || saved.revisions[2]?.definition.clinicalPathway.name !== '合成参考路径'
        || saved.revisions[2].undoes !== 2 || saved.baseline?.clinicalPathway.id !== 101) throw new Error('Production cold restore lost the committed reference')
      yield* this.finish('参考稿已从持久化 Session 恢复，包含基线、三次参考修订和撤回记录。')
      return
    }
    const step = this.step++
    let name = 'pathway_reference'
    let args: object
    if (step === 0) { name = 'pathway_read'; args = { pathwayId: '101' } }
    else if (step === 1 || step === 5) args = { action: 'read' }
    else if (step === 2) {
      const view = referenceResult(agent)
      args = { action: 'create', payload: JSON.stringify({ requestId: 'synthetic-create', mode: 'revision', title: '合成参考任务', scope,
        sourceEventSeq: view.sources[0]?.eventSeq }) }
    } else if (step === 3) {
      const view = referenceResult(agent)
      const current = view.state?.revisions.at(-1)
      if (current === undefined) throw new Error('Create did not save a reference')
      const candidate = structuredClone(current.definition)
      candidate.clinicalPathway.name = '合成 AI 修改后路径'
      args = { action: 'commit', payload: JSON.stringify({ requestId: 'synthetic-commit', baseRevision: current.revision, definition: candidate }) }
    } else if (step === 4) args = { action: 'undo', payload: JSON.stringify({ requestId: 'synthetic-undo', baseRevision: 2, revision: 2 }) }
    else {
      const view = referenceResult(agent)
      if (view.state?.revisions.length !== 3 || view.state.revisions[2]?.definition.clinicalPathway.name !== '合成参考路径') throw new Error('Reference tools did not preserve create/commit/undo state')
      await writeFile(join(process.cwd(), '.dsh/reference-owner.txt'), agent.id)
      yield* this.finish('参考稿已保存：绑定具体路径版本 101／2，AI 修改形成参考修订 2，撤回形成修订 3；轻量预览读取同一保存内容，未写入医院。')
      return
    }
    const id = ToolCallId(`reference-fixture-${String(step + 1)}`)
    const encoded = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: encoded }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: encoded } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  private async *finish(text: string): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Replace only source/model/clock inputs; all reference tools and persistence stay production-owned. */
export async function apply(ctx: Context, config: { scriptModel: boolean; restore: boolean }): Promise<void> {
  // This fixture lives in its own dsh subprocess. Pin wall clocks without modifying Session records.
  const originalDate = globalThis.Date
  const fixedDate = new Proxy(originalDate, {
    construct: (target, args) => Reflect.construct(target, args.length === 0 ? [epoch] : args) as Date,
    get: (target, key, receiver): unknown => key === 'now' ? () => epoch : Reflect.get(target, key, receiver),
  })
  ctx.effect(() => { globalThis.Date = fixedDate; return () => { globalThis.Date = originalDate } })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/runtime/pathway/pathway_read' || request.headers['x-api-key'] !== token) {
      response.writeHead(403); response.end('Synthetic read denied'); return
    }
    request.resume()
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(source))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Synthetic read gateway did not bind')
  const preset = generateClinicalPathwayPreset(fileURLToPath(new URL('../../../../', import.meta.url)))
  const reader = preset.config.plugins.find(row => row.id === 'pathway-reader')
  if (reader === undefined) throw new Error('Production preset omitted the pathway reader')
  reader.disabled = false
  reader.config = { mode: 'tools', brokerBaseUrl: `http://127.0.0.1:${String(address.port)}/runtime/pathway/`, runtimeTokenEnv: 'REFERENCE_FIXTURE_TOKEN' }
  const dispose = await ctx.agentPresets.register(preset.config)
  ctx.effect(() => dispose)
  if (config.scriptModel) ctx.effect(() => ctx.llm.registerAdapter(['reference-fixture'], new ScriptedModel(ctx, config.restore)))
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession === undefined && ctx.sessionProjections.stateOf(agent.session, 'agentPreset') !== preset.config.id) await ctx.agentPresets.select(agent, preset.config.id)
  }, { prepend: true })
}

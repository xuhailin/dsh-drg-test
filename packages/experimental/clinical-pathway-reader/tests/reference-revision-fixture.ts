/** Test-only user followups and an external model script exercise ordinary Chat and file tools. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply as mountGatewayFixture } from './snapshot-fixture.ts'

export const name = 'pathway-reference-revision-fixture'
export const inject = ['agents', 'agentPresets', 'tools', 'llm']

const first = '# 合成新路径参考稿 v1\n仅供参考，未创建医院业务版本。\n参考基线：pathway:101／版本2。\n阶段：复评阶段。\n项目：核对复评计划。\n引用：documents:10:20，2025-10-20，合成病程：已记录复评计划。\n缺口：实际执行、检验和检查尚未支持。\n'
const second = '# 合成新路径参考稿 v2\n仅供参考，未创建医院业务版本。\n参考基线：pathway:101／版本2。\n阶段：复评阶段。\n项目：由临床负责人复核复评计划。\n引用：documents:10:20，2025-10-20，合成病程：已记录复评计划。\n缺口：实际执行、检验和检查尚未支持。\n前后对照：v1“核对复评计划”→v2“由临床负责人复核复评计划”。\n修改来源：用户明确提出措辞调整；阶段、引用和资料缺口保持不变。\n'
const switched = '# 第二目标参考分析\n目标：pathway:202／版本2，合成第二路径。\n阶段：第二路径阶段。\n仅引用本次pathway_read返回的202定义；未把101目标的病例引用视作202的依据。\n这是参考分析，未修改医院系统。\n'
const revisionRequest = '请只把参考稿项目“核对复评计划”改成“由临床负责人复核复评计划”，阶段、引用和资料缺口保持不变；保存 reference-v2.md，并说明前后对照。'
const switchRequest = '现在切换到另一目标 pathwayId 202，重新读取它的定义并保存 target-202.md，不把 101 的病例依据当成新目标的依据。'

class RevisionModel extends LlmAdapter {
  private step = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const messages = JSON.stringify(options.messages)
    const script = [
      { name: 'pathway_read', args: { pathwayId: '101' } },
      { name: 'case_read', args: { inpatId: '123', category: 'documents', recordId: '10', contentId: '20' } },
      { name: 'write', args: { file_path: 'reference-v1.md', content: first } },
      { text: '已生成并保存合成新路径参考稿 v1，引用 pathway:101 与 documents:10:20；仅供参考，未创建医院业务草案。' },
      { name: 'read', args: { file_path: 'reference-v1.md' } },
      { name: 'write', args: { file_path: 'reference-v2.md', content: second } },
      { text: '参考稿 v2 已保存：项目由“核对复评计划”改为“由临床负责人复核复评计划”；阶段、documents:10:20 引用和资料缺口均保持不变。未写入医院系统。' },
      { name: 'pathway_read', args: { pathwayId: '202' } },
      { name: 'write', args: { file_path: 'target-202.md', content: switched } },
      { text: '第二目标 202 已重新读取并保存独立参考分析，阶段为“第二路径阶段”；101 的病例引用未用作 202 的依据。' },
    ]
    const index = this.step++
    const entry = script[index]
    if (entry === undefined) throw new Error('Revision model script exhausted')
    if (index === 2 && !messages.includes('合成病程：已记录复评计划。')) throw new Error('First reference draft lacks read evidence')
    if (index >= 4 && !messages.includes(revisionRequest)) throw new Error('Revision lacks the explicit user change request')
    if (index >= 7 && !messages.includes(switchRequest)) throw new Error('Target switch lacks its user request')
    if (index === 8 && !messages.includes('synthetic-other-pathway')) throw new Error('Switched analysis lacks freshly queried target evidence')
    if ('name' in entry && entry.name !== undefined) {
      const id = ToolCallId(`pathway-revision-${String(index + 1)}`)
      const args = JSON.stringify(entry.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: entry.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: entry.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const text = entry.text ?? ''
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/** Queue explicit synthetic user replies after the assistant response, outside Session publication. */
export async function apply(ctx: Context): Promise<void> {
  await mountGatewayFixture(ctx, { scriptModel: false, saveRequests: true })
  ctx.effect(() => ctx.llm.registerAdapter(['pathway-revision-fixture'], new RevisionModel()))
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const task = turn === 1 ? revisionRequest : turn === 2 ? switchRequest : undefined
    if (task === undefined) return
    agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  })
}

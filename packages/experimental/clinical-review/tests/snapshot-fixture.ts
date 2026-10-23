/** Synthetic evidence and optional scripted model for real-profile review regression tests. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { EncounterReader, parseBinding, parseSnapshot, type ClinicalActor, type EncounterBinding } from '@deepseek-ai/dsh-experimental-emr-encounter'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { ClinicalReviewService } from '../src/state.ts'
import { reviewProjection } from '../src/projection.ts'
import { registerReviewTools } from '../src/tools.ts'
import { Config as ReviewConfig } from '../src/config.ts'

export const name = 'clinical-review-snapshot-fixture'
export const inject = ['agents', 'sessions', 'sessionProjections', 'tools', 'llm']
export const Config = z.object({ scriptModel: z.boolean().default(false) })

const binding = parseBinding({ schemaVersion: 1, bindingId: '11111111-1111-4111-8111-111111111111', actorId: 'synthetic-actor',
  actorIssuer: 'https://synthetic.example', actorSubject: 'synthetic-doctor', sourceSystem: 'synthetic-emr', hospitalCode: '1001', inpatId: '123' })
const content = 'Clinical diagnosis: pneumonia.\nDischarge summary: no pneumonia.\n'
const digest = createHash('sha256').update(content).digest('hex')
const snapshot = parseSnapshot({ schemaVersion: 1, bindingId: binding.bindingId, caseRevision: digest, providerRevision: 'synthetic-v1',
  capturedAt: '2026-10-22T00:00:00.000Z', cutoff: '2026-10-22T00:00:00.000Z',
  sources: [{ sourceRef: 'synthetic-document-1', category: 'documents', sourceId: 'synthetic-document-1', sourceRevision: digest,
    state: 'signed', content, contentDigest: digest }],
  coverage: ['encounter', 'diagnoses', 'orders', 'documents', 'labs', 'checks', 'operations', 'administration'].map(category => ({ category, status: category === 'documents' ? 'complete' : 'unsupported' })) })

class SyntheticReader extends EncounterReader {
  override capture(actor: ClinicalActor, requested: EncounterBinding, signal: AbortSignal) {
    signal.throwIfAborted()
    if (actor.id !== binding.actorId || requested.bindingId !== binding.bindingId) throw new Error('fixture encounter authorization rejected')
    return Promise.resolve(snapshot)
  }
}

class ScriptedModel extends LlmAdapter {
  private step = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const calls = [
      { name: 'review_load_case', args: {} },
      { name: 'review_submit_findings', args: { revision: 1, caseRevision: digest, summary: '尚需读取原文后确认。',
        reviewedSourceRefs: ['synthetic-document-1'], findings: [] } },
      { name: 'review_read_evidence', args: { revision: 1, sourceRef: 'synthetic-document-1', start: 0, length: 2000 } },
      { name: 'review_submit_findings', args: { revision: 1, caseRevision: digest, summary: '出院小结与临床诊断的描述不一致，需要医生核实。',
        reviewedSourceRefs: ['synthetic-document-1'], findings: [{ kind: 'inconsistency', title: '肺炎描述不一致',
          explanation: '临床诊断记录肺炎，出院小结写无肺炎。', suggestion: '请核对原始病程与出院小结，确认准确表述。',
          citations: ['pneumonia', 'no pneumonia'].map(quote => ({ sourceRef: 'synthetic-document-1', start: content.indexOf(quote), end: content.indexOf(quote) + quote.length, quote })) }] } },
      { name: 'review_get_report', args: {} },
    ]
    const step = this.step++
    const call = calls[step]
    if (call !== undefined) {
      const id = ToolCallId(`clinical-fixture-${String(step + 1)}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (step !== calls.length) throw new Error('fixture model script exhausted')
    const text = '核查已完成：发现出院小结与临床诊断描述不一致，待医生核实；不影响出院。DRG、DIP 预分组暂不可用。'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Mount synthetic external inputs around the production review service and scoped tools. */
export function apply(ctx: Context, config: { scriptModel: boolean }): void {
  new SyntheticReader(ctx)
  ctx.sessionProjections.register(reviewProjection)
  const settings = ReviewConfig({ brokerBaseUrl: 'https://synthetic.example/runtime/emr/', runtimeTokenEnv: 'SYNTHETIC_UNUSED_TOKEN', ownerId: binding.actorId, cwd: process.cwd(), readerMode: 'provided' })
  const review = new ClinicalReviewService(ctx, settings, { authorize: () => Promise.reject(new Error('fixture has no browser launch issuer')) }, () => {})
  ctx.provide('clinicalReview', review)
  if (config.scriptModel) ctx.llm.registerAdapter(['clinical-fixture'], new ScriptedModel())
  ctx.on('agent/created', async ({ agent }) => {
    if (!ctx.agents.roots().includes(agent)) return
    appendPluginRecord(agent.session, 'plugin:clinical-review/state', {
      schemaVersion: 1, ownerSessionId: agent.id, caseRef: 'synthetic-case', binding, revision: 1, status: 'reviewing', snapshot,
      report: null, history: [], readRanges: [], operations: [{ eventId: 'synthetic-review', trigger: 'manual-review', status: 'dispatched', revision: 1 }],
    })
    await ctx.sessions.flush(agent.session)
    const dispose = registerReviewTools(agent.ctx, agent, review, settings)
    ctx.effect(() => dispose)
  })
}

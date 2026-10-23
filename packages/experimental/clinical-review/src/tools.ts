/** Scoped model tools expose evidence and proposals without patient selectors or clinical writes. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ClinicalReviewService } from './state.ts'
import { ClinicalReviewError } from './error.ts'
import { findingSchema } from './projection.ts'
import type { Config } from './config.ts'

const output = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text } as const],
} as const

function owner(agent: Agent | undefined, expected: Agent): Agent {
  if (agent !== expected) throw new ClinicalReviewError('forbidden', 'Clinical tools require their exact authorized encounter Session.')
  return agent
}

/** Register only inside one bound Agent scope; ordinary chat tools and prompts remain unchanged.
 * @param ctx - Exact Agent context.
 * @param agent - Owning Agent.
 * @param review - Session service.
 * @param config - Output and passage limits.
 * @returns The disposer for all tools installed on this Agent.
 */
export function registerReviewTools(ctx: Context, agent: Agent, review: ClinicalReviewService, config: Config): () => void {
  const disposers: (() => void)[] = []
  disposers.push(ctx.tools.register(defineTool({
    name: 'review_load_case', description: 'Read the current authorized encounter evidence inventory, revision, capture time, and explicit coverage gaps. Read relevant original sources before proposing findings. No patient selector is accepted.',
    parameters: { offset: { type: 'integer', description: 'Source inventory offset; omit for the first page. Follow nextOffset to inspect every source.' },
      revision: { type: 'integer', description: 'Required for later pages; use the first page review revision.' } }, output,
    execute: async (args, exec) => ({ text: await review.load(owner(exec.agent, agent), exec.signal, args.offset, args.revision) }),
    presentCall: () => ({ card: 'generic', title: '查看本次住院资料', kind: 'read' }),
  })))
  disposers.push(ctx.tools.register(defineTool({
    name: 'review_read_evidence', description: `Read original evidence from the current accepted snapshot. Offsets use UTF-16 code units; follow nextOffset until the source is complete. Length must not exceed ${String(config.maxSourceChars)}. Orders and planned treatment do not prove actual execution.`,
    parameters: {
      revision: { type: 'integer', required: true, description: 'Current review revision returned by review_load_case.' },
      sourceRef: { type: 'string', required: true, description: 'Exact sourceRef from this Session inventory.' },
      start: { type: 'integer', required: true, description: 'Start offset; zero for the first passage.' },
      length: { type: 'integer', required: true, description: 'Maximum UTF-16 code units to read.' },
    }, output,
    execute: async (args, exec) => ({
      text: await review.read(owner(exec.agent, agent), args.revision, args.sourceRef, args.start, args.length, exec.signal),
    }),
    presentCall: args => ({ card: 'generic', title: '阅读病历原文', kind: 'read', rawInput: args }),
  })))
  disposers.push(ctx.tools.register(defineTool({
    name: 'review_submit_findings', description: 'Save a pre-discharge clinical record review for a physician, with exact quotations from evidence already read. State the reviewed scope, explain each discrepancy or missing item in clinical language, and suggest what the physician should verify. Keep technical identifiers and offsets in citation fields, not in the summary or finding prose. Distinguish inconsistency, missing information, and items needing verification. Empty/unread coverage is not a clinical absence. Mark a source fully reviewed only after reading all of it. All findings remain pending human review; no discharge block, clinical write, DRG/DIP group, score, or payment decision is made.',
    parameters: {
      revision: { type: 'integer', required: true }, caseRevision: { type: 'string', required: true },
      summary: { type: 'string', required: true, description: 'Concise physician-facing conclusion and reviewed scope, with any material coverage limits.' },
      reviewedSourceRefs: { type: 'array', required: true, items: { type: 'string' } },
      findings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, enum: ['inconsistency', 'missing-information', 'needs-verification'] },
        title: { type: 'string', required: true, description: 'Short clinical issue the physician can recognize.' },
        explanation: { type: 'string', required: true, description: 'Explain the discrepancy, missing information, or uncertainty using the cited evidence.' },
        suggestion: { type: 'string', required: true, description: 'What the physician should verify or clarify; never autonomously add a diagnosis.' },
        citations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          sourceRef: { type: 'string', required: true }, start: { type: 'integer', required: true }, end: { type: 'integer', required: true }, quote: { type: 'string', required: true },
        } } },
      } } },
    }, output,
    execute: async (args, exec) => ({ text: await review.submit(owner(exec.agent, agent), {
      ...args, findings: args.findings.map(finding => findingSchema.parse(finding)),
    }, exec.signal) }),
    presentCall: args => ({ card: 'generic', title: '保存出院前核查结果', kind: 'other', rawInput: args }),
  })))
  disposers.push(ctx.tools.register(defineTool({
    name: 'review_get_report', description: 'Read the current pre-discharge clinical record review and explicit unreviewed coverage. Explain the key findings to the physician in clinical language; do not dump internal identifiers or execution details. DRG and DIP calculation are unavailable; findings require clinician review and never block discharge.',
    parameters: {}, output,
    execute: async (_args, exec) => ({ text: await review.report(owner(exec.agent, agent), exec.signal) }),
    presentCall: () => ({ card: 'generic', title: '查看病历核查结果', kind: 'read' }),
  })))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

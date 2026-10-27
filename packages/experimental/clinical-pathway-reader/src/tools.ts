/** Three scoped read tools return canonical, logged evidence for reference-only analysis. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'
import type { PathwayAccess } from './access.ts'
import { caseRequestSchema, historyRequestSchema, pathwayRequestSchema } from './protocol.ts'

const selection = {
  hospitalCode: { type: 'string', description: 'Optional authorized hospital code; omit only when the account has one hospital grant.' },
  departmentCodes: { type: 'array', items: { type: 'string' }, description: 'Optional subset of authorized department codes.' },
  offset: { type: 'integer', description: 'Row offset, starting at zero. Pages are separate read snapshots.' },
  limit: { type: 'integer', description: 'Requested page size, 1–100, further bounded by deployment limits.' },
} as const
const output = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) } as const],
} as const

/**
 * Register read capabilities only in the mounted pathway preset scope.
 * @param ctx - Preset-owned scoped context, never the root profile.
 * @param access - Current authenticated gateway client.
 */
export function registerPathwayTools(ctx: Context, access: PathwayAccess): void {
  const tools = ctx.get('tools')
  const key = scopeOf(ctx)
  if (tools === undefined || key === undefined) throw new Error('clinical-pathway-reader: mount tools inside the clinical pathway preset with the tools service')
  const admit = (agent: Agent | undefined): void => {
    if (agent === undefined || !scopeChainOf(scopeOf(agent.ctx)).includes(key)) throw new EncounterReadError('forbidden', 'These read tools require their owning pathway analysis session.')
  }
  ctx.effect(() => tools.register(defineTool({
    name: 'pathway_read',
    description: 'Search authorized pathway definitions or read an exact pathwayId with diagnoses, admission criteria, ordered nodes, branches and supported items. Search returns candidates; use their exact ID to expand. State/version and coverage are source evidence. This never writes a pathway or creates a business draft.',
    parameters: { ...selection, pathwayId: { type: 'string' }, search: { type: 'string' }, pathwayCode: { type: 'string' }, versionNo: { type: 'string' } }, output,
    execute: (args, exec) => { admit(exec.agent); return access.read('pathway_read', pathwayRequestSchema.parse(args), exec.signal) },
    presentCall: args => ({ card: 'generic', title: 'pathway_read', kind: 'read', rawInput: args }),
  })), 'clinical-pathway-reader: pathway_read')
  ctx.effect(() => tools.register(defineTool({
    name: 'history_query',
    description: 'Analyze a bounded historical cohort or list its encounters. Supply an explicit time basis and offset-aware ISO window [from,to). Summary counts cover the whole filtered cohort, not just one page. Distinguish admissions, execution records, source statuses and currently retained reasons. Source completion does not establish clinical task completion. Never-enrolled comparisons need their own admission/discharge window. This is read-only reference evidence.',
    parameters: { ...selection, from: { type: 'string', required: true }, to: { type: 'string', required: true },
      timeBasis: { type: 'string', enum: ['admission', 'discharge', 'execution'], required: true },
      mode: { type: 'string', enum: ['cohort', 'summary'] }, pathwayId: { type: 'string' },
      diagnosisCode: { type: 'string' }, diagnosisSystem: { type: 'string', enum: ['hospital', 'icd'] },
      diagnosisType: { type: 'string', enum: ['10', '14', '31'] }, mainDiagnosisOnly: { type: 'boolean' },
      executionStatus: { type: 'string', enum: ['0', '1', '2', '3', '4'] },
    }, output,
    execute: (args, exec) => { admit(exec.agent); return access.read('history_query', historyRequestSchema.parse(args), exec.signal) },
    presentCall: args => ({ card: 'generic', title: 'history_query', kind: 'search', rawInput: args }),
  })), 'clinical-pathway-reader: history_query')
  ctx.effect(() => tools.register(defineTool({
    name: 'case_read',
    description: 'Read one authorized historical encounter category: encounter, diagnoses, orders or persisted document text. Documents without recordId/contentId return an inventory; select an exact record/content to read bounded passages, following nextStart and nextOffset. Missing text is unreadable, not an absent document. Labs, checks, operations and administration are unsupported. Orders and source status do not prove actual execution. This never modifies records.',
    parameters: { ...selection, inpatId: { type: 'string', required: true },
      category: { type: 'string', enum: ['encounter', 'diagnoses', 'orders', 'documents'], required: true },
      recordId: { type: 'string' }, contentId: { type: 'string' }, start: { type: 'integer' }, length: { type: 'integer' },
    }, output,
    execute: (args, exec) => { admit(exec.agent); return access.read('case_read', caseRequestSchema.parse(args), exec.signal) },
    presentCall: args => ({ card: 'generic', title: 'case_read', kind: 'read', rawInput: args }),
  })), 'clinical-pathway-reader: case_read')
}

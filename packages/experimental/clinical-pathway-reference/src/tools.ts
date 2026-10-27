/** Preset-local reference primitives log every model-visible read and saved change as normal tool results. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { commitRequestSchema, createRequestSchema, undoRequestSchema } from './protocol.ts'
import { ReferenceError } from './error.ts'
import type { ReferenceService } from './state.ts'

/**
 * Register the owning Session's model-visible reference tool.
 * @param ctx - Exact Agent scope.
 * @param agent - Owning Session.
 * @param service - Session state owner.
 * @returns Reversible tool registration.
 */
export function registerTools(ctx: Context, agent: Agent, service: ReferenceService): () => void {
  return ctx.tools.register(defineTool({
    name: 'pathway_reference',
    description: 'Manage this Session’s private structured clinical pathway reference only. Read before changing. Create uses the configured scope and an exact logged pathway_read event for revision mode; new mode starts unknown clinical fields. For commit, send the complete EMR definition, current baseRevision and unique requestId after the user asks for the change; it is saved atomically. Preserve localId identities, every unrelated field, evidence and null unknowns. Locks cannot be changed by the model. Undo targets a saved revision and preserves independent later changes. This never writes hospital data and does not provide EMR manual editing. Payload is JSON for the chosen operation; omit it for read.',
    parameters: { action: { type: 'string', required: true, enum: ['read', 'create', 'commit', 'undo'] },
      payload: { type: 'string', description: 'JSON request fields, excluding sessionId. Create: requestId,mode,title,scope,sourceEventSeq?. Commit: requestId,baseRevision,definition,metadata?. Undo: requestId,baseRevision,revision.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, result: { text: string }) => [{ type: 'text', text: result.text } as const] },
    execute: async (args, exec) => {
      if (exec.agent !== agent || !service.ownsPreset(agent)) throw new ReferenceError('forbidden', 'This tool requires its owning clinical pathway Session.')
      exec.signal.throwIfAborted()
      if (Buffer.byteLength(args.payload ?? '') > service.config.maxRequestBytes) throw new ReferenceError('limit-exceeded', 'The reference change exceeds its configured limit.')
      if (args.action === 'read') return { text: JSON.stringify({ ...await service.read(agent.id), config: service.config }) }
      const value: unknown = JSON.parse(args.payload ?? '{}')
      if (value === null || typeof value !== 'object' || Array.isArray(value) || 'sessionId' in value) throw new ReferenceError('invalid-request', 'Send an object without sessionId.')
      const request = { ...value, sessionId: agent.id }
      const result = args.action === 'create' ? await service.create(createRequestSchema.parse(request))
        : args.action === 'commit' ? await service.commit(commitRequestSchema.parse(request), true)
          : await service.undo(undoRequestSchema.parse(request), true)
      return { text: JSON.stringify(result) }
    },
    presentCall: args => ({ card: 'generic', title: 'pathway_reference', kind: args.action === 'read' ? 'read' : 'other', rawInput: args }),
  }))
}

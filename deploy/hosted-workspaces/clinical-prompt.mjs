/** Remove Harness-development orientation from the clinical preset's model input. */

/** Cordis plugin identity. */
export const name = 'clinical-prompt'
/** Prompt contributions remain scoped to the declaring clinical preset. */
export const inject = ['systemPrompt']

/**
 * Shadow development-only sections and context while retaining tool instructions.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Clinical preset scope.
 */
export function apply(ctx) {
  for (const [name, section, context] of [
    ['harness:source', 'HARNESS_SOURCE', 'HARNESS_SOURCE'],
    ['app:web-surface', 'WEB_SURFACE', 'WEB_SURFACE'],
  ]) {
    ctx.effect(() => ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder(section), text: '' }))
    ctx.effect(() => ctx.systemPrompt.context({ name, order: ctx.systemPrompt.getContextOrder(context), text: '' }))
  }
}

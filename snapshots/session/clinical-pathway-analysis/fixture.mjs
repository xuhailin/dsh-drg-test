/** Activate the shipped clinical-pathway preset for keyless headless replay. */
import { fileURLToPath } from 'node:url'
import { generateClinicalPathwayPreset } from '../../../deploy/hosted-workspaces/company-presets.mjs'

export const name = 'clinical-pathway-snapshot-fixture'
export const inject = ['agents', 'agentPresets', 'tools']

/** Register the production declaration and bind the root Session before its first turn. */
export async function apply(ctx) {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const preset = generateClinicalPathwayPreset(root)
  const dispose = await ctx.agentPresets.register(preset.config)
  ctx.effect(() => dispose)
  ctx.on('agent/pre-step', async (_payload, next) => {
    // This isolated subprocess fixes only the request-preparation clock, before model execution.
    const now = Date.now
    Date.now = () => 1792700000000
    try { return await next() }
    finally { Date.now = now }
  }, { prepend: true })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== undefined) return
    await ctx.agentPresets.select(agent, preset.config.id)
    const tools = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
    for (const name of ['read', 'grep', 'web_search', process.platform === 'win32' ? 'pwsh' : 'bash']) {
      if (!tools.has(name)) throw new Error(`Clinical pathway preset lost ${name}`)
    }
    if (tools.has('exit_plan_mode') || [...tools].some(name => name.startsWith('review_'))) {
      throw new Error('Clinical pathway composition inherited coding or encounter-review tools')
    }
  }, { prepend: true })
}

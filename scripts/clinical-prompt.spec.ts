/** Clinical prompt isolation over the real Harness-development context provider. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { mountAgentLoopTestDependencies } from '../packages/test-support/agent-loop-testkit/src/index.ts'
import { createScope } from '../packages/core/scope/src/index.ts'
import { renderPrompt, renderContextSnapshot } from '../packages/core/system-prompt/src/index.ts'
import * as HarnessDevContext from '../packages/context/harness-dev-context/src/index.ts'
import * as ClinicalPrompt from '../deploy/hosted-workspaces/clinical-prompt.mjs'

it('removes only development sections and paths for the clinical scope and restores them on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('webApp', { getAdvertisedUrl: () => 'http://127.0.0.1:3080/' } satisfies Context['webApp'])
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(HarnessDevContext)
  ctx.systemPrompt.section({ name: 'clinical-test:tool-guidance', order: 500, text: 'Read exact original evidence before citing it.' })
  ctx.systemPrompt.context({ name: 'clinical-test:required', order: 500, text: 'Required execution policy.', required: true })
  const key = {}, scoped = createScope(ctx, key)
  const policy = await scoped.ctx.plugin(ClinicalPrompt)
  const clinical = await ctx.systemPrompt.assemble({ scope: key })
  const text = renderPrompt(clinical) + renderContextSnapshot(clinical)
  for (const coding of ['implementation checkout', 'pnpm run dev:web', 'client-plugin HMR', 'window.__DSH_BOOT__']) {
    expect(text).not.toContain(coding)
  }
  expect(text).toContain('Read exact original evidence before citing it.')
  expect(text).toContain('Required execution policy.')
  expect(clinical.contexts.filter(row => row.name === 'harness:source' || row.name === 'app:web-surface').map(row => row.text))
    .toEqual(['', ''])
  expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('pnpm run dev:web')
  await policy.dispose()
  const restored = await ctx.systemPrompt.assemble({ scope: key })
  expect(renderPrompt(restored)).toContain('pnpm run dev:web')
  expect(renderContextSnapshot(restored)).toContain('Current DeepSeek Harness implementation checkout')
})

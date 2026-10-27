/** Role-specific configuration fails before opening source files or registering tools. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { Config, apply } from '../src/index.ts'

it.each([
  {},
  { databaseConfigFile: 'synthetic-unused.json' },
  { databaseConfigFile: 'synthetic-unused.json', policyFile: 'synthetic-unused-policy.json' },
])('rejects an incomplete gateway role before reading operator files: %j', (fields) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return expect(apply(ctx, Config({ mode: 'gateway', ...fields })))
    .rejects.toThrow('gateway mode requires databaseConfigFile, policyFile and sourceSystem')
})

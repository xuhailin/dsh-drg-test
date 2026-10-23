import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dump, load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '../packages/compaction/compaction-basic/src/config.ts'
import { generateCompanyPresets } from '../deploy/hosted-workspaces/company-presets.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = join(root, 'deploy/hosted-workspaces/company-presets.mjs')
const policyPath = 'deploy/hosted-workspaces/company-model.runtime.patch.yml'
const presetPath = (name: string): string => `packages/bundle/web-app/presets/${name}.patch.yml`
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected fixture row')
  return value as Record<string, unknown>
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected fixture list')
  return value
}

function walk(rows: readonly unknown[]): Record<string, unknown>[] {
  return rows.flatMap((value) => {
    const row = record(value)
    return [row, ...row.group === true ? walk(list(row.config)) : []]
  })
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-company-presets-'))
  directories.push(directory)
  for (const path of [policyPath, ...['minimal', 'standard', 'ptc', 'cordis'].map(presetPath)]) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), readFileSync(join(root, path)))
  }
  return directory
}

it('patches all active preset services and preserves every other plugin and deferred expression', () => {
  const generated = generateCompanyPresets(root)
  expect(generated.map(row => row.id)).toEqual(['preset-minimal', 'preset-standard', 'preset-ptc', 'preset-cordis'])
  for (const patch of generated) {
    const source: unknown = load(readFileSync(join(root, presetPath(patch.config.id)), 'utf8'), { schema: entryListSchema })
    const original = record(list(record(list(source)[0]).insert)[0])
    const expected = structuredClone(patch.config)
    const service = walk(expected.plugins).find(row => row.id === 'compaction-basic')!
    expect(service.config).toMatchObject({ modelPolicies: [{ provider: 'company-gateway', model: { __jsExpr: 'process.env.HOSTED_MODEL_ID' }, headroomTokens: 4096, maxTokens: 4096, retainTokens: 4096 }] })
    delete service.config
    expect(expected).toEqual(original.config)
  }
})

it('resolves legal pressure budgets for both deployed model capacities', () => {
  for (const patch of generateCompanyPresets(root)) {
    const raw = walk(patch.config.plugins).find(row => row.id === 'compaction-basic')!.config
    const interpolated: unknown = interpolate({ process: { env: { HOSTED_MODEL_ID: 'gpt-5.5' } } }, raw)
    const config = resolveConfig(BasicCompactionEngine.Config(interpolated as BasicCompactionConfig))
    const policy = resolveTargetPolicy(config, { provider: 'company-gateway', model: 'gpt-5.5' })
    expect(config.auto).toBe(true)
    expect(resolveCompactSpec(policy, 32768, 8192)).toMatchObject({ thresholdTokens: 20480, retainTokens: 4096, maxTokens: 4096 })
    expect(resolveCompactSpec(policy, 65536, 32768)).toMatchObject({ thresholdTokens: 28672, retainTokens: 4096, maxTokens: 4096 })
  }
})

it('fails when a canonical preset loses its compaction target', () => {
  const directory = fixture()
  const path = join(directory, presetPath('standard'))
  writeFileSync(path, readFileSync(path, 'utf8').replace('id: compaction-basic', 'id: removed-compaction'))
  expect(() => generateCompanyPresets(directory)).toThrow(/patch.*not found/)
})

it('fails when the company overlay omits the policy', () => {
  const directory = fixture()
  writeFileSync(join(directory, policyPath), '[]\n')
  expect(() => generateCompanyPresets(directory)).toThrow(/Expected one compaction-basic entry/)
})

it('preserves user preset tools, settings, and custom entries before applying the company policy', () => {
  const directory = fixture()
  const baseline = generateCompanyPresets(directory)
  const standard = structuredClone(baseline.find(row => row.id === 'preset-standard')!)
  const tool = walk(standard.config.plugins).find(row => row.id === 'tool-bash')!
  tool.disabled = true
  tool.config = { timeoutMs: 1234 }
  const config = {
    ...standard.config,
    name: 'Custom review preset',
    plugins: [...standard.config.plugins, {
      id: 'custom-tool', name: '@example/custom-tool',
      config: { token: { __jsExpr: 'process.env.CUSTOM_TOOL_TOKEN' } },
    }],
  }
  const compaction = walk(config.plugins).find(row => row.id === 'compaction-basic')!
  compaction.config = { headroomTokens: 65536 }
  const profile = join(directory, 'profile.patch.yml')
  writeFileSync(profile, dump([
    { id: 'preset-standard', config },
    { id: 'unrelated-service', config: { enabled: false } },
    { insert: [{ id: 'unrelated-custom-service', name: '@example/host' }] },
  ], { schema: entryListSchema }))
  const actual = generateCompanyPresets(directory, profile)
  const updated = actual.find(row => row.id === 'preset-standard')!
  const expected = structuredClone(config)
  delete walk(expected.plugins).find(row => row.id === 'compaction-basic')!.config
  const withoutPolicy = structuredClone(updated.config)
  delete walk(withoutPolicy.plugins).find(row => row.id === 'compaction-basic')!.config
  expect(withoutPolicy).toEqual(expected)
  expect(walk(updated.config.plugins).find(row => row.id === 'compaction-basic')!.config)
    .toMatchObject({ modelPolicies: [{ provider: 'company-gateway', headroomTokens: 4096 }] })
  expect(actual.filter(row => row.id !== 'preset-standard')).toEqual(baseline.filter(row => row.id !== 'preset-standard'))
})

it('ignores unrelated profile patches and treats a missing profile as an empty layer', () => {
  const directory = fixture()
  const baseline = generateCompanyPresets(directory)
  const profile = join(directory, 'profile.patch.yml')
  expect(generateCompanyPresets(directory, profile)).toEqual(baseline)
  writeFileSync(profile, dump([{ id: 'unrelated-service', config: { value: { __jsExpr: 'throw new Error("must not evaluate")' } } }], { schema: entryListSchema }))
  expect(generateCompanyPresets(directory, profile)).toEqual(baseline)
})

it('writes a parseable overlay through the source CLI without evaluating model expressions', () => {
  const directory = fixture()
  const output = join(directory, 'generated.patch.yml')
  const profile = join(directory, 'profile.patch.yml')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', script, directory, output, profile], { encoding: 'utf8', cwd: root })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const text = readFileSync(output, 'utf8')
  const parsed: unknown = load(text, { schema: entryListSchema })
  expect(parsed).toEqual(generateCompanyPresets(directory))
  expect(text).toContain('!!js process.env.HOSTED_MODEL_ID')
})

it('leaves an existing output untouched when generation fails', () => {
  const directory = fixture()
  const output = join(directory, 'generated.patch.yml')
  writeFileSync(output, 'existing\n')
  writeFileSync(join(directory, policyPath), '{}\n')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', script, directory, output], { encoding: 'utf8', cwd: root })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Expected a YAML entry list')
  expect(readFileSync(output, 'utf8')).toBe('existing\n')
})

it('does not include malformed profile values in parse errors', () => {
  const directory = fixture()
  const profile = join(directory, 'profile.patch.yml')
  writeFileSync(profile, '- id: preset-standard\n  config: [private-test-value\n')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', script, directory, join(directory, 'output.yml'), profile], { encoding: 'utf8', cwd: root })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Invalid YAML entry list')
  expect(result.stderr).not.toContain('private-test-value')
})

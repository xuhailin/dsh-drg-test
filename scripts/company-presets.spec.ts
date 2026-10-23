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
import { generateClinicalPreset, generateCompanyPresets, requiresClinicalPreset } from '../deploy/hosted-workspaces/company-presets.mjs'

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
  for (const path of [policyPath, 'deploy/hosted-workspaces/clinical.preset.yml', 'deploy/hosted-workspaces/clinical-prompt.mjs',
    ...['minimal', 'standard', 'ptc', 'cordis'].map(presetPath)]) {
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
  for (const patch of generateCompanyPresets(root, undefined, true)) {
    const raw = walk(patch.config.plugins).find(row => row.id === 'compaction-basic')!.config
    const interpolated: unknown = interpolate({ process: { env: { HOSTED_MODEL_ID: 'gpt-5.5' } } }, raw)
    const config = resolveConfig(BasicCompactionEngine.Config(interpolated as BasicCompactionConfig))
    const policy = resolveTargetPolicy(config, { provider: 'company-gateway', model: 'gpt-5.5' })
    expect(config.auto).toBe(true)
    expect(resolveCompactSpec(policy, 32768, 8192)).toMatchObject({ thresholdTokens: 20480, retainTokens: 4096, maxTokens: 4096 })
    expect(resolveCompactSpec(policy, 65536, 32768)).toMatchObject({ thresholdTokens: 28672, retainTokens: 4096, maxTokens: 4096 })
  }
})

it('keeps general tools and policies in an independent clinical composition without coding workflow plugins', () => {
  const original: unknown = load(readFileSync(join(root, presetPath('standard')), 'utf8'), { schema: entryListSchema })
  const standard = record(record(list(record(list(original)[0]).insert)[0]).config)
  const declaration = generateClinicalPreset(root)
  expect(declaration).toMatchObject({ id: 'preset-clinical-review', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'clinical-review', name: '医保助手' } })
  const plugins = structuredClone(declaration.config.plugins)
  const persona = walk(plugins).find(row => row.id === 'persona')!
  expect(record(persona.config).prefix).toContain('你是“医保助手”，面向临床医生')
  expect(record(persona.config).complete).not.toBe(true)
  expect(walk(plugins).some(row => ['agent-instructions', 'plan-mode', 'planning'].includes(String(row.id)))).toBe(false)
  const general = plugins.filter(row => !['persona', 'clinical-prompt'].includes(String(row.id)))
  expect(general).toEqual(list(standard.plugins).filter(value => !['persona', 'agent-instructions', 'planning'].includes(String(record(value).id))))
  expect(plugins.find(row => row.id === 'clinical-prompt')?.name).toBe(join(root, 'deploy/hosted-workspaces/clinical-prompt.mjs'))
})

it('keeps clinical profile edits before replacing only the company compaction policy', () => {
  const directory = fixture()
  const clinical = generateClinicalPreset(directory)
  const tool = walk(clinical.config.plugins).find(row => row.id === 'tool-web')!
  tool.config = { fetch: false, searchTimeoutMs: 1234 }
  const profile = join(directory, 'profile.patch.yml')
  writeFileSync(profile, dump([{ id: clinical.id, config: clinical.config }], { schema: entryListSchema }))
  expect(generateClinicalPreset(directory, profile)).toEqual(clinical)
  const company = generateCompanyPresets(directory, profile, true)
  expect(company).toHaveLength(5)
  const actual = company.find(row => row.id === clinical.id)!
  expect(walk(actual.config.plugins).find(row => row.id === 'tool-web')?.config).toEqual(tool.config)
  expect(walk(actual.config.plugins).find(row => row.id === 'compaction-basic')?.config)
    .toMatchObject({ modelPolicies: [{ provider: 'company-gateway', headroomTokens: 4096 }] })
})

it('keeps saved standard-preset edits separate from the clinical composition', () => {
  const directory = fixture()
  const clinical = generateClinicalPreset(directory)
  const profile = join(directory, 'profile.patch.yml')
  writeFileSync(profile, dump([{ id: 'preset-standard', config: { id: 'standard', plugins: [] } }], { schema: entryListSchema }))
  expect(generateClinicalPreset(directory, profile)).toEqual(clinical)
})

it('loads its own clinical configuration independently of the standard persona and fails on a missing clinical prompt row', () => {
  const directory = fixture()
  const path = join(directory, presetPath('standard'))
  writeFileSync(path, readFileSync(path, 'utf8').replace('id: persona', 'id: missing-persona'))
  expect(generateClinicalPreset(directory).config.name).toBe('医保助手')
  const clinical = join(directory, 'deploy/hosted-workspaces/clinical.preset.yml')
  writeFileSync(clinical, readFileSync(clinical, 'utf8').replace('id: clinical-prompt', 'id: missing-prompt'))
  expect(() => generateClinicalPreset(directory)).toThrow('Expected one clinical-prompt entry')
})

it('detects clinical preset use from plugin rows and groups without evaluating deferred expressions', () => {
  expect(requiresClinicalPreset(join(root, 'deploy/hosted-workspaces/clinical.runtime.patch.yml'))).toBe(true)
  const directory = fixture()
  const runtime = join(directory, 'runtime.patch.yml')
  writeFileSync(runtime, dump([{ insert: [{ name: 'cordis:group', group: true, config: [{
    name: '@deepseek-ai/dsh-experimental-clinical-review',
    config: { agentPreset: 'clinical-review', ownerId: { __jsExpr: 'throw new Error("must not evaluate")' } },
  }] }] }], { schema: entryListSchema }))
  expect(requiresClinicalPreset(runtime)).toBe(true)
  writeFileSync(runtime, '- insert:\n  - name: unrelated-plugin\n    config: {}\n')
  expect(requiresClinicalPreset(runtime)).toBe(false)
  writeFileSync(runtime, '- insert:\n  - name: "@deepseek-ai/dsh-experimental-clinical-review"\n    disabled: true\n    config:\n      agentPreset: clinical-review\n')
  expect(requiresClinicalPreset(runtime)).toBe(false)
  writeFileSync(runtime, '- insert:\n  - name: "@deepseek-ai/dsh-experimental-clinical-review"\n    config: {}\n')
  expect(requiresClinicalPreset(runtime)).toBe(false)
  writeFileSync(runtime, '- insert:\n  - name: "@deepseek-ai/dsh-experimental-clinical-review"\n    config:\n      agentPreset: !!js process.env.PRESET\n')
  expect(() => requiresClinicalPreset(runtime)).toThrow('requires a literal agentPreset')
  writeFileSync(runtime, '- insert: invalid\n')
  expect(() => requiresClinicalPreset(runtime)).toThrow('Expected runtime overlay insert list')
  writeFileSync(runtime, '- invalid\n')
  expect(() => requiresClinicalPreset(runtime)).toThrow('Invalid runtime overlay row')
  writeFileSync(runtime, '- unexpected: invalid\n')
  expect(() => requiresClinicalPreset(runtime)).toThrow('Invalid runtime overlay row')
})

it('writes the clinical declaration and its matching company override through the source CLIs', () => {
  const directory = fixture()
  const profile = join(directory, 'profile.patch.yml')
  const output = join(directory, 'clinical.patch.yml')
  const clinicalScript = join(root, 'deploy/hosted-workspaces/clinical-presets.mjs')
  const clinical = spawnSync(process.execPath, [clinicalScript, directory, output, profile], { encoding: 'utf8', cwd: root })
  expect(clinical.signal).toBe(null)
  expect(clinical.stderr).toBe('')
  expect(clinical.status).toBe(0)
  expect(load(readFileSync(output, 'utf8'), { schema: entryListSchema })).toEqual([{ insert: [generateClinicalPreset(directory)] }])
  const company = spawnSync(process.execPath, [script, directory, output, profile, '--clinical-review'], { encoding: 'utf8', cwd: root })
  expect(company.signal).toBe(null)
  expect(company.stderr).toBe('')
  expect(company.status).toBe(0)
  expect(load(readFileSync(output, 'utf8'), { schema: entryListSchema })).toEqual(generateCompanyPresets(directory, undefined, true))
  const detection = spawnSync(process.execPath, [clinicalScript, '--required', join(root, 'deploy/hosted-workspaces/clinical.runtime.patch.yml')], { encoding: 'utf8', cwd: root })
  expect(detection.signal).toBe(null)
  expect(detection.status).toBe(0)
  expect(detection.stdout).toBe('true\n')
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

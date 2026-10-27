/** Deployment launcher layering against the actual generated preset patches. */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

const root = resolve(import.meta.dirname, '..')

it.each([
  { mode: 'none', company: false }, { mode: 'none', company: true },
  { mode: 'clinical', company: false }, { mode: 'clinical', company: true },
  { mode: 'pathway', company: false }, { mode: 'pathway', company: true },
  { mode: 'combined', company: false }, { mode: 'combined', company: true },
  { mode: 'custom', company: false }, { mode: 'custom', company: true },
])('scopes pathway reader opt-in to its selected runtime overlay ($mode) with company models=$company', ({ mode, company }) => {
  const clinical = mode === 'clinical' || mode === 'combined'
  const pathway = mode === 'pathway' || mode === 'combined'
  const directory = mkdtempSync(join(tmpdir(), 'hosted-composition-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const bin = join(directory, 'bin'), workspace = join(directory, 'workspace'), home = join(directory, 'home')
  mkdirSync(bin)
  mkdirSync(workspace)
  const customPatch = join(directory, 'custom.runtime.patch.yml')
  writeFileSync(customPatch, '[]\n')
  const runtimeName = mode === 'combined' ? 'clinical-with-pathway' : clinical ? 'clinical' : 'clinical-pathway'
  const runtimePatch = mode === 'none' ? '' : mode === 'custom' ? customPatch
    : join(root, `deploy/hosted-workspaces/${runtimeName}.runtime.patch.yml`)
  const launcher = join(directory, 'entrypoint.sh'), capture = join(directory, 'arguments.json')
  const script = readFileSync(join(root, 'deploy/hosted-workspaces/entrypoint.sh'), 'utf8')
    .replaceAll('/opt/dsh', root).replaceAll('/home/node/workspace', workspace).replaceAll('/tmp/dsh-', `${directory}/dsh-`)
  writeFileSync(launcher, script)
  const node = join(bin, 'node')
  writeFileSync(node, `#!${process.execPath}\n`
    + 'const {spawnSync}=require("node:child_process");const {writeFileSync}=require("node:fs");\n'
    + `const args=process.argv.slice(2);if(args[0]===${JSON.stringify(join(root, 'apps/cli/lib/bin.js'))}){\n`
    + `writeFileSync(${JSON.stringify(capture)},JSON.stringify(args.slice(1)));\n`
    + `}else{const child=spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'});if(child.error)throw child.error;process.exit(child.status??1)}\n`)
  chmodSync(node, 0o755)
  const result = spawnSync('sh', [launcher, 'runtime', '--no-browser'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, DSH_HOME: home,
      DSH_AGENTS_HOME: join(directory, 'agents'), HOSTED_BIND_IP: '127.0.0.1', HOSTED_PUBLIC_URL: 'http://127.0.0.1:3080/w/synthetic/',
      DSH_SHARED_RESOURCES_ROOT: '', HOSTED_MODEL_PROTOCOL: company ? 'openai-responses' : '',
      HOSTED_RUNTIME_GATEWAY_URL: 'http://gateway:3080', HOSTED_RUNTIME_API_KEY: 'synthetic-runtime-token',
      HOSTED_RUNTIME_PATCH_FILE: runtimePatch },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const args = JSON.parse(readFileSync(capture, 'utf8')) as string[]
  expect(args.slice(0, 2)).toEqual(['--profile', mode === 'none' ? 'web' : 'hosted'])
  const patches = args.flatMap((arg, index) => arg === '--patch' ? [args[index + 1]!] : [])
  expect(patches).toEqual([
    join(root, 'packages/bundle/synyi-web-app/cordis.patch.yml'),
    join(directory, 'dsh-pathway-presets.patch.yml'),
    ...clinical ? [join(directory, 'dsh-clinical-presets.patch.yml')] : [],
    ...company ? [join(root, 'deploy/hosted-workspaces/company-model.runtime.patch.yml'), join(directory, 'dsh-company-presets.patch.yml')] : [],
    ...mode === 'combined' ? [join(root, 'deploy/hosted-workspaces/clinical.runtime.patch.yml')] : [],
    ...runtimePatch ? [runtimePatch] : [],
  ])
  let rows: EntryOptions[] = []
  const web = JSON.parse(readFileSync(join(root, 'packages/bundle/web-app/package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }
  const base = [join(root, 'packages/bundle/base/cordis.patch.yml'),
    ...web.dsh.bundle.patch.map(path => join(root, 'packages/bundle/web-app', path))]
  for (const path of [...base, ...patches]) {
    rows = applyEntryPatches(rows, load(readFileSync(path, 'utf8'), { schema: entryListSchema }) as EntryOptions[], (message) => { throw new Error(message) })
  }
  expect(rows.find(row => row.id === 'ui-brand-official')?.disabled).toBe(true)
  expect(rows.find(row => row.id === 'ui-theme-synyi')?.name).toBe('@deepseek-ai/dsh-client-ui-theme-synyi')
  expect(rows.some(row => row.id === 'preset-clinical-review')).toBe(clinical)
  expect(rows.filter(row => row.id === 'preset-clinical-pathway-analysis')).toHaveLength(1)
  const presets = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
  for (const preset of presets) {
    const config = preset.config as PresetDefinition
    const readers = config.plugins.filter(row => row.id === 'pathway-reader')
    if (preset.id === 'preset-clinical-pathway-analysis') {
      expect(readers).toHaveLength(1)
      expect(readers[0]?.disabled).toBe(!pathway)
      expect(readers[0]?.config).toMatchObject({ mode: 'tools', runtimeTokenEnv: 'HOSTED_RUNTIME_API_KEY' })
    } else expect(readers).toHaveLength(0)
  }
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-clinical-pathway-reader')).toBe(false)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-clinical-pathway-reference')).toBe(pathway)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-clinical-review')).toBe(clinical)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-client-emr-entry')).toBe(clinical)
  expect(rows.some(row => row.name === '@deepseek-ai/dsh-experimental-client-clinical-results')).toBe(clinical)
  expect(args).toContain('http://127.0.0.1:3080/w/synthetic/')
})

it('retains both gateway overlays when the combined compose layer is selected last', () => {
  const compose = load(readFileSync(join(root, 'deploy/hosted-workspaces/compose.clinical-with-pathway.yml'), 'utf8'))
  expect(compose).toEqual({ services: { gateway: {
    command: ['gateway', '--patch', '/opt/dsh/deploy/hosted-workspaces/clinical.gateway.patch.yml',
      '--patch', '/opt/dsh/deploy/hosted-workspaces/clinical-pathway.gateway.patch.yml'],
    environment: { HOSTED_RUNTIME_PATCH_FILE: '/opt/dsh/deploy/hosted-workspaces/clinical-with-pathway.runtime.patch.yml' },
  } } })
  expect(JSON.stringify(load(readFileSync(join(root, 'deploy/hosted-workspaces/clinical-with-pathway.runtime.patch.yml'), 'utf8'),
    { schema: entryListSchema }))).toContain('@deepseek-ai/dsh-experimental-clinical-pathway-reference')
})

it('mounts pathway database and policy secrets only on its standalone gateway provider', () => {
  const compose = load(readFileSync(join(root, 'deploy/hosted-workspaces/compose.clinical-pathway.yml'), 'utf8')) as {
    services: Record<string, { command: string[]; environment: Record<string, string>; secrets: string[] }>
    secrets: Record<string, { file: string }>
  }
  expect(Object.keys(compose.services)).toEqual(['gateway'])
  const gateway = compose.services.gateway!
  expect(gateway.command).toEqual(['gateway', '--patch', '/opt/dsh/deploy/hosted-workspaces/clinical-pathway.gateway.patch.yml'])
  expect(gateway.environment.HOSTED_RUNTIME_PATCH_FILE).toBe('/opt/dsh/deploy/hosted-workspaces/clinical-pathway.runtime.patch.yml')
  expect(gateway.secrets).toEqual(['clinical_pathway_database', 'clinical_pathway_policy'])
  expect(Object.keys(compose.secrets)).toEqual(gateway.secrets)
  expect(gateway.environment.CLINICAL_PATHWAY_DATABASE_CONFIG_FILE).toBe('/run/secrets/clinical_pathway_database')
  expect(gateway.environment.CLINICAL_PATHWAY_POLICY_FILE).toBe('/run/secrets/clinical_pathway_policy')
  const patch = load(readFileSync(join(root, 'deploy/hosted-workspaces/clinical-pathway.gateway.patch.yml'), 'utf8'), { schema: entryListSchema })
  expect(patch).toEqual([{ insert: [{ id: 'clinical-pathway-reader-gateway', name: '@deepseek-ai/dsh-experimental-clinical-pathway-reader', config: {
    mode: 'gateway', sourceSystem: { __jsExpr: 'process.env.CLINICAL_PATHWAY_SOURCE_SYSTEM' },
    databaseConfigFile: { __jsExpr: 'process.env.CLINICAL_PATHWAY_DATABASE_CONFIG_FILE' },
    policyFile: { __jsExpr: 'process.env.CLINICAL_PATHWAY_POLICY_FILE' },
    schema: { __jsExpr: "process.env.CLINICAL_PATHWAY_SCHEMA || 'public'" },
    readRolePolicy: { __jsExpr: "process.env.CLINICAL_PATHWAY_READ_ROLE_POLICY || 'select-only'" },
    herbalTables: { __jsExpr: "process.env.CLINICAL_PATHWAY_HERBAL_TABLES === 'true'" },
    operationTables: { __jsExpr: "process.env.CLINICAL_PATHWAY_OPERATION_TABLES === 'true'" },
    dictionaryTables: { __jsExpr: "process.env.CLINICAL_PATHWAY_DICTIONARY_TABLES === 'true'" },
  } }] }])
  expect(JSON.stringify(load(readFileSync(join(root, 'deploy/hosted-workspaces/clinical-pathway.runtime.patch.yml'), 'utf8'), { schema: entryListSchema }))).toContain('@deepseek-ai/dsh-experimental-clinical-pathway-reference')
})

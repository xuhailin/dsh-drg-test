/** Deployment launcher layering against the actual generated preset patches. */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { load } from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const root = resolve(import.meta.dirname, '..')

it.each([false, true])('starts the hosted composition with an optional clinical preset (%s)', (clinical) => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-composition-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const bin = join(directory, 'bin'), workspace = join(directory, 'workspace'), home = join(directory, 'home')
  mkdirSync(bin)
  mkdirSync(workspace)
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
      DSH_SHARED_RESOURCES_ROOT: '', HOSTED_MODEL_PROTOCOL: 'openai-responses',
      HOSTED_RUNTIME_PATCH_FILE: clinical ? join(root, 'deploy/hosted-workspaces/clinical.runtime.patch.yml') : '' },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  const args = JSON.parse(readFileSync(capture, 'utf8')) as string[]
  expect(args.slice(0, 2)).toEqual(['--profile', clinical ? 'hosted' : 'web'])
  const patches = args.flatMap((arg, index) => arg === '--patch' ? [args[index + 1]!] : [])
  expect(patches).toEqual([
    join(root, 'packages/bundle/synyi-web-app/cordis.patch.yml'),
    ...clinical ? [join(directory, 'dsh-clinical-presets.patch.yml')] : [],
    join(root, 'deploy/hosted-workspaces/company-model.runtime.patch.yml'), join(directory, 'dsh-company-presets.patch.yml'),
    ...clinical ? [join(root, 'deploy/hosted-workspaces/clinical.runtime.patch.yml')] : [],
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
  expect(args).toContain('http://127.0.0.1:3080/w/synthetic/')
})

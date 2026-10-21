/**
 * Docker artifact build for a 2 GiB builder. Each checked package compilation
 * and workspace bundle exits before the next starts; aggregate tests remain
 * owned by the repository's build:check command.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  CLIENT_BUILD_PROFILE_SELECTOR,
  CLIENT_BUILD_RECORD_PATH,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from '../../scripts/client-build-environment.ts'
import { workspacePackageGlobs } from '../../scripts/workspace-package-globs.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const helper = fileURLToPath(import.meta.url)
const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
const heapMb = Number(process.env.HOSTED_BUILD_HEAP_MB ?? 1280)
const configNames = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map(extension => `tsdown.config.${extension}`)

/** Return emitting leaf projects in dependency order, omitting the aggregate's own test program. */
export function referencedProjects(repository, aggregate) {
  const ordered = []
  const visited = new Set()
  const visiting = new Set()
  const diagnosticHost = {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => repository,
    getNewLine: () => '\n',
  }
  const parseHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.formatDiagnostics([diagnostic], diagnosticHost))
    },
  }
  function visit(input, aggregateRoot = false) {
    const path = input.endsWith('.json') ? resolve(input) : resolve(input, 'tsconfig.json')
    const local = relative(repository, path)
    if (local.startsWith('..') || isAbsolute(local)) throw new Error(`Project reference leaves the build context: ${path}`)
    if (visited.has(path)) return
    if (visiting.has(path)) throw new Error(`Cyclic project reference: ${path}`)
    visiting.add(path)
    const parsed = ts.getParsedCommandLineOfConfigFile(path, {}, parseHost)
    if (parsed === undefined) throw new Error(`Cannot parse project: ${path}`)
    if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost))
    for (const reference of parsed.projectReferences ?? []) visit(reference.path)
    if (!aggregateRoot && parsed.fileNames.length > 0) {
      if (parsed.options.noEmit) throw new Error(`Artifact project disables emission: ${path}`)
      ordered.push(local)
    }
    visiting.delete(path)
    visited.add(path)
  }
  visit(resolve(repository, aggregate), true)
  return ordered
}

function workspaces(face) {
  const packages = workspacePackageGlobs(globSync(['vendor/*/package.json', 'packages/*/*/package.json'], { cwd: root })).sort()
  return [...packages, 'apps/cli', ...face === 'host' ? ['apps/desktop-host'] : []]
}

function hasOwnBundle(directory) {
  return configNames.some(name => existsSync(join(root, directory, name)))
    || JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')).tsdown !== undefined
}

/** Produce the serial build command list without importing or compiling package artifacts. */
export function artifactPlan() {
  const steps = []
  const hostProjects = new Set(referencedProjects(root, 'tsconfig.host.json'))
  for (const project of hostProjects) {
    steps.push({ label: `Host compile ${project}`, args: [compiler, '-p', project] })
  }
  for (const directory of workspaces('host')) {
    steps.push({ label: `Host bundle ${directory}`, args: [helper, '--bundle', 'host', directory] })
  }
  // Host compilation checks types; this existing pass retains all Typert-specific checks.
  // Run after package cleaning and before Desktop and Client consume Remote artifacts.
  steps.push({ label: 'Host Typert', args: ['--import', 'tsx/esm', 'scripts/generate-typert.ts'] })
  steps.push({ label: 'Desktop bundle', args: ['node_modules/tsdown/dist/run.mjs', '--config-loader', 'native'], cwd: 'apps/desktop' })
  for (const project of referencedProjects(root, 'tsconfig.client.json').filter(project => !hostProjects.has(project))) {
    steps.push({ label: `Client compile ${project}`, args: [compiler, '-p', project] })
  }
  // The root Client pass has an empty entry; only package-owned configs can emit.
  for (const directory of workspaces('client').filter(hasOwnBundle)) {
    steps.push({ label: `Client bundle ${directory}`, args: [helper, '--bundle', 'client', directory] })
  }
  steps.push({ label: 'Web build', args: [join(root, 'apps/web/node_modules/vite/bin/vite.js'), 'build'], cwd: 'apps/web' })
  return steps
}

async function bundle(face, directory, write) {
  if (face !== 'host' && face !== 'client') throw new Error('Bundle face must be host or client')
  if (!workspaces(face).includes(directory)) throw new Error(`Unknown ${face} workspace: ${directory}`)
  const { default: rootConfiguration } = await import('../../tsdown.config.ts')
  const { build } = await import('tsdown')
  const env = { DSH_BUILD_FACE: face }
  const configuration = await rootConfiguration({ env })
  if (JSON.stringify([...configuration.workspace].sort()) !== JSON.stringify(workspaces(face).sort())) {
    throw new Error('Docker bundle roster differs from tsdown.config.ts; update the artifact builder')
  }
  const plugins = (configuration.plugins ?? []).map(plugin => {
    if (plugin?.name !== 'dsh-typert-generator') return plugin
    // The separate generate-typert.ts step owns generation. Preserve the
    // original plugin's source-decorator lowering in each package bundle.
    return { name: 'dsh-typert-decorator-transform', transform: plugin.transform }
  })
  try {
    await build({
      ...configuration,
      config: false,
      configLoader: 'native',
      cwd: root,
      workspace: [directory],
      env,
      plugins,
      write,
    })
  } catch (error) {
    // tsdown omits entry:'' configs in the ordinary multi-package pass.
    // With one workspace, that same empty phase reports this exact sentinel.
    if (error instanceof Error && error.message === 'No valid configuration found.') {
      console.log(`${directory}: no ${face} bundle`)
      return
    }
    throw error
  }
}

function run(step, environment) {
  console.log(`hosted Docker build: ${step.label}`)
  const result = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, ...step.args], {
    cwd: step.cwd === undefined ? root : resolve(root, step.cwd),
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${step.label} failed: exit=${String(result.status)}, signal=${String(result.signal)}`)
}

async function main(args) {
  if (!Number.isSafeInteger(heapMb) || heapMb < 256) throw new Error('HOSTED_BUILD_HEAP_MB must be an integer of at least 256')
  if (args[0] === '--bundle' && (args.length === 3 || args.length === 4 && args[3] === '--no-write')) {
    await bundle(args[1], args[2], args[3] !== '--no-write')
    return
  }
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify(artifactPlan(), null, 2))
    return
  }
  if (args.length !== 0) throw new Error('Usage: build-artifacts.mjs [--plan | --bundle <host|client> <workspace> [--no-write]]')
  const clientEnvironment = resolveClientBuildEnvironment(
    repositoryClientBuildEnvironment(root, process.env), process.env[CLIENT_BUILD_PROFILE_SELECTOR],
  )
  const environment = { ...clientBuildProcessEnvironment(process.env, clientEnvironment), RAYON_NUM_THREADS: '1' }
  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  for (const step of artifactPlan()) {
    // Executables are resolved from the repository even when their tool runs in an app directory.
    const [entry, ...rest] = step.args
    const actual = entry?.startsWith('node_modules/') ? { ...step, args: [resolve(root, entry), ...rest] } : step
    run(actual, environment)
  }
  const record = writeClientBuildRecord(root, clientEnvironment)
  console.log(`hosted Docker build: recorded ${record.artifacts.fileCount} client artifacts`)
}

if (import.meta.main) await main(process.argv.slice(2))

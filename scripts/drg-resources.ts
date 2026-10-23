/** Offline operator utility for immutable national DRG source archives. */
import { parseArgs } from 'node:util'
import { DrgResourceError, DrgResourceStore, validatePack } from '@deepseek-ai/dsh-experimental-drg-resources'

const usage = `Usage: pnpm exec tsx scripts/drg-resources.ts COMMAND --root PATH [options]
Commands: initialize, publish, list, verify, default, withdraw, restore, recover
Publish: --id ID --edition TEXT --revision TEXT --source-file PDF --source-url URL --sha256 HASH
Verify: optional --id ID; default/withdraw/restore/recover: --id ID
Source-only references never authorize DRG grouping. Published IDs cannot be overwritten.
`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    root: { type: 'string' }, id: { type: 'string' }, edition: { type: 'string' }, revision: { type: 'string' },
    'source-file': { type: 'string' }, 'source-url': { type: 'string' }, sha256: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) { process.stdout.write(usage); return }
  const required = (value: string | undefined, label: string): string => {
    if (value === undefined) throw new DrgResourceError('invalid-input', `Missing --${label}. ${usage}`)
    return value
  }
  if (positionals.length !== 1) throw new DrgResourceError('invalid-input', usage)
  const store = new DrgResourceStore(required(values.root, 'root'))
  let result: unknown
  switch (positionals[0]) {
    case 'initialize': result = await store.initialize(); break
    case 'publish': result = await store.publishSource({ packId: required(values.id, 'id'), edition: required(values.edition, 'edition'),
      derivedRevision: required(values.revision, 'revision'), sourceFile: required(values['source-file'], 'source-file'),
      sourceUrl: required(values['source-url'], 'source-url'), expectedSha256: required(values.sha256, 'sha256') }); break
    case 'list': result = await store.list(); break
    case 'verify': result = values.id === undefined ? await store.list() : await validatePack(store.publishedRoot, values.id); break
    case 'default': result = await store.selectDefault(required(values.id, 'id')); break
    case 'withdraw': result = await store.withdraw(required(values.id, 'id')); break
    case 'restore': result = await store.restore(required(values.id, 'id')); break
    case 'recover': result = await store.recover(required(values.id, 'id')); break
    default: throw new DrgResourceError('invalid-input', usage)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error: unknown) => {
  const report = error instanceof DrgResourceError
    ? { error: error.code, message: error.message, stagePath: error.options.stagePath }
    : { error: 'io', message: error instanceof Error ? error.message : 'Unknown archive failure; inspect the server resource directory.' }
  process.stderr.write(`${JSON.stringify(report)}\n`)
  process.exitCode = 1
})

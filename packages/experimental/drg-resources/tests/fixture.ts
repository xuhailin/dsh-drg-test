/** Isolated local archive fixtures with immediate cleanup registration. */
import { onTestFinished } from 'vitest'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DrgResourceStore } from '../src/index.ts'

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-drg-reference-'))
  onTestFinished(async () => {
    // POSIX archive directories require owner write access for test cleanup.
    const makeWritable = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable(join(path, entry.name))
      }
      await chmod(path, 0o700)
    }
    await makeWritable(root)
    await rm(root, { recursive: true, force: true })
  })
  const sourceFile = join(root, 'source.pdf')
  const pdf = Buffer.from('%PDF-1.7\nSynthetic source fixture, not national grouping data.\n%%EOF\n')
  await writeFile(sourceFile, pdf)
  const store = new DrgResourceStore(join(root, 'resources'))
  await store.initialize()
  const input = { packId: 'national-test-r1', edition: 'synthetic-test', derivedRevision: 'source-archive-r1', sourceFile,
    sourceUrl: 'https://example.test/national.pdf', expectedSha256: createHash('sha256').update(pdf).digest('hex') }
  return { root, store, input, pdf }
}

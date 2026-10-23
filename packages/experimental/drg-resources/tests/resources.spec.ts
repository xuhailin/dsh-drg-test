/** Real-filesystem publication and recovery checks with isolated per-test roots. */
import { describe, expect, it } from 'vitest'
import { chmod, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { DrgResourceStore, readPublishedCollection, resourcePackId, validatePack } from '../src/index.ts'

import { fixture } from './fixture.ts'

describe('source-only national reference archives', () => {
  it('publishes a standalone SQLite archive and resolves a reference default without enabling grouping', async () => {
    const { store, input, pdf } = await fixture()
    const manifest = await store.publishSource(input)
    expect(manifest).toMatchObject({ packId: input.packId, profile: 'source-only', readiness: { groupingReady: false } })
    expect(await readFile(join(store.publishedRoot, input.packId, 'sources/national.pdf'))).toEqual(pdf)
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' })
    await store.selectDefault(input.packId)
    expect(await store.read()).toEqual(manifest)
    expect(await readPublishedCollection(store.publishedRoot)).toMatchObject({
      catalog: { revision: 2, referenceDefault: input.packId }, packs: [manifest],
    })
    const db = new DatabaseSync(join(store.publishedRoot, input.packId, 'reference.sqlite'), { readOnly: true })
    try {
      expect(db.prepare("SELECT value FROM archive_metadata WHERE key='grouping_ready'").get()?.value).toBe('false')
      expect(() => { db.exec("INSERT INTO archive_metadata VALUES ('bad','bad')") }).toThrow()
    } finally { db.close() }
    expect(await readdir(join(store.publishedRoot, input.packId))).toEqual(['manifest.json', 'reference.sqlite', 'sources'])
    expect(await store.initialize()).toEqual(await store.list())
  })

  it('never overwrites a registered identity', async () => {
    const { store, input } = await fixture()
    const first = await store.publishSource(input)
    await expect(store.publishSource({ ...input, derivedRevision: 'changed' })).rejects.toMatchObject({ code: 'exists' })
    expect(await store.read(input.packId)).toEqual(first)
  })

  it('retains a failed staging candidate and never registers an incorrect source hash', async () => {
    const { store, input } = await fixture()
    await expect(store.publishSource({ ...input, expectedSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid-input' })
    expect((await store.list()).catalog.packs).toEqual([])
    const stages = await readdir(join(store.root, 'staging'))
    expect(stages).toHaveLength(1)
    expect(JSON.parse(await readFile(join(store.root, 'staging', stages[0]!, 'preparing.json'), 'utf8'))).toMatchObject({ phase: 'preparing' })
  })

  it.each(['../escape', 'with/slash', 'UPPER', '.', '..', 'two..dots', 'a\\b', 'a'.repeat(97)])('rejects unsafe pack identity %s', async (id) => {
    const { store, input } = await fixture()
    expect(() => resourcePackId(id)).toThrow()
    await expect(store.publishSource({ ...input, packId: id })).rejects.toMatchObject({ code: 'invalid-input' })
    expect(await readdir(join(store.root, 'staging'))).toEqual([])
  })

  it('rejects symbolic source files and published directories', async () => {
    const { root, store, input } = await fixture()
    const linked = join(root, 'linked.pdf')
    await symlink(input.sourceFile, linked)
    await expect(store.publishSource({ ...input, sourceFile: linked })).rejects.toMatchObject({ code: 'invalid-resource' })
    await store.publishSource(input)
    const linkRoot = join(root, 'linked-published')
    await symlink(store.publishedRoot, linkRoot)
    await expect(readPublishedCollection(linkRoot)).rejects.toMatchObject({ code: 'invalid-resource' })
    const sources = join(store.publishedRoot, input.packId, 'sources')
    await chmod(sources, 0o755)
    await rm(join(sources, 'national.pdf'))
    await symlink(input.sourceFile, join(sources, 'national.pdf'))
    await expect(validatePack(store.publishedRoot, input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it.each(['reference.sqlite-wal', 'reference.sqlite-shm', 'extra.json'])('rejects unknown artifact %s', async (filename) => {
    const { store, input } = await fixture()
    await store.publishSource(input)
    const pack = join(store.publishedRoot, input.packId)
    await chmod(pack, 0o755)
    await writeFile(join(pack, filename), 'unexpected')
    await expect(store.list()).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it.each(['sources/national.pdf', 'reference.sqlite', 'manifest.json'])('detects changed published bytes in %s', async (filename) => {
    const { store, input } = await fixture()
    await store.publishSource(input)
    const path = join(store.publishedRoot, input.packId, filename)
    await chmod(path, 0o644)
    await writeFile(path, 'tampered')
    await expect(store.read(input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it('rejects conflicting independent writers instead of overwriting catalog changes', async () => {
    const { store, input } = await fixture()
    const other = new DrgResourceStore(store.root)
    const results = await Promise.allSettled([store.publishSource(input), other.publishSource({ ...input, packId: 'national-test-r2' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'busy' } })
    expect((await store.list()).catalog.packs).toHaveLength(1)
    await mkdir(join(store.root, '.writer-lock'))
    await expect(other.selectDefault((await store.list()).catalog.packs[0]!.packId)).rejects.toMatchObject({ code: 'busy' })
    await rm(join(store.root, '.writer-lock'), { recursive: true })
  })

  it('coordinates the exclusive lock with a separate process and releases it to quiescence', async () => {
    const { store, input } = await fixture()
    const script = `
      import { mkdir, rmdir } from 'node:fs/promises';
      await mkdir(process.argv[1]);
      process.stdout.write('locked\\n');
      await new Promise(resolve => process.stdin.once('data', resolve));
      await rmdir(process.argv[1]);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(store.root, '.writer-lock')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { resolve({ code, signal }) })
    })
    const lines = createInterface({ input: child.stdout })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    try {
      const ready = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(`Lock worker exited: ${stderr}`) })])
      expect(ready[0]).toBe('locked')
      await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'busy' })
      expect((await store.list()).catalog.packs).toHaveLength(0)
    } finally {
      lines.close()
      child.stdin.end('release\n')
      const { code, signal } = await exited
      expect(signal).toBeNull()
      expect(code, stderr).toBe(0)
    }
    await store.publishSource(input)
    expect((await store.list()).catalog.packs).toHaveLength(1)
  })

  it('rolls back defaults and withdraws availability without deleting retained packs', async () => {
    const { store, input } = await fixture()
    await store.publishSource(input)
    await store.publishSource({ ...input, packId: 'national-test-r2', derivedRevision: 'source-archive-r2' })
    await store.selectDefault(input.packId)
    await store.selectDefault('national-test-r2')
    await store.selectDefault(input.packId)
    expect((await store.read()).packId).toBe(input.packId)
    await store.withdraw(input.packId)
    expect((await store.list()).catalog.referenceDefault).toBeNull()
    await expect(store.read(input.packId)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(store.selectDefault(input.packId)).rejects.toMatchObject({ code: 'unavailable' })
    expect((await validatePack(store.publishedRoot, input.packId)).packId).toBe(input.packId)
    await store.restore(input.packId)
    await store.selectDefault(input.packId)
    expect((await store.list()).packs).toHaveLength(2)
  })

  it('recovers an immutable orphan without silently making it default', async () => {
    const { root, store, input } = await fixture()
    const donor = new DrgResourceStore(join(root, 'donor'))
    await donor.initialize()
    await donor.publishSource(input)
    await cp(join(donor.publishedRoot, input.packId), join(store.publishedRoot, input.packId), { recursive: true })
    await expect(store.list()).rejects.toMatchObject({ code: 'invalid-resource' })
    await store.recover(input.packId)
    expect((await store.list()).catalog).toMatchObject({ referenceDefault: null, packs: [{ packId: input.packId }] })
    await expect(store.recover(input.packId)).rejects.toMatchObject({ code: 'exists' })
  })
})

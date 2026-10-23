/** Publication fault injection verifies retained filesystem outcomes and repair paths. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { DrgResourceStore, resourcePackId, validatePack } from '../src/index.ts'
import { createDatabase, validateDatabase } from '../src/database.ts'
import { digest, readArtifact } from '../src/files.ts'
import { parseCatalog, parseManifest } from '../src/format.ts'
import { fixture } from './fixture.ts'
import * as reader from '../src/reader.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename), rmdir: vi.fn(actual.rmdir),
    lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) }
})
vi.mock('../src/reader.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reader.ts')>()
  return { ...actual, readPublishedCollection: vi.fn(actual.readPublishedCollection) }
})
const originalReader = await vi.importActual<typeof import('../src/reader.ts')>('../src/reader.ts')
const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
afterEach(() => {
  vi.mocked(reader.readPublishedCollection).mockImplementation(originalReader.readPublishedCollection)
  vi.mocked(fs.mkdir).mockImplementation(original.mkdir)
  vi.mocked(fs.rename).mockImplementation(original.rename)
  vi.mocked(fs.rmdir).mockImplementation(original.rmdir)
  vi.mocked(fs.open).mockImplementation(original.open)
  vi.mocked(fs.lstat).mockImplementation(original.lstat)
})
function ioError(): NodeJS.ErrnoException { return Object.assign(new Error('Injected full disk'), { code: 'ENOSPC' }) }
async function replaceJson(path: string, value: unknown): Promise<void> {
  await fs.chmod(path, 0o644)
  await fs.writeFile(path, `${JSON.stringify(value)}\n`)
}
async function replaceManifestHash(store: DrgResourceStore, packId: string): Promise<void> {
  const catalog = JSON.parse(await fs.readFile(join(store.publishedRoot, 'catalog.json'), 'utf8')) as {
    packs: { packId: string; manifestSha256: string }[]
  }
  catalog.packs.find(pack => pack.packId === packId)!.manifestSha256 = digest(await fs.readFile(join(store.publishedRoot, packId, 'manifest.json')))
  await replaceJson(join(store.publishedRoot, 'catalog.json'), catalog)
}

describe('publication failures preserve inspectable state', () => {
  it.each(['pack-count', 'revision-overflow'])('rejects catalog %s before publishing any directory', async (limit) => {
    const { store, input } = await fixture()
    const catalogPath = join(store.publishedRoot, 'catalog.json')
    const before = await fs.readFile(catalogPath)
    // The validated-reader result places the real writer at a large valid catalog boundary.
    const packs = limit === 'pack-count' ? Array.from({ length: 1000 }, (_, index) => ({
      packId: resourcePackId(`existing-${index}`), manifestSha256: digest(Buffer.from('existing')), availability: 'available' as const,
    })) : []
    const catalog = parseCatalog({ schemaVersion: 1, revision: limit === 'revision-overflow' ? Number.MAX_SAFE_INTEGER : 0,
      referenceDefault: null, packs })
    vi.mocked(reader.readPublishedCollection).mockResolvedValueOnce({ catalog, packs: [] })
    await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'invalid-resource' })
    expect(await fs.readFile(catalogPath)).toEqual(before)
    expect(await fs.readdir(store.publishedRoot)).toEqual(['catalog.json'])
    expect(await fs.readdir(join(store.root, 'staging'))).toHaveLength(1)
  })

  it('reports a committed orphan after catalog replacement failure and recovers it', async () => {
    const { store, input } = await fixture()
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(to).endsWith('/catalog.json')) throw ioError()
      return original.rename(from, to)
    })
    await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'publication-incomplete' })
    expect((await fs.readdir(store.publishedRoot)).sort()).toEqual(['catalog.json', input.packId].sort())
    expect((await fs.readdir(join(store.root, 'staging'))).some(name => name.startsWith('catalog-'))).toBe(true)
    vi.mocked(fs.rename).mockImplementation(original.rename)
    await store.recover(input.packId)
    expect((await store.read(input.packId)).readiness.groupingReady).toBe(false)
    expect((await store.list()).catalog.referenceDefault).toBeNull()
  })

  it('keeps the previous default after failed catalog replacement', async () => {
    const { store, input } = await fixture()
    await store.publishSource(input)
    await store.selectDefault(input.packId)
    await store.publishSource({ ...input, packId: 'national-test-r2' })
    vi.mocked(fs.rename).mockRejectedValueOnce(ioError())
    await expect(store.selectDefault('national-test-r2')).rejects.toMatchObject({ code: 'io', options: { cause: { code: 'ENOSPC' } } })
    expect((await store.read()).packId).toBe(input.packId)
    expect(await fs.readdir(store.root)).not.toContain('.writer-lock')
  })

  it('retains a failed precommit candidate and admits a separately retried new publication', async () => {
    const { store, input } = await fixture()
    vi.mocked(fs.rename).mockRejectedValueOnce(ioError())
    await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'io' })
    expect((await store.list()).catalog.packs).toHaveLength(0)
    expect(await fs.readdir(join(store.root, 'staging'))).toHaveLength(1)
    await store.publishSource(input)
    expect((await store.list()).catalog.packs).toHaveLength(1)
  })

  it('retains the writer lock when cleanup fails and reports the committed result for inspection', async () => {
    const { store, input } = await fixture()
    vi.mocked(fs.rmdir).mockRejectedValueOnce(ioError())
    await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'io' })
    expect((await store.read(input.packId)).packId).toBe(input.packId)
    await expect(store.selectDefault(input.packId)).rejects.toMatchObject({ code: 'busy' })
  })

  it('preserves both operation and lock-cleanup errors', async () => {
    const { store, input } = await fixture()
    vi.mocked(fs.rmdir).mockRejectedValueOnce(ioError())
    const outcome = store.publishSource({ ...input, expectedSha256: '0'.repeat(64) })
    await expect(outcome).rejects.toMatchObject({ code: 'io', options: { cause: { name: 'AggregateError' } } })
    expect((await store.list()).catalog.packs).toHaveLength(0)
  })

  it('reports lock-creation errors and refuses to write', async () => {
    const { store, input } = await fixture()
    vi.mocked(fs.mkdir).mockRejectedValueOnce(ioError())
    await expect(store.publishSource(input)).rejects.toMatchObject({ code: 'io' })
    expect((await store.list()).catalog.packs).toHaveLength(0)
  })

  it.each(['staging', 'published'])('propagates %s creation failure without changing the catalog', async (name) => {
    const { store } = await fixture()
    vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
      if (String(path) === join(store.root, name)) throw ioError()
      return original.mkdir(path, options)
    })
    await expect(store.initialize()).rejects.toMatchObject({ code: 'io', options: { cause: { code: 'ENOSPC' } } })
    expect((await store.list()).catalog.revision).toBe(0)
  })

  it('refuses initialization over an unreadable or damaged catalog', async () => {
    const { store } = await fixture()
    await fs.writeFile(join(store.publishedRoot, 'catalog.json'), '{}')
    await expect(store.initialize()).rejects.toMatchObject({ code: 'invalid-resource' })
    await fs.rm(join(store.publishedRoot, 'catalog.json'))
    await fs.mkdir(join(store.publishedRoot, 'orphan'))
    await expect(store.initialize()).rejects.toMatchObject({ code: 'publication-incomplete' })
  })

  it('refuses catalog duplicates, invalid defaults, and absent operations', async () => {
    const { store, input } = await fixture()
    await store.publishSource(input)
    const catalog = (await store.list()).catalog
    expect(() => parseCatalog({ ...catalog, packs: [...catalog.packs, ...catalog.packs] })).toThrow()
    expect(() => parseCatalog({ ...catalog, referenceDefault: 'missing' })).toThrow()
    await expect(store.withdraw('missing')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(validatePack(store.publishedRoot, 'missing')).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects invalid publication fields before creating staging files', async () => {
    const { store, input } = await fixture()
    await expect(store.publishSource({ ...input, sourceUrl: 'file:///national.pdf' })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(store.publishSource({ ...input, sourceUrl: 'https://user:secret@example.test/a.pdf' })).rejects.toMatchObject({ code: 'invalid-input' })
    expect(await fs.readdir(join(store.root, 'staging'))).toHaveLength(0)
  })

  it('rejects a manifest that falsely claims grouping readiness', async () => {
    const { store, input } = await fixture()
    const manifest = await store.publishSource(input)
    expect(() => parseManifest({ ...manifest, readiness: { ...manifest.readiness, groupingReady: true } })).toThrow()
    await replaceJson(join(store.publishedRoot, input.packId, 'manifest.json'), { ...manifest, readiness: { ...manifest.readiness, groupingReady: true } })
    await expect(store.read(input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it('rejects manifest identity and catalog digest mismatches', async () => {
    const { store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const path = join(store.publishedRoot, input.packId, 'manifest.json')
    await replaceJson(path, { ...manifest, packId: 'different-id' })
    await expect(validatePack(store.publishedRoot, input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
    await replaceJson(path, { ...manifest, publishedAt: '2026-10-01T00:00:00.000Z' })
    await expect(validatePack(store.publishedRoot, input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
    await expect(store.list()).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it('checks an existing registration when recovering another complete revision', async () => {
    const { root, store, input } = await fixture()
    await store.publishSource(input)
    const donor = new DrgResourceStore(join(root, 'donor'))
    await donor.initialize()
    await donor.publishSource({ ...input, packId: 'national-test-r2' })
    await fs.cp(join(donor.publishedRoot, 'national-test-r2'), join(store.publishedRoot, 'national-test-r2'), { recursive: true })
    await store.recover('national-test-r2')
    expect((await store.list()).catalog.packs).toHaveLength(2)
  })
})

describe('artifact byte and SQLite validation', () => {
  it('rejects an oversized source and a source that changes between stat and open', async () => {
    const { input } = await fixture()
    await expect(readArtifact(input.sourceFile, 1)).rejects.toMatchObject({ code: 'invalid-resource' })
    const actual = await original.lstat(input.sourceFile)
    vi.mocked(fs.lstat).mockResolvedValueOnce(Object.assign(actual, { ino: actual.ino + 1 }))
    await expect(readArtifact(input.sourceFile, 1024)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it('rejects hard-linked original files instead of sharing mutable host bytes', async () => {
    const { root, store, input } = await fixture()
    const linked = join(root, 'hardlinked.pdf')
    await fs.link(input.sourceFile, linked)
    await expect(store.publishSource({ ...input, sourceFile: linked })).rejects.toMatchObject({ code: 'invalid-resource' })
    expect((await store.list()).catalog.packs).toHaveLength(0)
  })

  it('rejects a source growing while read through an already-open descriptor', async () => {
    const { input } = await fixture()
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await original.open(path, flags, mode)
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const result = await stat()
        await original.appendFile(path, 'extra')
        return result
      })
      return handle
    })
    await expect(readArtifact(input.sourceFile, 1024)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it('rejects corrupt SQLite data even after its manifest digest was updated', async () => {
    const { store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const database = join(store.publishedRoot, input.packId, 'reference.sqlite')
    await fs.chmod(database, 0o644)
    await fs.writeFile(database, 'not a SQLite database')
    const bytes = await fs.readFile(database)
    await replaceJson(join(store.publishedRoot, input.packId, 'manifest.json'), {
      ...manifest, database: { ...manifest.database, sha256: digest(bytes), bytes: bytes.length },
    })
    await replaceManifestHash(store, input.packId)
    await expect(store.read(input.packId)).rejects.toMatchObject({ code: 'invalid-resource' })
  })

  it.each(['schema', 'metadata'])('rejects SQLite %s inconsistent with its manifest', async (mode) => {
    const { store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const database = join(store.publishedRoot, input.packId, 'reference.sqlite')
    await fs.chmod(database, 0o644)
    await fs.chmod(join(store.publishedRoot, input.packId), 0o755)
    const db = new DatabaseSync(database)
    try {
      if (mode === 'schema') db.exec('PRAGMA user_version=2')
      else db.exec("UPDATE archive_metadata SET value='forged' WHERE key='edition'")
    } finally { db.close() }
    expect(() =>{  validateDatabase(database, manifest) }).toThrow()
  })

  it.each(['unexpected', 'sqlitePatientData', 'sqliteRules'])('rejects additional non-system SQLite table %s', async (table) => {
    const { store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const directory = join(store.publishedRoot, input.packId)
    const database = join(directory, 'reference.sqlite')
    await fs.chmod(directory, 0o755)
    await fs.chmod(database, 0o644)
    const db = new DatabaseSync(database)
    try { db.exec(`CREATE TABLE ${table}(secret TEXT)`) } finally { db.close() }
    expect(() => { validateDatabase(database, manifest) }).toThrow()
  })

  it('reports a missing SQLite artifact without creating a database', async () => {
    const { root, store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const database = join(root, 'missing.sqlite')
    expect(() =>{  validateDatabase(database, manifest) }).toThrow()
    await expect(fs.stat(database)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('closes a database writer even when artifact schema creation fails', async () => {
    const { root, store, input } = await fixture()
    const manifest = await store.publishSource(input)
    const database = join(root, 'existing.sqlite')
    createDatabase(database, manifest)
    expect(() =>{  createDatabase(database, manifest) }).toThrow()
    expect(() =>{  validateDatabase(database, manifest) }).not.toThrow()
  })

  it('rejects bytes whose matching SHA-256 does not identify a PDF', async () => {
    const { store, input } = await fixture()
    const source = Buffer.from('not a PDF')
    await fs.writeFile(input.sourceFile, source)
    await expect(store.publishSource({ ...input, expectedSha256: createHash('sha256').update(source).digest('hex') })).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

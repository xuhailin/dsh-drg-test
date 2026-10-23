/** Operator-only publication transactions; runtime readers never write this root. */
import { chmod, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DrgResourceError, parseCatalog, resourcePackId, sourceMetadata } from './format.ts'
import { digest, directory, exactEntries, readArtifact, syncDirectory, writeNew } from './files.ts'
import { createDatabase } from './database.ts'
import { readCatalog, readPublishedCollection, validatePack, validatePackFiles } from './reader.ts'
import type { PackManifest, PublishSourceInput, PublishedCollection, ResourceCatalog } from './types.ts'

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function conflict(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }

/**
 * Trusted-operator archive owner. Root/staging are private; published is mountable read-only.
 * A writer conflict rejects immediately. A crash leaves .writer-lock and staged receipts
 * for inspection; operators must establish that no writer remains before removing a stale lock.
 * Local reliable rename/fsync semantics are required; network filesystems are unsupported.
 */
export class DrgResourceStore {
  /** Operator-only persistent root containing staging and published storage. */
  readonly root: string
  /** Published collection directory suitable for a Docker read-only bind mount. */
  readonly publishedRoot: string
  private readonly stagingRoot: string

  /**
   * Select an operator-owned local filesystem root; no I/O occurs until an operation.
   * @param root - server-persistent resource root, outside private homes.
   */
  constructor(root: string) {
    this.root = resolve(root)
    this.publishedRoot = join(this.root, 'published')
    this.stagingRoot = join(this.root, 'staging')
  }

  /**
   * Create a new collection or verify an existing complete collection without resetting it.
   * @returns validated collection; failures preserve prior files and catalog.
   */
  async initialize(): Promise<PublishedCollection> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await directory(this.root)
    return this.write(async () => {
      await mkdir(this.stagingRoot, { mode: 0o700 }).catch((error: unknown) => { if (!conflict(error)) throw error })
      await directory(this.stagingRoot)
      await mkdir(this.publishedRoot, { mode: 0o755 }).catch((error: unknown) => { if (!conflict(error)) throw error })
      await directory(this.publishedRoot)
      await syncDirectory(this.root)
      await syncDirectory(dirname(this.root))
      try {
        await readCatalog(this.publishedRoot)
      } catch (error) {
        if (!missing(error)) throw error
        const entries = await readdir(this.publishedRoot)
        if (entries.length !== 0) throw new DrgResourceError('publication-incomplete', 'Published files exist without a catalog; restore or inspect before initialization.')
        await this.catalog({ schemaVersion: 1, revision: 0, referenceDefault: null, packs: [] })
      }
      return readPublishedCollection(this.publishedRoot)
    })
  }

  /**
   * Publish a new immutable source-only revision without selecting it as a default.
   * @param input - local PDF and independently checked publication identity/digest.
   * @returns verified manifest; errors retain staged files and identify incomplete publication.
   */
  async publishSource(input: PublishSourceInput): Promise<PackManifest> {
    const packId = resourcePackId(input.packId)
    const metadata = sourceMetadata({
      edition: input.edition, derivedRevision: input.derivedRevision, sourceUrl: input.sourceUrl, expectedSha256: input.expectedSha256,
    })
    return this.write(async () => {
      const collection = await readPublishedCollection(this.publishedRoot)
      const destination = join(this.publishedRoot, packId)
      if (collection.catalog.packs.some(pack => pack.packId === packId)) {
        throw new DrgResourceError('exists', 'Pack IDs are immutable; publish a new revision with a new ID.')
      }
      const stage = join(this.stagingRoot, randomUUID())
      await mkdir(stage, { mode: 0o700 })
      let committed = false
      try {
        await writeNew(join(stage, 'preparing.json'), json({ packId, phase: 'preparing' }), 0o600)
        await syncDirectory(stage)
        await syncDirectory(this.stagingRoot)
        const source = await readArtifact(resolve(input.sourceFile), 128 * 1024 * 1024)
        if (digest(source) !== metadata.expectedSha256 || source.subarray(0, 5).toString('ascii') !== '%PDF-') {
          throw new DrgResourceError('invalid-input', 'Source hash or PDF header differs; verify the original file and expected SHA-256.')
        }
        const candidate = join(stage, packId)
        await mkdir(candidate, { mode: 0o755 })
        await mkdir(join(candidate, 'sources'), { mode: 0o755 })
        await writeNew(join(candidate, 'sources', 'national.pdf'), source, 0o444)
        const base = {
          schemaVersion: 1 as const, profile: 'source-only' as const, packId,
          edition: metadata.edition, derivedRevision: metadata.derivedRevision, publishedAt: new Date().toISOString(),
          source: { path: 'sources/national.pdf' as const, url: metadata.sourceUrl, sha256: metadata.expectedSha256, bytes: source.length },
          readiness: { groupingReady: false as const, dictionary: 'not-provided' as const, engine: 'not-implemented' as const, rules: 'not-extracted-or-reviewed' as const },
        }
        const databasePath = join(candidate, 'reference.sqlite')
        await writeNew(databasePath, '', 0o600)
        createDatabase(databasePath, base)
        const database = await readArtifact(databasePath, 1024 * 1024)
        const manifest: PackManifest = { ...base, database: { path: 'reference.sqlite', sha256: digest(database), bytes: database.length, schemaVersion: 1 } }
        await chmod(databasePath, 0o444)
        await writeNew(join(candidate, 'manifest.json'), json(manifest), 0o444)
        await chmod(join(candidate, 'sources'), 0o555)
        await validatePackFiles(stage, packId)
        const nextCatalog = parseCatalog({ ...collection.catalog, revision: collection.catalog.revision + 1,
          packs: [...collection.catalog.packs, { packId, manifestSha256: digest(Buffer.from(json(manifest))), availability: 'available' }] })
        await syncDirectory(join(candidate, 'sources'))
        await syncDirectory(candidate)
        await syncDirectory(stage)
        await rename(candidate, destination)
        committed = true
        await chmod(destination, 0o555)
        await syncDirectory(destination)
        await syncDirectory(this.publishedRoot)
        await writeNew(join(stage, 'published.json'), json({ packId, phase: 'published-awaiting-catalog' }), 0o600)
        await this.catalog(nextCatalog)
        await writeNew(join(stage, 'complete.json'), json({ packId, phase: 'complete' }), 0o600)
        await syncDirectory(stage)
        return manifest
      } catch (error) {
        if (committed) throw new DrgResourceError('publication-incomplete', `Pack bytes were published; inspect catalog and recover registration if absent. Retained receipt: ${stage}`, { cause: error, stagePath: stage })
        if (error instanceof DrgResourceError) throw new DrgResourceError(error.code, `${error.message} Candidate retained at ${stage}`, { cause: error, stagePath: stage })
        throw new DrgResourceError('io', `Publication stopped before commit; inspect retained candidate: ${stage}`, { cause: error, stagePath: stage })
      }
    })
  }

  /**
   * Validate all registered and retained revisions without writing.
   * @returns catalog plus source-only metadata, including withdrawn archives.
   */
  async list(): Promise<PublishedCollection> { return readPublishedCollection(this.publishedRoot) }

  /**
   * Read an available revision with exact artifact verification.
   * @param id - explicit pack ID; omission resolves the current reference default.
   * @returns source-only metadata; missing or withdrawn defaults fail visibly.
   */
  async read(id?: string): Promise<PackManifest> {
    const catalog = await readCatalog(this.publishedRoot)
    const packId = id === undefined ? catalog.referenceDefault : resourcePackId(id)
    const record = catalog.packs.find(pack => pack.packId === packId)
    if (record?.availability !== 'available') throw new DrgResourceError('unavailable', 'Reference revision is missing, withdrawn, or no default is selected.')
    return validatePack(this.publishedRoot, record.packId)
  }

  /**
   * Select a verified reference default, including rollback to an older revision.
   * @param id - available immutable revision; this grants no grouping readiness.
   * @returns updated catalog; no pack bytes or private Sessions are changed.
   */
  async selectDefault(id: string): Promise<ResourceCatalog> {
    const packId = resourcePackId(id)
    return this.update((catalog) => {
      if (!catalog.packs.some(pack => pack.packId === packId && pack.availability === 'available')) {
        throw new DrgResourceError('unavailable', 'Select a published available reference revision.')
      }
      return { ...catalog, referenceDefault: packId }
    })
  }

  /**
   * Withdraw a revision while retaining all immutable files; withdrawing the default clears it.
   * @param id - registered revision.
   * @returns updated publication metadata.
   */
  async withdraw(id: string): Promise<ResourceCatalog> { return this.availability(id, 'withdrawn') }

  /**
   * Restore reference availability after full integrity validation, without selecting a default.
   * @param id - retained withdrawn revision.
   * @returns updated publication metadata.
   */
  async restore(id: string): Promise<ResourceCatalog> { return this.availability(id, 'available') }

  /**
   * Register a fully published orphan after an interrupted catalog update.
   * @param id - existing complete unregistered directory; no pack bytes are changed.
   * @returns updated catalog; the recovered revision is available but never selected by default.
   */
  async recover(id: string): Promise<ResourceCatalog> {
    const packId = resourcePackId(id)
    return this.write(async () => {
      const catalog = await readCatalog(this.publishedRoot)
      if (catalog.packs.some(pack => pack.packId === packId)) throw new DrgResourceError('exists', 'Revision is already registered; inspect it with verify.')
      await exactEntries(this.publishedRoot, ['catalog.json', ...catalog.packs.map(pack => pack.packId), packId])
      for (const record of catalog.packs) await validatePack(this.publishedRoot, record.packId)
      await validatePackFiles(this.publishedRoot, packId)
      return this.catalog({ ...catalog, revision: catalog.revision + 1, packs: [...catalog.packs, {
        packId, manifestSha256: digest(await readArtifact(join(this.publishedRoot, packId, 'manifest.json'), 1024 * 1024)), availability: 'available',
      }] })
    })
  }

  private async availability(id: string, availability: 'available' | 'withdrawn'): Promise<ResourceCatalog> {
    const packId = resourcePackId(id)
    return this.update((catalog) => {
      if (!catalog.packs.some(pack => pack.packId === packId)) throw new DrgResourceError('unavailable', 'Revision is not registered.')
      return { ...catalog, referenceDefault: availability === 'withdrawn' && catalog.referenceDefault === packId ? null : catalog.referenceDefault,
        packs: catalog.packs.map(pack => pack.packId === packId ? { ...pack, availability } : pack) }
    })
  }

  private async update(change: (catalog: ResourceCatalog) => ResourceCatalog): Promise<ResourceCatalog> {
    return this.write(async () => {
      const { catalog } = await this.list()
      return this.catalog({ ...change(catalog), revision: catalog.revision + 1 })
    })
  }

  private async catalog(value: ResourceCatalog): Promise<ResourceCatalog> {
    const admitted = parseCatalog(value)
    await directory(this.stagingRoot)
    await directory(this.publishedRoot)
    const temporary = join(this.stagingRoot, `catalog-${randomUUID()}.json`)
    await writeNew(temporary, json(admitted), 0o644)
    await rename(temporary, join(this.publishedRoot, 'catalog.json'))
    await syncDirectory(this.publishedRoot)
    await syncDirectory(this.stagingRoot)
    return admitted
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    await directory(this.root)
    const lock = join(this.root, '.writer-lock')
    try {
      await mkdir(lock, { mode: 0o700 })
    } catch (error) {
      if (conflict(error)) throw new DrgResourceError('busy', 'Another writer or interrupted operation owns .writer-lock; inspect before retrying.', { cause: error })
      throw new DrgResourceError('io', 'Cannot acquire the resource writer lock; inspect directory permissions.', { cause: error })
    }
    const outcome = await operation().then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
    try {
      await rmdir(lock)
    } catch (error) {
      throw new DrgResourceError('io', 'Writer lock cleanup failed; inspect operation results before retrying.', {
        cause: outcome.ok ? error : new AggregateError([outcome.error, error]),
      })
    }
    if (!outcome.ok) {
      if (outcome.error instanceof DrgResourceError) throw outcome.error
      throw new DrgResourceError('io', 'Resource write failed; inspect retained files and catalog before retrying.', { cause: outcome.error })
    }
    return outcome.value
  }
}

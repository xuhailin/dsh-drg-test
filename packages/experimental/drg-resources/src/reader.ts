/** Read-only admission for published source archives and reference defaults. */
import { join } from 'node:path'
import { digest, directory, exactEntries, readArtifact, readJson } from './files.ts'
import { DrgResourceError, parseCatalog, parseManifest, resourcePackId } from './format.ts'
import { validateDatabase } from './database.ts'
import type { PackManifest, PublishedCollection, ResourceCatalog } from './types.ts'

/**
 * Verify a complete pack, including its PDF digest and read-only SQLite metadata.
 * @param publishedRoot - operator-owned collection directory, not staging.
 * @param id - immutable pack identifier, never a path.
 * @returns finite source-only metadata; no grouping eligibility is granted.
 */
export async function validatePackFiles(publishedRoot: string, id: string): Promise<PackManifest> {
  const root = await directory(publishedRoot)
  const packId = resourcePackId(id)
  const pack = join(root, packId)
  await exactEntries(pack, ['manifest.json', 'reference.sqlite', 'sources'])
  await exactEntries(join(pack, 'sources'), ['national.pdf'])
  const manifest = parseManifest(await readJson(join(pack, 'manifest.json')))
  if (manifest.packId !== packId) throw new DrgResourceError('invalid-resource', 'Pack directory and manifest identities differ.')
  const pdf = await readArtifact(join(pack, manifest.source.path), 128 * 1024 * 1024)
  const sqlite = await readArtifact(join(pack, manifest.database.path), 1024 * 1024)
  if (digest(pdf) !== manifest.source.sha256 || pdf.length !== manifest.source.bytes || pdf.subarray(0, 5).toString('ascii') !== '%PDF-'
    || digest(sqlite) !== manifest.database.sha256 || sqlite.length !== manifest.database.bytes) {
    throw new DrgResourceError('invalid-resource', 'Published artifact hash, size, or PDF header failed; restore a verified pack.')
  }
  validateDatabase(join(pack, manifest.database.path), manifest)
  return manifest
}

/**
 * Verify a registered pack against its catalog digest, including withdrawn revisions.
 * @param publishedRoot - existing published collection.
 * @param id - registered immutable revision.
 * @returns complete source-only metadata; withdrawal still prevents default reads.
 */
export async function validatePack(publishedRoot: string, id: string): Promise<PackManifest> {
  const packId = resourcePackId(id)
  const catalog = await readCatalog(publishedRoot)
  const record = catalog.packs.find(pack => pack.packId === packId)
  if (!record) throw new DrgResourceError('unavailable', 'Reference revision is not registered; inspect interrupted publication before recovery.')
  const manifest = await validatePackFiles(publishedRoot, packId)
  if (digest(await readArtifact(join(publishedRoot, packId, 'manifest.json'), 1024 * 1024)) !== record.manifestSha256) {
    throw new DrgResourceError('invalid-resource', 'Manifest hash differs from its catalog record; inspect the publication.')
  }
  return manifest
}

/**
 * Read publication metadata without opening any database for writing.
 * @param publishedRoot - existing collection directory.
 * @returns validated catalog; immutable pack checks are separate.
 */
export async function readCatalog(publishedRoot: string): Promise<ResourceCatalog> {
  const root = await directory(publishedRoot)
  return parseCatalog(await readJson(join(root, 'catalog.json')))
}

/**
 * Verify every registered revision and reject unlisted or unknown entries.
 * @param publishedRoot - existing published collection.
 * @returns catalog and bounded pack metadata, including retained withdrawn packs.
 */
export async function readPublishedCollection(publishedRoot: string): Promise<PublishedCollection> {
  const root = await directory(publishedRoot)
  const catalog = await readCatalog(root)
  await exactEntries(root, ['catalog.json', ...catalog.packs.map(pack => pack.packId)])
  const packs: PackManifest[] = []
  for (const record of catalog.packs) {
    const manifest = await validatePackFiles(root, record.packId)
    if (digest(await readArtifact(join(root, record.packId, 'manifest.json'), 1024 * 1024)) !== record.manifestSha256) {
      throw new DrgResourceError('invalid-resource', 'Manifest hash differs from its catalog record; inspect the publication.')
    }
    packs.push(manifest)
  }
  return { catalog, packs }
}

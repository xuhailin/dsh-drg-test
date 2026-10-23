/** Source/version metadata only; no extracted grouping rules or patient records. */
import { DatabaseSync } from 'node:sqlite'
import type { PackManifest } from './types.ts'
import { DrgResourceError } from './format.ts'

/** Monotonic SQLite metadata layout version; other versions are rejected. */
export const SCHEMA_VERSION = 1

type SourceMetadata = Pick<PackManifest, 'packId' | 'edition' | 'derivedRevision' | 'source' | 'profile'>

function fields(manifest: SourceMetadata): Record<string, string> {
  return {
    pack_id: manifest.packId, edition: manifest.edition, derived_revision: manifest.derivedRevision,
    source_url: manifest.source.url, source_sha256: manifest.source.sha256, source_bytes: String(manifest.source.bytes),
    profile: manifest.profile, grouping_ready: 'false',
  }
}

/**
 * Build a standalone DELETE-journal SQLite artifact and close its only writer.
 * @param path - exclusively created staged database path.
 * @param manifest - admitted source metadata.
 * @returns completion after the writer closes.
 */
export function createDatabase(path: string, manifest: SourceMetadata): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    const insert = db.prepare('INSERT INTO archive_metadata(key,value) VALUES (?,?)')
    for (const [key, value] of Object.entries(fields(manifest))) insert.run(key, value)
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
  } finally {
    db.close()
  }
}

/**
 * Open only read-only, checking physical integrity, schema, and exact metadata.
 * @param path - hash-verified SQLite artifact in a read-only publication.
 * @param manifest - metadata expected in the database.
 * @returns completion after the connection closes; errors invalidate the pack.
 */
export function validateDatabase(path: string, manifest: SourceMetadata): void {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    throw new DrgResourceError('invalid-resource', 'Cannot open the reference database read-only; restore a verified pack.', { cause: error })
  }
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
    const version = db.prepare('PRAGMA user_version').get()
    const integrity = db.prepare('PRAGMA quick_check(1)').get()
    const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all()
    if (version?.user_version !== SCHEMA_VERSION || integrity?.quick_check !== 'ok'
      || schema.length !== 1 || schema[0]?.name !== 'archive_metadata'
      || schema[0].sql !== 'CREATE TABLE archive_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT') {
      throw new DrgResourceError('invalid-resource', 'Reference database schema or physical integrity failed; restore a verified pack.')
    }
    const rows = db.prepare('SELECT key,value FROM archive_metadata LIMIT 10').all()
    const expected = fields(manifest)
    if (rows.length !== Object.keys(expected).length || rows.some(row => typeof row.key !== 'string' || row.value !== expected[row.key])) {
      throw new DrgResourceError('invalid-resource', 'Reference database metadata differs from its manifest; restore a verified pack.')
    }
  } catch (error) {
    if (error instanceof DrgResourceError) throw error
    throw new DrgResourceError('invalid-resource', 'Reference database validation failed; restore a verified pack.', { cause: error })
  } finally {
    db.close()
  }
}

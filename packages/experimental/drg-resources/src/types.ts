/** Immutable source archives and mutable reference-selection metadata. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Operator-selected immutable publication identity. */
export type ResourcePackId = Branded<'DrgResourcePackId'>
/** SHA-256 digest of exact retained bytes. */
export type ResourceDigest = Branded<'DrgResourceDigest'>

/** Original publication with independently supplied expected digest. */
export interface PublishSourceInput {
  readonly packId: string
  readonly edition: string
  readonly derivedRevision: string
  readonly sourceFile: string
  readonly sourceUrl: string
  readonly expectedSha256: string
}

/** The only artifact profile currently admitted; it cannot execute grouping. */
export interface PackManifest {
  readonly schemaVersion: 1
  readonly profile: 'source-only'
  readonly packId: ResourcePackId
  readonly edition: string
  readonly derivedRevision: string
  readonly publishedAt: string
  readonly source: {
    readonly path: 'sources/national.pdf'
    readonly url: string
    readonly sha256: ResourceDigest
    readonly bytes: number
  }
  readonly database: {
    readonly path: 'reference.sqlite'
    readonly sha256: ResourceDigest
    readonly bytes: number
    readonly schemaVersion: 1
  }
  readonly readiness: {
    readonly groupingReady: false
    readonly dictionary: 'not-provided'
    readonly engine: 'not-implemented'
    readonly rules: 'not-extracted-or-reviewed'
  }
}

/** Catalog availability affects references, never grouping authorization. */
export interface ResourceCatalog {
  readonly schemaVersion: 1
  readonly revision: number
  readonly referenceDefault: ResourcePackId | null
  readonly packs: readonly {
    readonly packId: ResourcePackId
    readonly manifestSha256: ResourceDigest
    readonly availability: 'available' | 'withdrawn'
  }[]
}

/** Validated published collection, without arbitrary file or SQL access. */
export interface PublishedCollection {
  readonly catalog: ResourceCatalog
  readonly packs: readonly PackManifest[]
}

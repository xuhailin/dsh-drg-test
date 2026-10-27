import { describe, expect, it } from 'vitest'
import { lockReference, parseLockReference } from '../src/locks.ts'
import { applyChange, validateLocks } from '../src/change.ts'
import { readDefinition } from '../src/emr/definition-reader.ts'
import { commitRequestSchema } from '../src/protocol.ts'

describe('EMR local identities in reference locks', () => {
  it.each(['reference#one', 'reference%23one', '#'.repeat(128), '临床#路径%一', 'reference~one'])('retains object and field locks for %s', (localId) => {
    const document = readDefinition({ format: 'emr-clinical-pathway-definition', schemaVersion: 1, clinicalPathway: {
      localId, name: null, feesRange: null, inpatDayRange: null, diagnoseGroup: [], inclusionAssessment: [], treatments: [],
    } })
    const candidate = structuredClone(document)
    candidate.clinicalPathway.name = 'Proposed name'
    for (const field of [undefined, 'name']) {
      const lock = lockReference(localId, field)
      expect(parseLockReference(lock)).toEqual({ localId, field: field ?? null })
      expect(validateLocks(document, [lock])).toEqual([lock])
      expect(() => applyChange(document, candidate, document, [lock])).toThrow('conflict')
      expect(commitRequestSchema.safeParse({ sessionId: 'owner', requestId: 'lock', baseRevision: 1, definition: document, locks: [lock] }).success).toBe(true)
    }
  })
  it('distinguishes an object identity containing the delimiter from another object’s name field', () => {
    const objectLock = lockReference('item#name'), fieldLock = lockReference('item', 'name')
    expect(objectLock).not.toBe(fieldLock)
    expect(parseLockReference(objectLock)).toEqual({ localId: 'item#name', field: null })
    expect(parseLockReference(fieldLock)).toEqual({ localId: 'item', field: 'name' })
    expect(parseLockReference('item#name#extra')).toBeNull()
    expect(parseLockReference('item%2F')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { lockReference } from '../src/locks.ts'
import { identifiedObjects, visibleLocks } from '../src/client/presentation.ts'

describe('preview lock identities match the saved reference', () => {
  it.each(['reference#one', 'reference%23one', '#'.repeat(128), '临床#路径%一', 'reference~one'])('shows object and field locks for %s', (localId) => {
    const objects = identifiedObjects({ localId, name: null })
    for (const field of [undefined, 'name']) {
      const lock = lockReference(localId, field)
      expect(visibleLocks(localId, objects, [lock])).toEqual([{ lock, field: field ?? null, inherited: false }])
    }
  })
})

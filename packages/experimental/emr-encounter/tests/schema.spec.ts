/** Wire records refuse identity overrides and ambiguous source references. */
import { describe, expect, it } from 'vitest'
import { parseLaunchClaim, parseSnapshot } from '../src/index.ts'

describe('clinical exchange validation', () => {
  it('accepts explicit identifiers while rejecting raw SQL, actor and unsafe numeric identifiers', () => {
    const claim = { eventId: 'one', trigger: 'open', sourceSystem: 'fixture', hospitalCode: '1001', inpatId: '9007199254740993' }
    expect(parseLaunchClaim(claim).inpatId).toBe('9007199254740993')
    expect(() => parseLaunchClaim({ ...claim, actorId: 'forged' })).toThrow()
    expect(() => parseLaunchClaim({ ...claim, sql: 'select * from patient' })).toThrow()
    expect(() => parseLaunchClaim({ ...claim, inpatId: 9007199254740993 })).toThrow()
    expect(() => parseLaunchClaim({ ...claim, inpatId: '1 OR 1=1' })).toThrow()
  })
  it('refuses snapshots without complete category coverage', () => {
    expect(() => parseSnapshot({ schemaVersion: 1, bindingId: '98080182-bc4d-4fe6-99bd-c539d2465843', caseRevision: 'a'.repeat(64), providerRevision: 'fixture', capturedAt: '2026-01-01T00:00:00.000Z', cutoff: '2026-01-01T00:00:00.000Z', sources: [], coverage: [] })).toThrow()
  })
})

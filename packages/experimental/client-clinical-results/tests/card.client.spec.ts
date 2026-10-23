import { describe, expect, it } from 'vitest'
import { cardFromRecord, resultCardDefinition } from '../src/client/result-card.ts'

const report = { reportId: 'first-report', findings: [{ title: 'synthetic' }] }
const data = { schemaVersion: 1, ownerSessionId: 'synthetic-session',
  binding: { bindingId: 'synthetic-binding', sourceSystem: 'synthetic', hospitalCode: 'test', inpatId: '42', inpatCode: 'SYNTHETIC' },
  report, history: [], snapshot: { coverage: [{ status: 'complete' }, { status: 'unread' }] } }
const event = { type: 'plugin:clinical-review/state', time: Date.parse('2026-10-23T01:00:00Z'), data }

describe('saved report cards', () => {
  it('uses accepted unique report order rather than capture attempts for its immutable selection', () => {
    expect(cardFromRecord(event)).toMatchObject({ ref: { sessionId: 'synthetic-session', resultId: 'clinical-result:synthetic-session',
      revision: 1 }, findingCount: 1, coverageGaps: 1 })
    const second = { ...event, data: { ...data, report: { ...report, reportId: 'second-report' }, history: [report, report] } }
    expect(cardFromRecord(second)?.ref.revision).toBe(2)
    expect(cardFromRecord({ ...event, data: { ...data, report: null, history: [report] } })).toBeUndefined()
    expect(cardFromRecord({ ...event, type: 'assistant/message' })).toBeUndefined()
    expect(cardFromRecord({ ...event, data: { ...data, schemaVersion: 2 } })).toBeUndefined()
  })

  it('matches durable report records and retains the original acceptance metadata on later state updates', () => {
    const card = cardFromRecord(event)!
    expect(resultCardDefinition.kind).toBe('clinical-result')
    expect(resultCardDefinition.match(event as never)).toEqual({ id: report.reportId, role: 'start' })
    const later = { ...event, time: event.time + 10000 }
    expect(resultCardDefinition.update({ state: card } as never, { event: later } as never)).toBe(card)
    expect(card.generatedAt).toBe('2026-10-23T01:00:00.000Z')
  })
})

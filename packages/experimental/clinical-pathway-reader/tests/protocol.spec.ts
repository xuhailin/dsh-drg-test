/** Model and wire requests preserve exact identities and reject unsupported query authority. */
import { expect, it } from 'vitest'
import { caseRequestSchema, historyRequestSchema, pathwayRequestSchema } from '../src/protocol.ts'

const history = { from: '2025-04-01T00:00:00+08:00', to: '2025-05-01T00:00:00+08:00', timeBasis: 'discharge' }

it('keeps bigint identities exact and applies explicit bounded read defaults', () => {
  expect(pathwayRequestSchema.parse({ pathwayId: '9223372036854775807' })).toEqual({
    pathwayId: '9223372036854775807', offset: 0, limit: 20,
  })
  expect(historyRequestSchema.parse(history)).toMatchObject({ ...history, mode: 'summary', diagnosisSystem: 'icd',
    mainDiagnosisOnly: false, offset: 0, limit: 20 })
  expect(caseRequestSchema.parse({ inpatId: '123', category: 'encounter' })).toEqual({
    inpatId: '123', category: 'encounter', start: 0, length: 4000, offset: 0, limit: 20,
  })
  expect(caseRequestSchema.parse({ inpatId: '123', category: 'documents', recordId: '10', contentId: '20', start: 12, length: 10 }))
    .toMatchObject({ recordId: '10', contentId: '20', start: 12, length: 10 })
})

it.each(['9223372036854775808', '9999999999999999999', '0', '-1', '01', '1; SELECT 1', '1.5'])(
  'rejects unsupported source identifier %s', (value) => {
    expect(pathwayRequestSchema.safeParse({ pathwayId: value }).success).toBe(false)
    expect(caseRequestSchema.safeParse({ inpatId: value, category: 'encounter' }).success).toBe(false)
  },
)

it('rejects arbitrary SQL, injected scope grants and unknown selectors at the model boundary', () => {
  for (const extra of [{ sql: 'SELECT synthetic' }, { actor: 'synthetic-actor' }, { admissionFrom: history.from }]) {
    expect(pathwayRequestSchema.safeParse(extra).success).toBe(false)
    expect(historyRequestSchema.safeParse({ ...history, ...extra }).success).toBe(false)
    expect(caseRequestSchema.safeParse({ inpatId: '123', category: 'orders', ...extra }).success).toBe(false)
  }
})

it.each([{ recordId: '10' }, { contentId: '20' }, { start: 1 }])(
  'rejects document-only selection on another encounter category: %j', (selector) => {
    expect(caseRequestSchema.safeParse({ inpatId: '123', category: 'diagnoses', ...selector }).success).toBe(false)
  },
)

it.each([{ offset: -1 }, { offset: 100001 }, { limit: 0 }, { limit: 101 }, { departmentCodes: [] }])(
  'rejects an unbounded or invalid read request: %j', (selection) => {
    expect(pathwayRequestSchema.safeParse(selection).success).toBe(false)
  },
)

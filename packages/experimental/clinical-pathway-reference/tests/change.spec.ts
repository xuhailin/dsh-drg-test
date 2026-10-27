import { describe, expect, it } from 'vitest'
import { applyChange, ReferenceConflict } from '../src/change.ts'
import { readDefinition } from '../src/emr/definition-reader.ts'
import type { DefinitionDocument, SingleOrderDefinition, TreatmentDefinition } from '../src/emr/definition.generated.d.ts'

function fixture(): DefinitionDocument {
  return readDefinition({ format: 'emr-clinical-pathway-definition', schemaVersion: 1, clinicalPathway: {
    localId: 'pathway', name: 'Synthetic reference', feesRange: null, inpatDayRange: [1, 4],
    diagnoseGroup: [], inclusionAssessment: [], treatments: [
      { localId: 'phase-a', name: 'Days 1–2', nodeAttribute: 0, inpatDayRange: [1, 2], parentTreatmentLocalId: null,
        branchs: [], recordTreatmentProjects: [], nursingTreatmentProjects: [], orderTreatmentProjects: [
          { localId: 'order-a', projectType: 0, levelType: 1, name: 'Synthetic A', code: 'A', drugCode: 'A', drugId: 101,
            specs: 'Synthetic specification', onceDose: { value: 0, adjustable: null }, unit: { code: 'U', name: 'Synthetic unit' },
            frequency: { code: 'F1', name: 'Synthetic frequency' }, usage: { code: 'R1', name: 'Synthetic route' } },
          { localId: 'order-b', projectType: 0, levelType: 1, name: 'Synthetic B', code: 'B', drugCode: 'B' },
        ] },
      { localId: 'phase-b', name: 'Days 3–4', nodeAttribute: 0, inpatDayRange: [3, 4], parentTreatmentLocalId: 'phase-a',
        branchs: [], recordTreatmentProjects: [], nursingTreatmentProjects: [], orderTreatmentProjects: [] },
    ],
  } })
}
function phase(document: DefinitionDocument, id = 'phase-a'): TreatmentDefinition {
  const value = document.clinicalPathway.treatments?.find(entry => entry.localId === id)
  if (value === undefined) throw new Error('Fixture phase is absent')
  return value
}
function order(document: DefinitionDocument, id = 'order-a'): SingleOrderDefinition {
  const value = document.clinicalPathway.treatments?.flatMap(entry => entry.orderTreatmentProjects ?? [])
    .find(entry => entry.localId === id)
  if (value?.levelType !== 1) throw new Error('Fixture single order is absent')
  return value
}
function changeDose(document: DefinitionDocument): void {
  order(document).onceDose = { value: 1, adjustable: null }
}
function moveOrder(document: DefinitionDocument): void {
  const source = phase(document), target = phase(document, 'phase-b')
  const item = order(document)
  source.orderTreatmentProjects = source.orderTreatmentProjects?.filter(entry => entry.localId !== item.localId) ?? []
  target.orderTreatmentProjects = [...(target.orderTreatmentProjects ?? []), item]
}

describe('reference changes retain their clinical context', () => {
  it('retains independent edits to another object', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    order(current, 'order-b').name = 'Independent note'
    const result = applyChange(base, candidate, current, [])
    expect(order(result).onceDose?.value).toBe(1)
    expect(order(result, 'order-b').name).toBe('Independent note')
    expect(order(base).onceDose?.value).toBe(0)
  })

  it('retains an independent label edit on the same stable order', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    order(current).name = 'Reviewed label'
    const result = applyChange(base, candidate, current, [])
    expect(order(result).name).toBe('Reviewed label')
    expect(order(result).onceDose?.value).toBe(1)
  })

  it('requires a new preview after the containing phase dates change', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    phase(current).inpatDayRange = [2, 3]
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
    expect(order(current).onceDose?.value).toBe(0)
  })

  it('requires a new preview after the date basis changes', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    phase(current).nodeAttribute = 1
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
  })

  it('requires a new preview after the target moves to another phase', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    moveOrder(current)
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
  })

  it.each(['order-a', 'order-a#onceDose'])('protects %s when its containing phase dates change', (lock) => {
    const base = fixture(), candidate = structuredClone(base)
    phase(candidate).inpatDayRange = [2, 3]
    expect(() => applyChange(base, candidate, base, [lock])).toThrow(ReferenceConflict)
    expect(phase(base).inpatDayRange).toEqual([1, 2])
  })

  it('protects a locked item when a structural change moves it', () => {
    const base = fixture(), candidate = structuredClone(base)
    moveOrder(candidate)
    expect(() => applyChange(base, candidate, base, ['order-a'])).toThrow(ReferenceConflict)
  })

  it('allows editing an independent unlocked item', () => {
    const base = fixture(), candidate = structuredClone(base)
    changeDose(candidate)
    const result = applyChange(base, candidate, base, ['order-b'])
    expect(order(result).onceDose?.value).toBe(1)
    expect(order(result, 'order-b')).toEqual(order(base, 'order-b'))
  })

  it('does not apply an old medication parameter to a replacement drug', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    Object.assign(order(current), { code: 'REPLACEMENT', drugCode: 'REPLACEMENT', drugId: 102 })
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
  })

  it('does not apply an old dose proposal after route or frequency changes', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    order(current).usage = { code: 'R2', name: 'Another synthetic route' }
    order(current).frequency = { code: 'F2', name: 'Another synthetic frequency' }
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
  })

  it('rejects competing edits to the same dose', () => {
    const base = fixture(), candidate = structuredClone(base), current = structuredClone(base)
    changeDose(candidate)
    order(current).onceDose = { value: 2, adjustable: null }
    expect(() => applyChange(base, candidate, current, [])).toThrow(ReferenceConflict)
  })
})

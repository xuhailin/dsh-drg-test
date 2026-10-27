/** Read-only projections over EMR-owned data; no alternate clinical schema is constructed. */
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReferenceKey } from './locales.ts'
import { parseLockReference } from '../locks.ts'

/** A generic object inspected without changing its EMR field names or values. */
export type ClinicalObject = Record<string, unknown>
/**
 * Inspect a clinical JSON value without changing it.
 * @param value - JSON value.
 * @returns The object, or null for unknown/non-object values.
 */
export function objectOf(value: unknown): ClinicalObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ClinicalObject : null
}
/**
 * Inspect a clinical collection while preserving unknown collections.
 * @param value - A clinical collection.
 * @returns Objects or null when the collection is unknown.
 */
export function collectionOf(value: unknown): ClinicalObject[] | null {
  return Array.isArray(value) ? value.map(objectOf).filter((entry): entry is ClinicalObject => entry !== null) : null
}
/**
 * Read a stable local identity without inventing one.
 * @param value - Clinical object.
 * @returns Its stable local identity, never a name or array position.
 */
export function localIdOf(value: ClinicalObject): string | null { return typeof value.localId === 'string' ? value.localId : null }
/**
 * Display an available clinical name with localized unknown text.
 * @param value - Clinical object.
 * @param t - Localized unknown/name copy.
 * @returns Display name with no invented clinical value.
 */
export function nameOf(value: ClinicalObject, t: Translate<ReferenceKey>): string {
  for (const field of ['name', 'drugName', 'orderName', 'inclusionItem', 'evaluationCriteria', 'pathwayName', 'deptName', 'itemName', 'operationName']) {
    if (typeof value[field] === 'string' && value[field] !== '') return value[field]
  }
  return t('unnamed')
}
/**
 * Display clinical values while preserving zero, empty collections, and unknowns.
 * @param value - Source value.
 * @param t - Localized null/empty/boolean labels.
 * @returns A display string preserving zero and unknowns.
 */
export function valueText(value: unknown, t: Translate<ReferenceKey>): string {
  if (value === null || value === undefined) return t('unknown')
  if (typeof value === 'boolean') return t(value ? 'yes' : 'no')
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.length === 0 ? t('emptyCollection') : value.map(entry => valueText(entry, t)).join(' · ')
    const object = objectOf(value)
    if (object !== null && 'name' in object) return valueText(object.name, t)
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value.toString()
  return t('unknown')
}
/**
 * Index identified clinical objects for selection and comparison.
 * @param root - EMR shared definition.
 * @returns All identified objects without rebuilding their contents.
 */
export function identifiedObjects(root: unknown): Map<string, ClinicalObject> {
  const result = new Map<string, ClinicalObject>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return }
    const object = objectOf(value)
    if (object === null) return
    const id = localIdOf(object)
    if (id !== null) result.set(id, object)
    for (const child of Object.values(object)) visit(child)
  }
  visit(root)
  return result
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = objectOf(value)
  if (object !== null) return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}
/**
 * Compare JSON content independently of object-key order.
 * @param before - Baseline value.
 * @param after - Viewed value.
 * @returns Whether JSON content is equal irrespective of object-key order.
 */
export function sameValue(before: unknown, after: unknown): boolean { return canonical(before) === canonical(after) }

/**
 * Display complete changed values, including dictionary codes.
 * @param value - Difference value.
 * @param t - Localized unknowns.
 * @returns Complete objects, including codes hidden by compact name labels.
 */
export function differenceText(value: unknown, t: Translate<ReferenceKey>): string {
  return value !== null && typeof value === 'object' ? JSON.stringify(value, null, 2) : valueText(value, t)
}
/** Visible lock scope matches host object IDs and object#field locks. */
export interface VisibleLock { lock: string; field: string | null; inherited: boolean }
/**
 * Find direct and inherited locks covering a selected object.
 * @param id - Selected local identity.
 * @param objects - Shared definition objects.
 * @param locks - Host lock strings.
 * @returns Direct and inherited locks that cover this object.
 */
export function visibleLocks(id: string, objects: Map<string, ClinicalObject>, locks: readonly string[]): VisibleLock[] {
  return locks.flatMap<VisibleLock>((lock) => {
    const reference = parseLockReference(lock)
    if (reference === null) return []
    const { localId: ownerId, field } = reference
    if (ownerId === id) return [{ lock, field, inherited: false }]
    const owner = objects.get(ownerId)
    if (owner === undefined) return []
    return identifiedObjects(field === null ? owner : owner[field]).has(id)
      ? [{ lock, field, inherited: true }] : []
  })
}

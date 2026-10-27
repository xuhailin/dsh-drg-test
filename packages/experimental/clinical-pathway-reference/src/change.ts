/** Three-way reference changes preserve independent object edits and reject overlapping fields. */
import { readDefinition } from './emr/definition-reader.ts'
import type { DefinitionDocument } from './emr/definition.generated.d.ts'
import { lockReference, parseLockReference } from './locks.ts'

type ObjectValue = Record<string, unknown>
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/**
 * Serialize JSON with stable object-key ordering.
 * @param value - JSON content.
 * @returns Stable JSON for equality and operation identities.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'undefined'
  return JSON.stringify(value)
}
/** A changed field could not be applied to the saved current value. */
export class ReferenceConflict extends Error {
  /**
   * Identify the clinical field requiring a refreshed proposal.
   * @param path - Conflicting clinical field or identity.
   */
  constructor(readonly path: string) { super(`Reference conflict at ${path}; refresh the saved draft and propose this change again.`) }
}
function id(value: unknown): string | undefined { return object(value) && typeof value.localId === 'string' ? value.localId : undefined }
function identified(value: unknown): value is ObjectValue[] { return Array.isArray(value) && value.every(entry => id(entry) !== undefined) }
function merge(base: unknown, candidate: unknown, current: unknown, path: string): unknown {
  if (canonical(base) === canonical(candidate)) return current
  if (canonical(base) === canonical(current) || canonical(candidate) === canonical(current)) return candidate
  if (object(base) && object(candidate) && object(current)) {
    const result = new Map(Object.entries(current))
    for (const key of new Set([...Object.keys(base), ...Object.keys(candidate)])) {
      const next = merge(base[key], candidate[key], current[key], `${id(base) ?? path}.${key}`)
      if (next === undefined) result.delete(key); else result.set(key, next)
    }
    return Object.fromEntries(result)
  }
  if (identified(base) && identified(candidate) && identified(current)) {
    const before = base.map(id), after = candidate.map(id), now = current.map(id)
    const changedOrder = canonical(before) !== canonical(after)
    if (changedOrder && canonical(before) !== canonical(now) && canonical(after) !== canonical(now)) throw new ReferenceConflict(path)
    const order = changedOrder ? after : now
    const byId = (items: ObjectValue[]) => new Map(items.map(item => [id(item), item]))
    const b = byId(base), a = byId(candidate), c = byId(current)
    return order.map(key => merge(b.get(key), a.get(key), c.get(key), `${path}[${String(key)}]`))
  }
  throw new ReferenceConflict(path)
}
/**
 * Index stable identities and their containing objects.
 * @param value - Shared document.
 * @returns Local identities and the identified ancestors containing them.
 */
export function objects(value: unknown): Map<string, { value: ObjectValue; ancestors: string[] }> {
  const found = new Map<string, { value: ObjectValue; ancestors: string[] }>()
  const visit = (entry: unknown, ancestors: string[]): void => {
    if (Array.isArray(entry)) { for (const item of entry) visit(item, ancestors); return }
    if (!object(entry)) return
    const key = id(entry)
    if (key !== undefined) found.set(key, { value: entry, ancestors })
    for (const child of Object.values(entry)) visit(child, key === undefined ? ancestors : [...ancestors, key])
  }
  visit(value, [])
  return found
}
const scopeFields = ['inpatDayRange', 'nodeAttribute', 'parentTreatmentId', 'parentTreatmentLocalId', 'clinicalAttributes',
  'sort', 'levelType', 'required', 'singleUse', 'repeatable', 'groupCode', 'code', 'drugId', 'drugCode', 'specs',
  'orderClass', 'orderSubClass', 'orderTermType', 'unit', 'frequency', 'usage', 'usageType', 'execDept', 'orderTypeCode',
  'days', 'baseDose', 'baseDose1', 'baseUnitName', 'baseUnitName1', 'sendUnit', 'minUnitName', 'packUnitName', 'packQty',
  'doseUnitCode', 'doseUnitName', 'dosageCode', 'dosageName', 'sendPackQty', 'herbTypeCode', 'isApplyOrder', 'applyData']
function context(index: ReturnType<typeof objects>, key: string): unknown {
  const entry = index.get(key)
  if (entry === undefined) return null
  return [...entry.ancestors, key].map((ancestor) => {
    const target = index.get(ancestor)
    if (target === undefined) throw new ReferenceConflict(`${ancestor}.scope`)
    return { localId: ancestor,
      fields: Object.fromEntries(scopeFields.filter(field => field in target.value).map(field => [field, target.value[field]])),
    }
  })
}
function own(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => id(entry) === undefined ? own(entry) : { localId: id(entry) })
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, own(child)]))
}
/**
 * Identify directly changed objects while retaining their local identities.
 * @param before - Base document.
 * @param after - Candidate document.
 * @returns Directly changed stable object identities.
 */
export function changedIds(before: DefinitionDocument, after: DefinitionDocument): string[] {
  const b = objects(before), a = objects(after)
  return [...new Set([...b.keys(), ...a.keys()])].filter(key => canonical(own(b.get(key)?.value)) !== canonical(own(a.get(key)?.value)))
}
/**
 * Merge a complete proposal while enforcing saved clinical scope and locks.
 * @param base - Candidate's saved base.
 * @param candidate - Complete proposed definition.
 * @param current - Latest saved definition.
 * @param locks - Object IDs or object#field locks.
 * @returns Validated merged document.
 */
export function applyChange(
  base: DefinitionDocument, candidate: DefinitionDocument, current: DefinitionDocument, locks: readonly string[],
): DefinitionDocument {
  const baseObjects = objects(base), candidateObjects = objects(candidate), currentObjects = objects(current)
  for (const key of changedIds(base, candidate)) {
    if (baseObjects.has(key) && candidateObjects.has(key) && currentObjects.has(key)
      && canonical(context(baseObjects, key)) !== canonical(context(currentObjects, key))) throw new ReferenceConflict(`${key}.scope`)
  }
  const result = readDefinition(merge(base, candidate, current, 'clinicalPathway'))
  const before = objects(current), after = objects(result)
  for (const lock of locks) {
    const reference = parseLockReference(lock)
    if (reference === null) throw new ReferenceConflict(lock)
    const { localId: key, field } = reference
    const b = before.get(key), a = after.get(key)
    if (canonical(context(before, key)) !== canonical(context(after, key))) throw new ReferenceConflict(`${lock}.scope`)
    if (field === null) {
      if (canonical(b?.value) !== canonical(a?.value)) throw new ReferenceConflict(lock)
    } else if (canonical(b?.value[field]) !== canonical(a?.value[field])) throw new ReferenceConflict(lock)
  }
  return result
}
/**
 * Reject lock targets absent from the saved definition.
 * @param definition - Saved definition.
 * @param locks - Requested object IDs or object#field locks.
 * @returns Normalized lock list.
 */
export function validateLocks(definition: DefinitionDocument, locks: readonly string[]): string[] {
  const known = objects(definition)
  const normalized: string[] = []
  for (const lock of locks) {
    const reference = parseLockReference(lock)
    if (reference === null) throw new ReferenceConflict(lock)
    const { localId: key, field } = reference
    const target = known.get(key)
    if (target === undefined || (field !== null && !(field in target.value))) throw new ReferenceConflict(lock)
    normalized.push(lockReference(key, field ?? undefined))
  }
  return [...new Set(normalized)].sort()
}

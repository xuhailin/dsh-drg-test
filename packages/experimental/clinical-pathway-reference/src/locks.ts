/** Unambiguous lock references preserve every EMR local identity, including percent and delimiter characters. */
function encode(value: string): string { return value.replaceAll('%', '%25').replaceAll('#', '%23') }
function decode(value: string): string | null {
  if (/%(?!23|25)/i.test(value)) return null
  return value.replace(/%23/gi, '#').replace(/%25/gi, '%')
}
/**
 * Encode a local object or field lock without changing its EMR identity.
 * @param localId - Exact shared local identity.
 * @param field - Optional clinical field name.
 * @returns Percent-escaped identity, optionally followed by an unescaped field separator.
 */
export function lockReference(localId: string, field?: string): string {
  return encode(localId) + (field === undefined ? '' : `#${encode(field)}`)
}
/**
 * Read a lock reference, decoding only the reserved percent and separator characters.
 * @param value - Object or object#field reference.
 * @returns Exact identity and field, or null for an invalid reference.
 */
export function parseLockReference(value: string): { localId: string; field: string | null } | null {
  const [owner = '', field, extra] = value.split('#')
  const localId = decode(owner), decodedField = field === undefined ? null : decode(field)
  if (extra !== undefined || localId === null || localId === '' || (field !== undefined && (decodedField === null || decodedField === ''))) return null
  return { localId, field: decodedField }
}

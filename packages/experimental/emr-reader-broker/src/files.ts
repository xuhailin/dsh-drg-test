/** Bounded server-only configuration reads. */
import { open } from 'node:fs/promises'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'

/**
 * Read a complete file without allocating its unbounded size.
 * @param path - Operator-configured file path.
 * @param maxBytes - Maximum UTF-8 file bytes.
 * @returns Complete text or a safe configuration failure.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    if (size > maxBytes) throw new EncounterReadError('source-unavailable', 'A clinical configuration file exceeds its configured byte limit.')
    return bytes.subarray(0, size).toString('utf8')
  } finally { await file.close() }
}

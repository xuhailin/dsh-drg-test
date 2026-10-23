/** Filesystem checks for a trusted operator-owned local archive root. */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { DrgResourceError } from './format.ts'
import type { ResourceDigest } from './types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

/**
 * Hash exact artifact bytes.
 * @param bytes - complete bounded artifact.
 * @returns lowercase SHA-256.
 */
export function digest(bytes: Uint8Array): ResourceDigest {
  return brandString<ResourceDigest>(createHash('sha256').update(bytes).digest('hex'))
}

/**
 * Admit a directory without following its final symlink.
 * @param path - directory to inspect.
 * @returns canonical path; parent directories must be operator controlled.
 */
export async function directory(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DrgResourceError('invalid-resource', `Expected a real directory: ${path}`)
  return realpath(path)
}

/**
 * Read a bounded regular file through one no-follow descriptor.
 * @param path - admitted file location.
 * @param maxBytes - maximum accepted size.
 * @returns bytes; no file is created or changed.
 */
export async function readArtifact(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new DrgResourceError('invalid-resource', `Expected a regular unlinked artifact: ${path}`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.ino !== info.ino || actual.dev !== info.dev || actual.size > maxBytes) {
      throw new DrgResourceError('invalid-resource', `Artifact changed or exceeds its byte limit: ${path}`)
    }
    const bytes = Buffer.alloc(actual.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset !== actual.size) throw new DrgResourceError('invalid-resource', `Artifact size changed while reading: ${path}`)
    return bytes.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

/**
 * Parse bounded UTF-8 JSON and retain an actionable structured diagnostic.
 * @param path - regular metadata file.
 * @returns decoded external value.
 */
export async function readJson(path: string): Promise<unknown> {
  const bytes = await readArtifact(path, 1024 * 1024)
  try {
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return decoded
  } catch (error) {
    throw new DrgResourceError('invalid-resource', `Invalid JSON metadata: ${path}`, { cause: error })
  }
}

/**
 * Reject unrecognized entries, including SQLite WAL/SHM files and links.
 * @param path - directory to enumerate.
 * @param names - complete required direct entry names.
 * @returns completion after exact directory admission.
 */
export async function exactEntries(path: string, names: readonly string[]): Promise<void> {
  await directory(path)
  const entries = await readdir(path)
  if (entries.length !== names.length || entries.some(entry => !names.includes(entry))) {
    throw new DrgResourceError('invalid-resource', `Unexpected or missing archive files: ${resolve(path)}`)
  }
}

/**
 * Flush a local directory entry update; unsupported filesystems fail visibly.
 * @param path - directory whose entries were changed.
 * @returns completion once the filesystem accepts synchronization.
 */
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Write a new bounded metadata or artifact file and flush its bytes.
 * @param path - missing destination.
 * @param bytes - complete content.
 * @param mode - explicit POSIX permissions.
 * @returns completion after close and synchronization.
 */
export async function writeNew(path: string, bytes: string | Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

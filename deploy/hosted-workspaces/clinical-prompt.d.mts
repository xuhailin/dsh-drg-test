/** Clinical-only suppression of Harness development instructions and implementation paths. */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin identity. */
export const name: string
/** Required scoped prompt registry. */
export const inject: string[]
/**
 * Shadow development-only sections and context while retaining tool instructions.
 * @param ctx - Clinical preset scope.
 */
export function apply(ctx: Context): void

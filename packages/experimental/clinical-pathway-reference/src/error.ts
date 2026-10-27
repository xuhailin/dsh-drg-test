/** Structured failures keep unsaved or ambiguous state separate from confirmed revisions. */
export class ReferenceError extends Error {
  /**
   * Describe a failed operation without discarding confirmed reference state.
   * @param code - Stable failure discriminator.
   * @param message - Actionable explanation.
   */
  constructor(readonly code: 'forbidden' | 'invalid-request' | 'not-found' | 'conflict' | 'limit-exceeded' | 'durability-unknown' | 'unavailable', message: string) { super(message) }
}

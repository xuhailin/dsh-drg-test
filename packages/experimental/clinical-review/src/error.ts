/** Safe diagnostics returned independently of EMR discharge operations. */
export class ClinicalReviewError extends Error {
  override readonly name = 'ClinicalReviewError'
  /**
 * @param code - Stable handling category.
 * @param message - Actionable diagnostic without source credentials.
 */
  constructor(readonly code: string, message: string) { super(message) }
}

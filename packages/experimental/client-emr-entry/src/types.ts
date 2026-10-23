/** Public entry settings contain no credentials or patient content. */
export interface EntryConfig {
  /** Exact HTTP(S) origins allowed to send launch messages from an opener or parent window. */
  readonly allowedOrigins: string[]
  /** Initial source-system value in the manual entry form; it grants no access. */
  readonly defaultSourceSystem: string
  /** Initial hospital value in the manual entry form; the broker still authorizes it. */
  readonly defaultHospitalCode: string
  /** Maximum browser wait for one launch, review, or refresh request, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Maximum concurrent browser operation requests. */
  readonly maxPendingRequests: number
  /** Maximum UTF-8 JSON bytes accepted in one window launch message. */
  readonly maxMessageBytes: number
}

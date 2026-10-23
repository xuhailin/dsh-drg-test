/** Public, nonclinical deployment settings for the saved-result viewer. */
export interface ViewerConfig {
  /** Exact parent/opener origins permitted to complete the embedding handshake. */
  readonly allowedOrigins: string[]
  /** Maximum duration of one authenticated browser request. */
  readonly requestTimeoutMs: number
  /** Maximum UTF-8 JSON bytes accepted from the embedding host. */
  readonly maxMessageBytes: number
  /** Maximum outstanding embedding action requests retained by one view. */
  readonly maxPendingRequests: number
  /** Maximum completed embedding receipts retained by one view. */
  readonly maxActionReceipts: number
  /** Maximum patient rows requested in one directory page. */
  readonly directoryPageSize: number
}

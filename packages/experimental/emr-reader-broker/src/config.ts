/** Gateway-only paths and explicit operating bounds for clinical reads. */
import z from '@deepseek-ai/schemastery'
/** Credentials and policy are mounted only in the controlled gateway. */
export interface Config {
  /** Source-system identity accepted by the encounter allowlist. */
  sourceSystem: string
  /** Gateway-only JSON file containing PostgreSQL connection credentials. */
  databaseConfigFile: string
  /** Gateway-only JSON file mapping authenticated accounts to permitted encounters. */
  allowlistFile: string
  /** Gateway-only file containing the persistent encounter-binding signing key. */
  bindingKeyFile: string
  /** Lifetime in milliseconds of an unconsumed launch grant. */
  grantTtlMs: number
  /** Maximum number of unconsumed launch grants retained in memory. */
  maxPendingGrants: number
  /** Maximum UTF-8 bytes accepted in a complete broker request body. */
  maxRequestBytes: number
  /** Maximum UTF-8 bytes returned in a complete evidence snapshot. */
  maxResponseBytes: number
  /** Maximum UTF-8 bytes accepted for one original source body. */
  maxSourceBytes: number
  /** Maximum records accepted per supported evidence category. */
  maxRowsPerCategory: number
  /** Maximum patients returned in one directory page. */
  maxDirectoryPageSize: number
  /** Maximum bytes read from the encounter allowlist file. */
  maxPolicyBytes: number
  /** Deadline in milliseconds for one broker operation and its database queries. */
  requestTimeoutMs: number
  /** Maximum broker operations admitted concurrently across all accounts. */
  maxConcurrentReads: number
}
/** Validated deployment settings; no patient or credential is embedded in config. */
export const Config: z<Partial<Config>, Config> = z.object({
  sourceSystem: z.string().required(), databaseConfigFile: z.string().required(),
  allowlistFile: z.string().required(), bindingKeyFile: z.string().required(),
  grantTtlMs: z.number().min(1000).max(600000).default(300000), maxPendingGrants: z.number().min(1).max(10000).default(200),
  maxRequestBytes: z.number().min(1).max(1048576).default(16384), maxResponseBytes: z.number().min(1).max(67108864).default(4194304),
  maxSourceBytes: z.number().min(1).max(16777216).default(262144), maxRowsPerCategory: z.number().min(1).max(10000).default(500),
  maxDirectoryPageSize: z.number().min(1).max(1000).default(50),
  maxPolicyBytes: z.number().min(1).max(16777216).default(1048576), requestTimeoutMs: z.number().min(100).max(120000).default(15000),
  maxConcurrentReads: z.number().min(1).max(100).default(4),
})

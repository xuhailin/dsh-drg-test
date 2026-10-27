/** Optional gateway/provider configuration; database secrets remain gateway-only. */
import s from '@deepseek-ai/schemastery'

/** The same plugin is explicitly mounted as either a gateway reader or preset tools. */
export interface Config {
  /** Select the gateway provider or the scoped tool consumer. */
  mode: 'gateway' | 'tools'
  /** Source identity required in gateway mode. */
  sourceSystem?: string
  /** Gateway-only PostgreSQL credential file. */
  databaseConfigFile?: string
  /** Gateway-only account, hospital, department and admission-window policy. */
  policyFile?: string
  /** Expected PostgreSQL schema; each transaction pins and verifies this search path. */
  schema: string
  /** Require a SELECT-only role, or explicitly reuse a development role inside enforced read-only transactions. */
  readRolePolicy: 'select-only' | 'development-transaction-only'
  /** Authenticated hosted gateway URL; required in tools mode. */
  brokerBaseUrl?: string
  /** Server-owned credential name; required in tools mode. */
  runtimeTokenEnv: string
  /** Maximum bytes in a complete gateway request. */
  maxRequestBytes: number
  /** Maximum bytes read from an operator-owned policy or database file. */
  maxPolicyBytes: number
  /** Maximum bytes in the complete response and rendered model result. */
  maxResponseBytes: number
  /** Maximum original JSON row bytes acquired from PostgreSQL. */
  maxRowBytes: number
  /** Maximum rows per child collection, independent of model-requested pagination. */
  maxRows: number
  /** Maximum document passage characters per read. */
  maxTextChars: number
  /** Maximum recursively expanded branch depth. */
  maxBranchDepth: number
  /** Maximum expanded branch definitions. */
  maxBranches: number
  /** Enable the separately installed whole-prescription tables. */
  herbalTables: boolean
  /** Enable operation-detail rows after target-schema verification. */
  operationTables: boolean
  /** Enable scoped item dictionary interpretation and current same-hospital drug conversion parameters. */
  dictionaryTables: boolean
  /** Complete request deadline, including database work and body consumption. */
  timeoutMs: number
  /** Gateway-wide concurrent read admission bound. */
  maxConcurrentReads: number
}
/** Validate operating bounds before mounting either role. */
export const Config: s<Partial<Config>, Config> = s.object({
  mode: s.union(['gateway', 'tools'] as const).required(), sourceSystem: s.string(),
  databaseConfigFile: s.string(), policyFile: s.string(), schema: s.string().default('public'),
  readRolePolicy: s.union(['select-only', 'development-transaction-only'] as const).default('select-only'),
  brokerBaseUrl: s.string(), runtimeTokenEnv: s.string().default('HOSTED_RUNTIME_API_KEY'),
  maxRequestBytes: s.natural().min(1).max(1048576).default(16384),
  maxPolicyBytes: s.natural().min(1).max(16777216).default(1048576),
  maxResponseBytes: s.natural().min(512).max(16777216).default(262144),
  maxRowBytes: s.natural().min(128).max(1048576).default(65536),
  maxRows: s.natural().min(1).max(1000).default(200), maxTextChars: s.natural().min(1).max(12000).default(12000),
  maxBranchDepth: s.natural().min(1).max(10).default(4), maxBranches: s.natural().min(1).max(100).default(20),
  herbalTables: s.boolean().default(false), operationTables: s.boolean().default(false), dictionaryTables: s.boolean().default(false),
  timeoutMs: s.natural().min(100).max(120000).default(30000), maxConcurrentReads: s.natural().min(1).max(100).default(4),
})

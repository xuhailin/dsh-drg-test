/** Deployment-owned reader routing and complete-output limits. */
import z from '@deepseek-ai/schemastery'

/** Hosted review settings; upstream model configuration stays in the normal DSH profile. */
export interface Config {
  /** HTTP(S) broker base URL for authorized launch and evidence requests. */
  readonly brokerBaseUrl: string
  /** Credential or process-environment name containing the private runtime token. */
  readonly runtimeTokenEnv: string
  /** Fixed authenticated owner identity supplied by the hosted gateway. */
  readonly ownerId: string
  /** Private working directory assigned to newly created encounter Sessions. */
  readonly cwd: string
  /** Existing Agent preset for new encounter Sessions; omission uses the standard default. */
  readonly agentPreset?: string
  /** Complete broker request deadline in milliseconds, including the response body. */
  readonly timeoutMs: number
  /** Maximum bytes in one complete broker response. */
  readonly maxResponseBytes: number
  /** Maximum UTF-8 bytes in the complete model-visible text-block array. */
  readonly maxToolBytes: number
  /** Maximum UTF-16 code units returned in one original evidence passage. */
  readonly maxSourceChars: number
  /** Maximum findings accepted in one model-proposed report. */
  readonly maxFindings: number
  /** Maximum retained deduplication event identities per encounter Session. */
  readonly maxOperations: number
  /** Maximum retained historical reports per encounter Session. */
  readonly maxReports: number
  /** Maximum bytes in one complete browser API request. */
  readonly maxRequestBytes: number
  /** Maximum UTF-8 bytes in the complete retained review state. */
  readonly maxStateBytes: number
  /** Maximum source metadata entries returned per inventory page. */
  readonly maxInventoryItems: number
  /** HTTP evidence reader or an independently mounted EncounterReader provider. */
  readonly readerMode: 'http' | 'provided'
  /** Requested language for report fields and the final model reply. */
  readonly reviewLanguage: string
}
/** Validate configuration before any patient-related requests are admitted. */
export const Config: z<Partial<Config>, Config> = z.object({
  brokerBaseUrl: z.string().required(), runtimeTokenEnv: z.string().required(), ownerId: z.string().required(),
  cwd: z.string().required(), agentPreset: z.string(), readerMode: z.union(['http', 'provided'] as const).default('http'),
  reviewLanguage: z.string().min(1).max(100).default('zh-CN'),
  timeoutMs: z.natural().min(1).max(2_147_483_647).default(30_000),
  maxResponseBytes: z.natural().min(1).default(8 * 1024 * 1024),
  maxToolBytes: z.natural().min(1).default(64 * 1024), maxSourceChars: z.natural().min(1).default(12_000),
  maxInventoryItems: z.natural().min(1).default(20),
  maxFindings: z.natural().min(1).default(40), maxOperations: z.natural().min(1).default(256),
  maxReports: z.natural().min(1).default(50), maxStateBytes: z.natural().min(1).default(32 * 1024 * 1024),
  maxRequestBytes: z.natural().min(1).default(64 * 1024),
})

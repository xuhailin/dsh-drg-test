/** Credential-free scope and bounded persistence settings for the optional reference owner. */
import z from '@deepseek-ai/schemastery'
import type { ReferenceConfig } from './types.ts'
/** Runtime settings are explicit deployment inputs, independent of source-read permission. */
export type Config = ReferenceConfig
/** Validate deployment settings before registering routes or tools. */
export const Config: z<Config, Config> = z.object({
  scope: z.object({ sourceSystem: z.string().required(), hospitalCode: z.string().required(),
    departmentCodes: z.array(z.string()).required(), departmentBasis: z.const('current').required(),
    admissionFrom: z.string().required(), admissionTo: z.string().required(),
  }).required(),
  maxRequestBytes: z.natural().min(1).required(), maxStateBytes: z.natural().min(1).required(), maxRevisions: z.natural().min(1).required(),
})

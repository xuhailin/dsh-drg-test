/** Bounded PostgreSQL transactions with transport cancellation and no write permission per transaction. */
import pg from 'pg'
import { z } from 'zod'
import { EncounterReadError } from '@deepseek-ai/dsh-experimental-emr-encounter'

/** Dedicated server-only connection settings; source credentials never enter runtime responses. */
export const databaseConfigSchema = z.strictObject({
  host: z.string().min(1), port: z.number().int().min(1).max(65535), database: z.string().min(1),
  user: z.string().min(1), password: z.string().min(1), ssl: z.boolean().optional(),
})
/** Validated server-only PostgreSQL settings. */
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>
/** Read-only SQL executor passed only to the fixed-query provider. */
export interface ReadTransaction { query(sql: string, values: readonly (string | number)[]): Promise<readonly unknown[]> }
/** Transaction capability makes providers independently testable without patient fixtures. */
export interface ReadDatabase {
  /**
 * @param signal - Caller cancellation.
 * @param read - Fixed-query callback.
 * @returns Callback result after read-only transaction completion.
 */
  read<T>(signal: AbortSignal, read: (transaction: ReadTransaction) => Promise<T>): Promise<T>
}

/** Owns one PostgreSQL connection for each consistent read operation. */
export class PgReadDatabase implements ReadDatabase {
  constructor(private readonly config: DatabaseConfig, private readonly timeoutMs: number) {}
  async read<T>(signal: AbortSignal, read: (transaction: ReadTransaction) => Promise<T>): Promise<T> {
    checkCancellation(signal)
    const client = new pg.Client({ ...this.config, connectionTimeoutMillis: this.timeoutMs, query_timeout: this.timeoutMs, statement_timeout: this.timeoutMs, application_name: 'dsh-emr-reader' })
    let closed: Promise<void> | undefined
    const close = (): Promise<void> => closed ??= client.end()
    const abort = (): void => {
      void close().catch((error: unknown) => {
        void error // An interrupted source connection is discarded.
      })
    }
    client.on('error', abort)
    signal.addEventListener('abort', abort, { once: true })
    try {
      await client.connect()
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const result = await read({ query: async (sql, values) => {
        checkCancellation(signal)
        const response = await client.query<Record<string, unknown>>(sql, [...values])
        return response.rows
      } })
      checkCancellation(signal)
      await client.query('COMMIT')
      return result
    } catch (error) {
      checkCancellation(signal)
      if (error instanceof EncounterReadError) throw error
      throw new EncounterReadError('source-unavailable', 'The clinical source could not complete a read. Retry after checking the source connection.', { cause: error })
    } finally {
      signal.removeEventListener('abort', abort)
      await close()
      client.off('error', abort)
    }
  }
}

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new EncounterReadError('cancelled', 'Clinical read was cancelled.')
}

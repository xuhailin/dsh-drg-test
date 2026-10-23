/** Feature-owned wording and setup controls for the shared conversation. */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'

/** Presentation selected from the current Session summary without changing its capabilities. */
export interface ConversationPresentation {
  /** Unique owner of this contribution. */
  readonly id: string
  /**
   * `managed` uses an existing Session's nonempty cwd and omits workspace/preset selectors.
   * Omission keeps workspace selection required for blank Sessions. Never creates a Session or grants access.
   */
  readonly workspaceSelection?: 'managed'
  /**
   * Match only the supplied summary; do not read mutable external state.
   * @param session - current Session summary, absent before a Session exists.
   * @returns whether this copy applies to this conversation occurrence.
   */
  matches(session: SessionSummary | undefined): boolean
  /** @returns welcome heading in the active locale. */
  headline(): string
  /** @returns short welcome context in the active locale. */
  badge(): string
  /** @returns message invitation in the active locale. */
  placeholder(): string
}

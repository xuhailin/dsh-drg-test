/** Session-matched welcome and composer copy contributed by feature plugins. */
import type { ConversationPresentation } from '../contract/presentation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** First matching contribution wins; disposal restores the remaining contribution or default copy. */
export class ConversationPresentationRegistry extends ConversationDefinitionRegistry<ConversationPresentation> {
  /**
   * Register localized copy for the caller's lifetime.
   * @param presentation - uniquely identified matcher and locale-bound text callbacks.
   * @returns idempotent disposer.
   */
  register(presentation: ConversationPresentation): () => void {
    return this.registerDefinition(presentation.id, presentation,
      `conversation presentation "${presentation.id}" is already registered`,
      `uiConversation.presentations.register(${JSON.stringify(presentation.id)})`)
  }
}

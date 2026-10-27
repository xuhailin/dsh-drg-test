/** Preset-only header contribution and shell modal for saved pathway references. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { configSchema } from '../protocol.ts'
import { ReferenceController } from './controller.ts'
import { en, zh, type ReferenceKey } from './locales.ts'
import { ReferenceButton, ReferenceOverlay, type ReferenceInjected } from './Preview.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Private structured pathway preview copy. */
    'clinical-pathway-reference': ReferenceKey
  }
}
/** Services used only through reversible slot and locale contributions. */
export const inject = ['slots', 'locale']

/**
 * Load public settings and register reversible preview contributions.
 * @param ctx - Browser plugin context.
 * @returns Completion of public config loading and reversible registrations.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  const response = await fetch('api/pathway-reference/config', { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal })
  if (!response.ok) throw new Error('clinical-pathway-reference: public settings unavailable')
  const config = configSchema.parse(await response.json())
  lifetime.signal.throwIfAborted()
  const controller = new ReferenceController(config, fetch)
  ctx.effect(() => () => { controller.dispose() })
  ctx.effect(() => ctx.locale.register('clinical-pathway-reference', { en, zh }))
  const face: ReferenceInjected = { config, hooks: { reference: controller.view },
    show: (id) => { void controller.show(id) }, leave: (id) => { controller.leave(id) },
    observeRevision: (id, revision) => { controller.observeRevision(id, revision) },
    close: () => { controller.close() }, refresh: () => { void controller.refresh() },
    create: (mode, title, sourceEventSeq) => { void controller.create(mode, title, sourceEventSeq) },
  }
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'clinical-pathway-reference', locale: 'clinical-pathway-reference', inject: () => face,
  }, ReferenceButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'clinical-pathway-reference', locale: 'clinical-pathway-reference', inject: () => face,
  }, ReferenceOverlay))
  ctx.on('connection/reset', () => { controller.close() })
}

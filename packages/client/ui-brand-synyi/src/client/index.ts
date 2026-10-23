/** Synyi occupants for the browser's sidebar and welcome-screen brand slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SynyiBrandMark, SynyiBrandName } from './Brand.tsx'
import { en, zh, type SynyiBrandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Synyi brand names displayed by this plugin. */
    synyiBrand: SynyiBrandKey
  }
}

/** Services required by the brand occupants. */
export const inject = ['slots', 'locale']

/**
 * Supply Synyi branding whenever the declaring surfaces are present.
 * @param ctx - Client root context owning all registrations.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('synyiBrand', { zh, en }), 'ui-brand-synyi: dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, SynyiBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: 'synyiBrand' }, SynyiBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, SynyiBrandMark))
}

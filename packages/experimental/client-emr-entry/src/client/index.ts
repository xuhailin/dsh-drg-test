/** Optional EMR context entry through existing authenticated review endpoints. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { EntryActions } from './actions.ts'
import { EntryButton, EntryOverlay, ReviewButton, type EntryInjected } from './Entry.tsx'
import { entryConfig, parseLaunchMessage } from './protocol.ts'
import { en, zh, type EntryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** EMR encounter entry and non-blocking review copy. */
    'emr-entry': EntryKey
  }
}
/** Browser services used for slots, navigation, and localization. */
export const inject = ['slots', 'locale', 'uiWorkspace']

/**
 * Bind the authenticated entry form and messages from explicitly allowed EMR windows.
 * @param ctx - browser plugin context.
 * @returns completion of authenticated settings loading and reversible registrations.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  const response = await fetch('/api/emr-entry/config', { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal })
  if (!response.ok) throw new Error('client-emr-entry: public settings unavailable')
  const config = entryConfig.parse(await response.json())
  lifetime.signal.throwIfAborted()
  const actions = new EntryActions(config, fetch, (id) => { ctx.uiWorkspace.openSession(id) })
  ctx.effect(() => () => actions.dispose())
  ctx.effect(() => ctx.locale.register('emr-entry', { en, zh }))
  const face: EntryInjected = {
    hooks: { entry: actions.view }, config,
    show: (id) => { actions.show(id) }, close: () => { actions.close() }, dismiss: () => { actions.dismiss() },
    launch: (claim) => { void actions.launch(claim).catch((_error: unknown) => { /* The shared notice reports the outcome. */ }) },
    review: (id) => { void actions.review(id).catch((_error: unknown) => { /* The shared notice reports the outcome. */ }) },
    refresh: (id) => { void actions.refresh(id).catch((_error: unknown) => { /* The shared notice reports the outcome. */ }) },
    updateStatus: () => { void actions.updateStatus() },
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'emr-entry', locale: 'emr-entry', inject: () => face,
  }, EntryButton))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'emr-review', locale: 'emr-entry', inject: () => face,
  }, ReviewButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'emr-entry', locale: 'emr-entry', inject: () => face,
  }, EntryOverlay))
  const sources = [window.opener as Window | null, window.parent !== window ? window.parent : null]
    .filter((value): value is Window => value !== null)
  const listener = (event: MessageEvent<unknown>): void => {
    const target = sources.find(source => source === event.source)
    if (target === undefined || !config.allowedOrigins.includes(event.origin)) return
    const claim = parseLaunchMessage(event.data, config.maxMessageBytes)
    if (claim === undefined) return
    const reply = (value: object): void => {
      if (lifetime.signal.aborted) return
      try { target.postMessage({ type: 'dsh.emr.launch.result', eventId: claim.eventId, dischargeBlocked: false, ...value }, event.origin) }
      catch (_closedSource) { /* Local review remains available when the source window can no longer receive acknowledgements. */ }
    }
    void actions.launch(claim).then((result) => { reply({ status: result.status, sessionId: result.sessionId }) }, () => { reply({ status: 'failed' }) })
  }
  ctx.effect(() => {
    window.addEventListener('message', listener)
    for (const source of sources) for (const origin of config.allowedOrigins) {
      try { source.postMessage({ type: 'dsh.emr.ready' }, origin) }
      catch (_closedSource) { /* The authenticated entry form remains available when its opening window has closed. */ }
    }
    return () => { window.removeEventListener('message', listener) }
  })
}

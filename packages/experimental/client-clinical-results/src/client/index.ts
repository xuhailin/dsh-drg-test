/** Optional saved-result presentation through registered pages, cards, and Sidebar tabs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SavedCardController } from './saved-cards.ts'
import { DirectoryController } from './directory-controller.ts'
import { ResultEmbedding } from './embedding.ts'
import { PatientWorkspace, PatientIcon, type PatientInjected } from './PatientWorkspace.tsx'
import { resultSelectionSchema } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ResultController } from './controller.ts'
import { Standalone, ResultPanel, ResultTitle, type PanelInjected, type ViewerInjected } from './ResultView.tsx'
import { ResultCards, type CardsInjected } from './ResultCards.tsx'
import { resultCardDefinition } from './result-card.ts'
import { parseResultAddress, resultAddress, selectionFromSearch, viewerConfigSchema } from './protocol.ts'
import { en, zh, type ResultsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Saved clinical result presentation and read-state copy. */
    'clinical-results': ResultsKey
  }
}
/** Standalone presentation requires no Conversation or Sidebar services. */
export const inject = ['slots', 'locale', 'clientPages']

/**
 * Register one saved-result renderer in both containers and withdraw every contribution on unload.
 * @param ctx - browser plugin services and lifetime.
 * @returns completion of authenticated public settings loading.
 */
export async function apply(ctx: Context): Promise<void> {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  const response = await fetch('api/clinical-results/config', { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal })
  if (!response.ok) throw new Error('client-clinical-results: public settings unavailable')
  const config = viewerConfigSchema.parse(await response.json())
  lifetime.signal.throwIfAborted()
  ctx.effect(() => ctx.locale.register('clinical-results', { en, zh }))
  const standalone = new ResultController(config, fetch)
  const workspaceResult = new ResultController(config, fetch)
  const directory = new DirectoryController(config, fetch,
    () => { workspaceResult.clear() }, selection => workspaceResult.open(selection))
  const embedding = new ResultEmbedding(config, {
    open: async (selection) => {
      await standalone.open(selection)
      if (!['ready', 'choose', 'empty'].includes(standalone.view.getSnapshot().phase)) throw new Error('Result selection unavailable.')
    },
    clear: () => { standalone.clear() },
    launch: async (claim, signal) => {
      const response = await fetch('api/clinical-review/launch', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim),
        signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(config.requestTimeoutMs)]) })
      if (!response.ok) throw new Error('Encounter launch rejected.')
      const value: unknown = await response.json()
      return resultSelectionSchema.parse(value !== null && typeof value === 'object' && 'sessionId' in value ? { sessionId: value.sessionId } : {})
    },
    rerun: async (selection, requestId) => {
      const current = standalone.view.getSnapshot().result
      if (current === null || current.sessionId !== selection.sessionId || current.encounterRef !== selection.encounterRef
        || current.resultId !== selection.resultId || current.revision !== selection.revision) return null
      const receipt = await standalone.rerun(requestId)
      if (receipt === null && standalone.view.getSnapshot().rerun === 'unknown') throw new Error('Review admission unknown.')
      return receipt
    },
    authorize: async (selection) => {
      await standalone.refresh()
      const current = standalone.view.getSnapshot()
      return current.phase === 'ready' && current.result?.sessionId === selection.sessionId
        && current.result.resultId === selection.resultId && current.result.revision === selection.revision
        && current.result.encounterRef === selection.encounterRef
    },
    selection: () => {
      const result = standalone.view.getSnapshot().result
      return result === null ? null : { sessionId: result.sessionId, resultId: result.resultId,
        revision: result.revision, encounterRef: result.encounterRef }
    },
  })
  ctx.effect(() => embedding.start())
  ctx.effect(() => standalone.view.subscribe(() => {
    const phase = standalone.view.getSnapshot().phase
    if (phase === 'login' || phase === 'denied') embedding.authorizationLost()
  }))
  ctx.effect(() => () => { directory.dispose(); workspaceResult.dispose() })
  const panels = new Map<string, ResultController>()
  const savedCards = new Map<SessionId, SavedCardController>()
  const initial = selectionFromSearch(window.location.search)
  const directPage = window.parent === window && window.opener === null
    && new URLSearchParams(window.location.search).get('page') === 'clinical-results'
  ctx.effect(() => () => { for (const cards of savedCards.values()) cards.dispose(); savedCards.clear() })
  ctx.on('connection/reset', () => {
    const selection = standalone.view.getSnapshot().selection ?? initial
    embedding.invalidate(); directory.clear(); workspaceResult.clear()
    for (const panel of panels.values()) panel.clear()
    for (const cards of savedCards.values()) cards.clear()
    if (directPage && selection !== undefined) void standalone.open(selection)
  })
  ctx.effect(() => () => { standalone.dispose(); for (const panel of panels.values()) panel.dispose(); panels.clear() })
  if (directPage && initial !== undefined) void standalone.open(initial)
  const face: ViewerInjected = {
    hooks: { viewer: standalone.view },
    select: (ref) => { void standalone.select(ref) }, refresh: () => { void standalone.refresh() },
    rerun: () => { void standalone.rerun() },
  }
  ctx.effect(() => ctx.clientPages.register({ page: 'clinical-results', key: 'clinical-results' }))
  ctx.slots.inject('shell.page', () => ctx.slots.register({
    name: 'shell.page', key: 'clinical-results', locale: 'clinical-results', inject: () => face,
  }, Standalone))

  const panelFor = (address: string): ResultController => {
    let panel = panels.get(address)
    if (panel === undefined) {
      panel = new ResultController(config, fetch)
      panels.set(address, panel)
      const ref = parseResultAddress(address)
      if (ref !== undefined) void panel.open(ref)
    }
    return panel
  }
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (sidebarCtx) => {
    const id = '@deepseek-ai/dsh-experimental-client-clinical-results'
    const t = sidebarCtx.locale.bind('clinical-results')
    sidebarCtx.effect(() => sidebarCtx.sidebarRightTabs.register({ id, kind: 'clinical-result', priority: 'builtin',
      patterns: ['dsh-resource://clinical-result/**'], canOpen: address => parseResultAddress(address) !== undefined, title: () => t('title') }))
    const panelFace: PanelInjected = {
      keyedHooks: { viewer: address => panelFor(address).view },
      select: (address, ref) => { void panelFor(address).select(ref) }, refresh: (address) => { void panelFor(address).refresh() },
      rerun: (address) => { void panelFor(address).rerun() },
    }
    sidebarCtx.slots.inject('sidebar.right.pane.tab', () => sidebarCtx.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale: 'clinical-results', inject: () => panelFace,
    }, ResultPanel))
    sidebarCtx.slots.inject('sidebar.right.pane.tab.title', () => sidebarCtx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: id, locale: 'clinical-results',
    }, ResultTitle))
    sidebarCtx.inject(['uiConversation', 'sessions'], (chatCtx) => {
      chatCtx.effect(() => chatCtx.uiConversation.events.register(resultCardDefinition))
      chatCtx.slots.inject('conversation.chat.turnTail', () => chatCtx.slots.register({
        name: 'conversation.chat.turnTail', id, locale: 'clinical-results',
        inject: (sessionId: SessionId): CardsInjected => {
          const binding = chatCtx.sessions.binding(sessionId)
          if (binding === undefined) throw new Error('clinical-results: Session binding unavailable')
          const chat = chatCtx.uiConversation.binding(binding).target('chat')
          let cards = savedCards.get(sessionId)
          if (cards === undefined) { cards = new SavedCardController(config, fetch); savedCards.set(sessionId, cards) }
          const confirmedCards = cards
          return { ownerSessionId: sessionId, hooks: { confirmed: confirmedCards.view },
            confirm: (ref, reportId, retry) => { void confirmedCards.confirm(ref, reportId, retry) },
            open: (ref) => { chatCtx.sidebarRight.openResource(resultAddress(ref)) },
            keyedHooks: { results: (turn) => {
              const snapshot = chat.getSnapshot()
              if (snapshot === undefined) throw new Error('clinical-results: Chat target unavailable')
              return snapshot.nodes.turnDataSource(Number(turn), 'clinical-result')
            } } }
        },
      }, ResultCards))
    })
  })
  ctx.inject(['layout', 'uiWorkspace'], (patientCtx) => {
    const patientFace: PatientInjected = {
      hooks: { viewer: workspaceResult.view, directory: directory.view },
      select: (ref) => { void workspaceResult.select(ref) }, refresh: () => { void workspaceResult.refresh() },
      rerun: () => { void workspaceResult.rerun() },
      loadDepartments: () => { void directory.load() },
      chooseDepartment: (department) => { void directory.choose(department) },
      loadPage: (index, search) => { void directory.page(index, search) },
      openPatient: (patient, department) => { void directory.open(patient, department) },
      beginReview: () => { void directory.review() },
      openChat: () => { const id = directory.view.getSnapshot().sessionId; if (id !== null) patientCtx.uiWorkspace.openSession(id) },
    }
    patientCtx.slots.inject('main', () => patientCtx.slots.register({ name: 'main', key: 'clinical-patients', locale: 'clinical-results', inject: () => patientFace }, PatientWorkspace))
    patientCtx.slots.inject('sidebar.panellist', () => patientCtx.slots.register({ name: 'sidebar.panellist', id: 'clinical-patients', locale: 'clinical-results',
      label: () => patientCtx.locale.bind('clinical-results')('patients'), order: 20,
    }, PatientIcon))
  })

}

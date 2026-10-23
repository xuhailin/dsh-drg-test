/** Existing navigation controls and one shared form for encounter entry. */
import { useState } from 'react'
import clsx from 'clsx'
import { Button, IconChecklistOutlineRegular, IconUserOutlineRegular, Input, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { LaunchClaim } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EntryConfig } from '../types.ts'
import type { EntryView } from './actions.ts'
import type { EntryKey } from './locales.ts'
import css from './Entry.module.css'

/** Narrow callbacks and view-state source injected by the entry owner. */
export interface EntryInjected {
  hooks: { entry: ObservableSnapshot<EntryView> }
  config: EntryConfig
  show(sessionId?: SessionId): void
  close(): void
  dismiss(): void
  launch(claim: LaunchClaim): void
  review(sessionId: SessionId): void
  refresh(sessionId: SessionId): void
  updateStatus(): void
}
type Face = InjectFace<EntryInjected> & PropsLocale<'emr-entry'>

function statusKey(status: NonNullable<EntryView['status']>): EntryKey {
  if (status.durability === 'unknown') return 'statusUnknown'
  if (status.status === 'failed') {
    const code = status.operations.find(operation => operation.revision === status.revision)?.errorCode
    if (code === 'report-not-submitted') return 'statusNotSubmitted'
    if (code === 'model-turn-max-tokens') return 'statusMaxTokens'
  }
  if (status.status === 'reviewed' && !status.reportAvailable) return 'statusNoReport'
  const keys = { bound: 'statusBound', collecting: 'statusCollecting', reviewing: 'statusReviewing', reviewed: 'statusReviewed',
    stale: 'statusStale', failed: 'statusFailed', cancelled: 'statusCancelled' } satisfies Record<NonNullable<EntryView['status']>['status'], EntryKey>
  return keys[status.status]
}

/** @param props - sidebar geometry, localized copy, and entry opener. @returns global encounter-entry action. */
export function EntryButton({ wide, show, t }: PropsRuntime<'sidebar.footer.action'> & Face) {
  return <Tooltip label={t('entry')} disabled={wide}>
    <Button size="sm" icon={<IconUserOutlineRegular size={16} />} aria-label={t('entry')} onClick={() => { show() }}>
      {wide ? t('entry') : null}
    </Button>
  </Tooltip>
}

/** @param props - bound Session, localized copy, and entry opener. @returns the review action in the existing conversation header. */
export function ReviewButton({ sessionId, show, t }: PropsRuntime<'conversation.session.header.actions'> & Face) {
  return <Tooltip label={t('review')}>
    <Button size="sm" variant="toolbar" icon={<IconChecklistOutlineRegular size={16} />}
      aria-label={t('review')} onClick={() => { show(sessionId) }}>
      <span className={css.reviewLabel}>{t('review')}</span>
    </Button>
  </Tooltip>
}

/** @param props - shared transient entry state and operation callbacks. @returns the modal and a notice that survives navigation. */
export function EntryOverlay({ useEntry, config, close, dismiss, launch, review, refresh, updateStatus, t }: PropsRuntime<'shell.overlay'> & Face) {
  const state = useEntry(value => value)
  const [sourceSystem, setSourceSystem] = useState(config.defaultSourceSystem)
  const [hospitalCode, setHospitalCode] = useState(config.defaultHospitalCode)
  const [inpatId, setInpatId] = useState('')
  const [inpatCode, setInpatCode] = useState('')
  return <>
    <Modal open={state.open} onClose={close} title={t(state.sessionId === null ? 'entry' : 'review')} closeLabel={t('close')}
      className={clsx(css.dialog)} contentClassName={clsx(css.modalContent)}>
      <div className={css.content}>
        <p className={css.hint}>{t('hint')}</p>
        {state.sessionId !== null && <div className={css.form} aria-busy={state.statusPhase === 'loading'}>
          {state.statusPhase === 'loading' && state.status === null && <p className={css.hint} role="status">{t('statusLoading')}</p>}
          {state.statusPhase === 'unbound' && <p className={css.hint} role="status">{t('statusUnbound')}</p>}
          {state.statusPhase === 'denied' && <p className={css.hint} role="status">{t('statusDenied')}</p>}
          {state.statusPhase === 'unavailable' && <p className={css.hint} role="status">{t('statusUnavailable')}</p>}
          {state.status !== null && <p className={css.hint} role="status">
            {state.statusPhase !== 'ready' && <>{t('lastKnown')}<br /></>}
            {t(statusKey(state.status))}<br />{t('revision')}{state.status.revision}
          </p>}
          <Button variant="outline" disabled={state.statusPhase === 'loading'} onClick={updateStatus}>{t('updateStatus')}</Button>
        </div>}
        {state.sessionId !== null && <div className={css.actions}>
          <Button variant="primary" disabled={state.busy || state.statusPhase === 'unbound' || state.statusPhase === 'denied'} onClick={() => { if (state.sessionId !== null) review(state.sessionId) }}>{t('start')}</Button>
          <Button variant="outline" disabled={state.busy || state.statusPhase === 'unbound' || state.statusPhase === 'denied'} onClick={() => { if (state.sessionId !== null) refresh(state.sessionId) }}>{t('refresh')}</Button>
        </div>}
        <form className={css.form} onSubmit={(event) => {
          event.preventDefault()
          launch({ eventId: randomUUID(), trigger: 'open', sourceSystem: sourceSystem.trim(), hospitalCode: hospitalCode.trim(),
            inpatId: inpatId.trim(), ...inpatCode.trim() ? { inpatCode: inpatCode.trim() } : {} })
        }}>
          {state.sessionId !== null && <h3>{t('newEncounter')}</h3>}
          <label>{t('sourceSystem')}<Input value={sourceSystem} onChange={(event) => { setSourceSystem(event.target.value) }} required maxLength={512} /></label>
          <label>{t('hospitalCode')}<Input value={hospitalCode} onChange={(event) => { setHospitalCode(event.target.value) }} required maxLength={512} /></label>
          <label>{t('inpatId')}<Input value={inpatId} onChange={(event) => { setInpatId(event.target.value) }} required pattern="[1-9][0-9]{0,18}" maxLength={19} inputMode="numeric" autoComplete="off" /></label>
          <label>{t('inpatCode')}<Input value={inpatCode} onChange={(event) => { setInpatCode(event.target.value) }} maxLength={512} autoComplete="off" /></label>
          <p className={css.hint}>{t('identifiersOnly')}</p>
          <Button type="submit" variant="outline" disabled={state.busy || !sourceSystem.trim() || !hospitalCode.trim() || !inpatId.trim()}>{t('open')}</Button>
        </form>
      </div>
    </Modal>
    {state.notice !== null && <Toast key={state.sequence} text={t(state.notice)} onDone={dismiss}
      {...state.notice === 'failed' ? {} : { tone: 'success' as const }} />}
  </>
}

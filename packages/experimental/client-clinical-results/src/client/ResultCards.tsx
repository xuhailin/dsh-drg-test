/** Keyboard-accessible exact-revision openers beneath the completed review Turn. */
import { useEffect, useMemo } from 'react'
import { Button, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ResultCardData } from './result-card.ts'
import type { CardConfirmation } from './saved-cards.ts'
import type { ResultRef } from './protocol.ts'
import css from './ResultView.module.css'

/** Turn-bound accepted report references and existing Sidebar navigation. */
export interface CardsInjected {
  ownerSessionId: SessionId
  hooks: { confirmed: ObservableSnapshot<CardConfirmation> }
  confirm(ref: ResultRef, reportId: string, retry?: boolean): void
  keyedHooks: { results: (turn: string) => ObservableSnapshot<readonly ResultCardData[]> }
  open(ref: ResultRef): void
}
/**
 * Display saved reports only after their acceptance record is durable.
 * @param props - completed Turn, renderer-bound report data, localized copy, and navigation.
 * @returns exact-revision cards, or no element for a Turn without an accepted report.
 */
export function ResultCards({ turn, useResults, ownerSessionId, open, confirm, useConfirmed, t }: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<CardsInjected> & PropsLocale<'clinical-results'>) {
  const raw = useResults(String(turn.turn))
  const pending = useMemo(() => (raw ?? []).filter(item => item.ref.sessionId === ownerSessionId), [raw, ownerSessionId])
  const confirmed = useConfirmed(value => value)
  useEffect(() => { for (const item of pending) confirm(item.ref, item.reportId) }, [pending, confirm, confirmed.epoch])
  const results = pending.flatMap((item) => {
    const saved = confirmed.confirmed[item.reportId]
    return saved === undefined || saved.generatedAt === null || saved.generatedAt !== item.generatedAt ? [] : [saved]
  })
  if (pending.length === 0) return null
  return <div className={css.cards}>{pending.filter(item => confirmed.unavailable[item.reportId]).map(item => <div key={item.reportId} className={css.notice} role="status">
    <p>{t('cardUnavailable')}</p><Button size="sm" variant="outline" onClick={() => { confirm(item.ref, item.reportId, true) }}>{t('retry')}</Button>
  </div>)}{results.map(result => <button type="button" key={result.reportId} className={css.card}
    onClick={() => { open(result.ref) }} aria-label={`${t('open')} · ${t('revision')} ${result.ref.revision}`}>
    <IconChecklistOutlineRegular size={20} className={css.cardIcon} />
    <span className={css.cardText}><strong>{t('title')}</strong><span>{result.encounterLabel}</span>
      <span>{t('generatedAt')} {result.generatedAt ?? t('unknown')} · {t('revision')} {result.ref.revision} · {t('findingCount', { count: result.findingCount })}</span>
      <span>{result.coverageGaps === null ? t('savedCoverage') : t('coverageGapCount', { count: result.coverageGaps })}</span><span>{t('open')}</span>
    </span>
  </button>)}</div>
}

/** Shared saved-report presentation; neither container interprets chat Markdown. */
import { Button, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ResultResponse, ResultSummary } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import type { ViewerState, ViewerPhase } from './controller.ts'
import type { ResultRef } from './protocol.ts'
import type { ResultsKey } from './locales.ts'
import css from './ResultView.module.css'

type Copy = PropsLocale<'clinical-results'>['t']
/** Plain controller actions and a renderer-bound state source. */
export interface ViewerInjected {
  hooks: { viewer: ObservableSnapshot<ViewerState> }
  select(ref: ResultRef): void
  refresh(): void
  rerun(): void
}
/** Address-keyed panel sources retain independent selected revisions. */
export interface PanelInjected {
  keyedHooks: { viewer: (address: string) => ObservableSnapshot<ViewerState> }
  select(address: string, ref: ResultRef): void
  refresh(address: string): void
  rerun(address: string): void
}

type ViewerInput = {
  state: ViewerState
  select: ViewerInjected['select']
  refresh: ViewerInjected['refresh']
  rerun: ViewerInjected['rerun']
  t: Copy
}

const categories: Record<string, ResultsKey> = { encounter: 'encounterCategory', diagnoses: 'diagnosesCategory', orders: 'ordersCategory',
  documents: 'documentsCategory', labs: 'labsCategory', checks: 'checksCategory', operations: 'operationsCategory', administration: 'administrationCategory' }
function category(value: string, t: Copy): string { const key = categories[value]; return key === undefined ? t('otherCategory') : t(key) }

function Metadata({ entries }: { entries: readonly (readonly [string, string])[] }) {
  return <dl className={css.metadata}>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}
function History({ reports, selected, select, t }: { reports: readonly ResultSummary[]; selected: number | null; select: ViewerInjected['select']; t: Copy }) {
  return <label className={css.selector}>{t('history')}
    <select aria-label={t('history')} value={selected ?? ''} onChange={(event) => {
      const report = reports.find(item => item.revision === Number(event.target.value))
      if (report !== undefined) select(report)
    }}>
      <option value="" disabled>{t('select')}</option>
      {reports.map(report => <option key={report.reportId} value={report.revision}>
        {t('revision')} {report.revision} · {report.generatedAt ?? t('unknown')} · {t('findingCount', { count: report.findingCount })}
      </option>)}
    </select>
  </label>
}

/**
 * Draw the same exact saved report in a Sidebar or standalone page.
 * @param props - immutable report, independent progress, localized copy, and explicit actions.
 * @returns the report and its saved evidence, including incomplete coverage and calculation limits.
 */
export function ResultDocument({ result, select, refresh, rerun, rerunState, t }: {
  result: ResultResponse
  select: ViewerInjected['select']
  refresh: ViewerInjected['refresh']
  rerun: ViewerInjected['rerun']
  rerunState: ViewerState['rerun']
  t: Copy
}) {
  const unknown = t('unknown')
  const coverageDetails = result.coverage.flatMap(item => item.detail === undefined ? [] : [[item.category, item.detail] as const])
  return <article className={css.document} data-clinical-result={result.reportId}>
    <header className={css.header}>
      <div className={css.heading}><span className={css.eyebrow}>{t('pendingReview')}</span><h1>{t('title')}</h1><p>{t('encounterLabel', { label: result.encounterLabel })}</p></div>
      <div className={css.badges}><span>{t(result.revision === result.latestRevision ? 'current' : 'historical')}</span></div>
    </header>
    <section className={`${css.section} ${css.reviewSummary}`} aria-label={t('summary')}>
      <h2>{t('summary')}</h2><p>{result.summary}</p>
      <p className={css.attention}>{t('findingCount', { count: result.findings.length })}</p>
      <p className={css.secondary}>{t('generatedAt')} · {result.generatedAt ?? unknown}</p>
      <div className={css.updateStatus}><h3>{t('freshness')}</h3>
        <p>{t(result.freshness.status === 'changed' ? 'freshnessChanged' : result.freshness.status === 'unchanged' ? 'freshnessUnchanged' : 'freshnessUnknown')}</p>
      </div>
    </section>
    <p className={css.secondary}>{t('disclaimer')}</p>
    <section className={css.section} aria-label={t('findings')}>
      <h2>{t('findings')}</h2>
      {result.findings.length === 0 && <p className={css.notice}>{t('zeroFindings')}</p>}
      {result.findings.map(finding => <section className={css.finding} key={finding.findingId} data-finding-id={finding.findingId}>
        <span className={css.eyebrow}>{t(finding.kind)}</span><h3>{finding.title}</h3>
        <h4>{t('explanation')}</h4><p>{finding.explanation}</p>
        <div className={css.evidence}><h4>{t('evidence')} ({finding.evidenceRefs.length})</h4>
          {finding.evidenceRefs.length === 0 && <p className={css.secondary}>{t('noEvidence')}</p>}
          {finding.evidenceRefs.map(evidence => <div className={css.quotation} key={`${evidence.sourceRef}:${evidence.start}:${evidence.end}`}>
            <p className={css.secondary}>{evidence.source === null ? t('otherCategory') : category(evidence.source.category, t)} · {evidence.source?.occurredAt ?? unknown}</p>
            <blockquote>{evidence.quote}</blockquote>
            {evidence.sourceStatus === 'unavailable' && <p className={css.notice}>{t('missingSource')}</p>}
            <details className={css.technical} data-clinical-source-details><summary>{t('sourceDetails')}</summary>
              <Metadata entries={[
                [t('sourceRef'), evidence.sourceRef], [t('sourceId'), evidence.source?.sourceId ?? unknown],
                [t('sourceRevision'), evidence.source?.sourceRevision ?? unknown], [t('sourceState'), evidence.source?.state ?? unknown],
                [t('sourceCategory'), evidence.source?.category ?? unknown],
                [t('occurredAt'), evidence.source?.occurredAt ?? unknown], [t('availableAt'), evidence.source?.availableAt ?? unknown],
                [t('offsets'), `${evidence.start}–${evidence.end}`],
              ]} />
            </details>
          </div>)}
        </div>
        <h4>{t('suggestion')}</h4><p>{finding.suggestion}</p>
      </section>)}
    </section>
    <section className={css.section} aria-label={t('coverage')}><h2>{t('coverage')}</h2>
      <p className={css.secondary}>{t('coverageNote')}</p>
      {result.snapshotStatus === 'unavailable' && <p className={css.notice}>{t('snapshotUnavailable')}</p>}
      <ul className={css.coverage}>{result.coverage.map(item => <li key={item.category}>
        <span>{category(item.category, t)}</span><span>{t(item.status)}</span>
      </li>)}</ul>
      <p>{result.reviewedSourceRefs.length === 0 ? t('noneReviewed') : t('reviewedCount', { count: result.reviewedSourceRefs.length })}</p>
      {(result.unreviewedSourceRefs.length > 0 || result.snapshotStatus === 'retained') && <p>{result.unreviewedSourceRefs.length === 0
        ? t('unreviewedEmpty') : t('unreviewedCount', { count: result.unreviewedSourceRefs.length })}</p>}
    </section>
    <section className={css.section} aria-label={t('calculation')}><h2>{t('calculation')}</h2>
      <p>{t('calculationNote')}</p>
    </section>
    <section className={css.section} aria-label={t('progress')}><h2>{t('progress')}</h2>
      <p role="status">{t(result.progress.status === 'failed' ? 'progressFailed' : result.progress.status)}</p>
      {rerunState !== 'idle' && <p className={css.notice} role="status">{t(rerunState === 'failed' ? 'rerunFailed' : rerunState === 'unknown' ? 'rerunUnknown' : rerunState)}</p>}
      <div className={css.actions}><Button variant="outline" onClick={refresh}>{t('refresh')}</Button>
        <Button variant="primary" onClick={rerun} disabled={rerunState === 'pending' || rerunState === 'unknown' || ['collecting', 'reviewing'].includes(result.progress.status)}>{t('rerun')}</Button></div>
    </section>
    <details className={css.technical} data-clinical-report-details><summary>{t('reportDetails')}</summary>
      <p className={css.secondary}>{t('legacy')}</p>
      <Metadata entries={[
        [t('revision'), String(result.revision)], [t('capturedAt'), result.capturedAt ?? unknown], [t('cutoff'), result.cutoff ?? unknown],
        [t('evidenceRevision'), result.evidenceRevision], [t('reportId'), result.reportId],
        [t('lastChecked'), result.freshness.lastCheckedAt ?? unknown], [t('comparisonScope'), t(result.freshness.scope === 'none' ? 'comparisonNone' : 'comparisonSnapshot')],
      ]} />
      <History reports={result.history} selected={result.revision} select={select} t={t} />
      {coverageDetails.length > 0 && <><h3>{t('coverageDetails')}</h3><Metadata entries={coverageDetails} /></>}
      <h3>{t('reviewedSources')}</h3>
      {result.reviewedSourceRefs.length === 0 ? <p className={css.secondary}>{t('noneReviewed')}</p>
        : <ul>{result.reviewedSourceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}
      <h3>{t('unreviewed')}</h3>
      {result.unreviewedSourceRefs.length === 0 ? <p className={css.secondary}>{t(result.snapshotStatus === 'unavailable' ? 'snapshotUnavailable' : 'unreviewedEmpty')}</p>
        : <ul>{result.unreviewedSourceRefs.map(ref => <li key={ref}>{ref}</li>)}</ul>}
      <p className={css.secondary}>{t('navigationUnavailable')}</p>
    </details>
  </article>
}

function phaseKey(phase: ViewerPhase): ResultsKey {
  switch (phase) {
    case 'idle': case 'ready': return 'idle'
    case 'loading': return 'loading'
    case 'empty': return 'noReport'
    case 'choose': return 'choose'
    case 'login': return 'login'
    case 'denied': return 'denied'
    case 'not-found': return 'notFound'
    case 'unsupported': return 'unsupportedFormat'
    case 'failed': return 'failed'
  }
}

/**
 * Show one view's report, listing, or explicit failure without hiding a retained report on retry failure.
 * @param props - controller snapshot, localized copy, and narrow user actions.
 * @returns accessible query states and the common saved-report renderer.
 */
export function ResultView({ state, select, refresh, rerun, t }: ViewerInput) {
  return <main className={css.root} aria-label={t('title')} aria-busy={state.phase === 'loading'}>
    {state.phase === 'loading' && state.result === null && <div className={css.empty} role="status" aria-label={t('loading')}><span className={css.spinner} /></div>}
    {state.phase === 'loading' && state.result !== null && <p className={css.notice} role="status">{t('loading')}</p>}
    {state.phase !== 'ready' && state.phase !== 'loading' && <div className={state.result === null ? css.empty : css.notice} role="status">
      <p>{t(phaseKey(state.phase))}</p>
      {state.phase === 'failed' && <Button variant="outline" onClick={refresh}>{t('retry')}</Button>}
      {state.phase === 'choose' && state.listing !== null && <History reports={state.listing.results} selected={null} select={select} t={t} />}
    </div>}
    {state.result !== null && <ResultDocument result={state.result} select={select}
      refresh={refresh} rerun={rerun} rerunState={state.rerun} t={t} />}
  </main>
}

/** @param props - root-scoped result source and actions. @returns the standalone view without a chat dependency. */
export function Standalone({ useViewer, select, refresh, rerun, t }: PropsRuntime<'shell.page'> & InjectFace<ViewerInjected> & PropsLocale<'clinical-results'>) {
  return <ResultView state={useViewer(value => value)} select={select} refresh={refresh} rerun={rerun} t={t} />
}
/**
 * @param props - registered tab identity and independent address-bound viewer actions.
 * @returns the same saved-report view in the existing Sidebar.
 */
export function ResultPanel({ useTabInfo, useViewer, select, refresh, rerun, t }: PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PanelInjected> & PropsLocale<'clinical-results'>) {
  const address = useTabInfo().tab.navigation.address
  const state = useViewer(address)
  return state === undefined ? null : <ResultView state={state} select={(ref) => { select(address, ref) }}
    refresh={() => { refresh(address) }} rerun={() => { rerun(address) }} t={t} />
}
/** @param props - localized registered tab title. @returns the result tab glyph and title. */
export function ResultTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'clinical-results'>) {
  return <><IconChecklistOutlineRegular size={16} />{t('title')}</>
}

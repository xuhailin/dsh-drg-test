/** Preset-local modal for reference creation, clinical inspection, and saved revision comparison. */
import { useEffect, useId, useMemo, useState } from 'react'
import { Button, IconChecklistOutlineRegular, Input, Modal, SegmentedControl, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReferenceConfig, ReferenceRevision, ReferenceScope, ReferenceSource, ReferenceState } from '../types.ts'
import type { ReferencePreviewState } from './controller.ts'
import type { ReferenceKey } from './locales.ts'
import { collectionOf, differenceText, identifiedObjects, localIdOf, nameOf, objectOf, sameValue, valueText, visibleLocks, type ClinicalObject } from './presentation.ts'
import css from './Preview.module.css'

/** Narrow preview actions; no clinical edit or hospital operation is exposed. */
export interface ReferenceInjected {
  hooks: { reference: ObservableSnapshot<ReferencePreviewState> }
  config: ReferenceConfig
  show(sessionId: SessionId): void
  leave(sessionId: SessionId): void
  observeRevision(sessionId: SessionId, revision: number): void
  close(): void
  refresh(): void
  create(mode: 'new' | 'revision', title: string, sourceEventSeq?: number): void
}
type Face = InjectFace<ReferenceInjected> & PropsLocale<'clinical-pathway-reference'>
type T = Translate<ReferenceKey>
type Select = { selected: string | null; select: (id: string) => void; t: T }

/**
 * Render the reference entry for the committed clinical pathway preset.
 * @param props - The owning Session's header props and injected preview actions.
 * @returns The preset-only reference entry.
 */
export function ReferenceButton({ sessionId, useSessions, show, leave, observeRevision, t }: PropsRuntime<'conversation.session.header.actions'> & Face) {
  const enabled = useSessions(value => value.byId[sessionId]?.projectionValues?.agentPreset === 'clinical-pathway-analysis')
  const savedRevision = useSessions(value => value.byId[sessionId]?.projectionValues?.clinicalPathwayReference)
  useEffect(() => {
    if (enabled && typeof savedRevision === 'number') observeRevision(sessionId, savedRevision)
  }, [enabled, savedRevision, observeRevision, sessionId])
  useEffect(() => () => { leave(sessionId) }, [leave, sessionId])
  useEffect(() => { if (!enabled) leave(sessionId) }, [enabled, leave, sessionId])
  if (!enabled) return null
  return <Tooltip label={t('entry')}>
    <Button size="sm" variant="toolbar" icon={<IconChecklistOutlineRegular size={16} />} aria-label={t('entry')}
      onClick={() => { show(sessionId) }}>{t('entry')}</Button>
  </Tooltip>
}

function Scope({ scope, t }: { scope: ReferenceScope; t: T }) {
  return <section className={css.section}>
    <h3>{t('scope')}</h3>
    <dl className={css.metadata}>
      <div><dt>{t('sourceSystem')}</dt><dd>{scope.sourceSystem}</dd></div>
      <div><dt>{t('hospital')}</dt><dd>{scope.hospitalCode}</dd></div>
      <div><dt>{t('departments')}</dt><dd>{scope.departmentCodes.join(' · ')}</dd></div>
      <div><dt>{t('departmentBasis')}</dt><dd>{t('currentDepartment')}</dd></div>
      <div><dt>{t('period')}</dt><dd>{scope.admissionFrom} — {scope.admissionTo}</dd></div>
    </dl>
  </section>
}

function CreateTask({ sources, config, busy, unconfirmed, create, t }: {
  sources: ReferenceSource[]
  config: ReferenceConfig
  busy: boolean
  unconfirmed: boolean
  create: ReferenceInjected['create']
  t: T
}) {
  const id = useId()
  const [mode, setMode] = useState<'new' | 'revision'>('new')
  const [title, setTitle] = useState('')
  const [sourceSeq, setSourceSeq] = useState('')
  const source = sources.find(item => String(item.eventSeq) === sourceSeq)
  return <section className={css.section}>
    <p>{t('empty')}</p>
    <SegmentedControl id={id} value={mode} onChange={setMode} label={t('entry')} disabled={busy || unconfirmed}
      options={[{ value: 'new', label: t('newTask') }, { value: 'revision', label: t('revisionTask') }]} />
    <form className={css.form} role="tabpanel" id={`${id}-${mode}-panel`} aria-labelledby={`${id}-${mode}`} onSubmit={(event) => {
      event.preventDefault()
      if (!busy && !unconfirmed && title.trim() !== '' && (mode === 'new' || source !== undefined)) create(mode, title.trim(), mode === 'revision' ? source?.eventSeq : undefined)
    }}>
      <label>{t('taskTitle')}<Input value={title} onChange={(event) => { setTitle(event.target.value) }} maxLength={200}
        required disabled={busy || unconfirmed} /></label>
      {mode === 'revision' && <>
        <label>{t('source')}<select aria-label={t('source')} value={sourceSeq} onChange={(event) => { setSourceSeq(event.target.value) }} disabled={busy || unconfirmed} required>
          <option value="">{t('chooseSource')}</option>
          {sources.map(item => <option key={item.eventSeq} value={item.eventSeq}>
            {item.label} · {item.definitionId} · {item.readAt}
          </option>)}
        </select></label>
        {sources.length === 0 && <p role="status">{t('noSources')}</p>}
        {source !== undefined && <section className={css.section}><h4>{t('coverage')}</h4><Lines values={source.coverage} t={t} /></section>}
      </>}
      <Scope scope={config.scope} t={t} />
      <div><Button type="submit" variant="primary" disabled={busy || unconfirmed || title.trim() === '' || (mode === 'revision' && source === undefined)}>{t('create')}</Button></div>
    </form>
  </section>
}

function Lines({ values, t }: { values: string[]; t: T }) {
  return values.length === 0 ? <p className={css.secondary}>{t('emptyCollection')}</p>
    : <ul className={css.lines}>{values.map(value => <li key={value}>{value}</li>)}</ul>
}
function EntityName({ value, selected, select, t }: { value: ClinicalObject } & Select) {
  const id = localIdOf(value)
  const label = nameOf(value, t)
  return id === null ? <span>{label}</span> : <button type="button" className={css.entity} aria-pressed={selected === id}
    aria-label={t('selectObject', { name: label })} onClick={() => { select(id) }}>{label}</button>
}
function ObjectList({ value, selected, select, t, assessment = false }: { value: unknown; assessment?: boolean } & Select) {
  const items = collectionOf(value)
  if (items === null || items.length === 0) return <p className={css.secondary}>{t(items === null ? 'unknown' : 'emptyCollection')}</p>
  return <ul className={css.objectList}>{items.map(item => <li key={localIdOf(item) ?? JSON.stringify(item)}>
    <EntityName value={item} selected={selected} select={select} t={t} />
    <span className={css.secondary}>{valueText(item.code ?? item.deptCode ?? item.relatedClinicalPathwayId, t)}</span>
    {assessment && <span>{t('admissionType')}: {t(item.isInclude === true ? 'inclusion' : item.isInclude === false ? 'exclusion' : 'unknown')}</span>}
    {item.required !== undefined && <span>{t(assessment ? 'requiredAssessment' : 'required')}: {valueText(item.required, t)}</span>}
  </li>)}</ul>
}
function Projects({ value, selected, select, t }: { value: unknown } & Select) {
  const items = collectionOf(value)
  if (items === null || items.length === 0) return <p className={css.secondary}>{t(items === null ? 'unknown' : 'emptyCollection')}</p>
  return <div className={css.projects}>{items.map((item) => {
    const children = collectionOf(item.children)
    const herbal = objectOf(item.herbalRecipe)
    const level = item.levelType === 2 ? 'group' : item.levelType === 3 ? 'bundle' : 'single'
    return <article key={localIdOf(item) ?? JSON.stringify(item)} className={css.project}
      data-selected={localIdOf(item) === selected || undefined}>
      <div className={css.rowHeading}><EntityName value={item} selected={selected} select={select} t={t} />
        <span className={css.badge}>{t(herbal === null ? level : 'herbal')}</span>
      </div>
      <dl className={css.itemFields}>
        <div><dt>{t('specification')}</dt><dd>{valueText(item.specs, t)}</dd></div>
        <div><dt>{t('dose')}</dt><dd>{valueText(objectOf(item.onceDose)?.value, t)} {valueText(item.unit, t)}</dd></div>
        <div><dt>{t('usage')}</dt><dd>{valueText(item.usage, t)}</dd></div>
        <div><dt>{t('frequency')}</dt><dd>{valueText(item.frequency, t)}</dd></div>
        <div><dt>{t('term')}</dt><dd>{valueText(item.orderTermType, t)}</dd></div>
        <div><dt>{t('required')}</dt><dd>{valueText(item.required, t)}</dd></div>
      </dl>
      {herbal !== null && <div className={css.nested}><EntityName value={herbal} selected={selected} select={select} t={t} />
        <h5>{t('ingredients')}</h5><IngredientList value={herbal.detail} selected={selected} select={select} t={t} />
      </div>}
      {item.levelType === 2 || item.levelType === 3 ? <details className={css.nested} open>
        <summary>{t(level)} · {children === null ? t('unknown') : children.length}</summary>
        <Projects value={item.children} selected={selected} select={select} t={t} />
      </details> : null}
    </article>
  })}</div>
}
function IngredientList({ value, selected, select, t }: { value: unknown } & Select) {
  const items = collectionOf(value)
  if (items === null || items.length === 0) return <p className={css.secondary}>{t(items === null ? 'unknown' : 'emptyCollection')}</p>
  return <ul className={css.objectList}>{items.map(item => <li key={localIdOf(item) ?? JSON.stringify(item)}>
    <EntityName value={item} selected={selected} select={select} t={t} />
    <span>{t('dose')}: {valueText(item.onceDose, t)} {valueText(item.doseUnitName, t)}</span>
    <span>{t('specification')}: {valueText(item.specs, t)}</span>
  </li>)}</ul>
}
function Phases({ value, selected, select, t }: { value: unknown } & Select) {
  const phases = collectionOf(value)
  if (phases === null || phases.length === 0) return <p className={css.secondary}>{t(phases === null ? 'unknown' : 'emptyCollection')}</p>
  return <div className={css.section}>{phases.map(phase => <section key={localIdOf(phase) ?? JSON.stringify(phase)} className={css.phase}>
    <div className={css.rowHeading}><EntityName value={phase} selected={selected} select={select} t={t} />
      <span className={css.secondary}>{t('dayRange')}: {valueText(phase.inpatDayRange, t)}</span></div>
    <dl className={css.itemFields}>
      <div><dt>{t('dateBasis')}</dt><dd>{phase.nodeAttribute === 0 ? t('admissionDay') : phase.nodeAttribute === 1 ? t('surgeryDay')
        : phase.nodeAttribute === 2 ? t('dischargeDay') : valueText(phase.nodeAttribute, t)}</dd></div>
      <div><dt>{t('predecessor')}</dt><dd>{valueText(phase.parentTreatmentLocalId ?? phase.parentTreatmentId, t)}</dd></div>
    </dl>
    <section className={css.section}><h4>{t('orders')}</h4><Projects value={phase.orderTreatmentProjects} selected={selected} select={select} t={t} /></section>
    <section className={css.section}><h4>{t('clinicalWork')}</h4><ObjectList value={phase.recordTreatmentProjects} selected={selected} select={select} t={t} /></section>
    <section className={css.section}><h4>{t('nursingWork')}</h4><ObjectList value={phase.nursingTreatmentProjects} selected={selected} select={select} t={t} /></section>
    <section className={css.section}><h4>{t('branches')}</h4><ObjectList value={phase.branchs} selected={selected} select={select} t={t} /></section>
  </section>)}</div>
}
function JsonDetails({ value, label }: { value: unknown; label: string }) {
  const [open, setOpen] = useState(false)
  return <details className={css.json} onToggle={(event) => { setOpen(event.currentTarget.open) }}>
    <summary>{label}</summary>{open && <pre>{JSON.stringify(value, null, 2)}</pre>}
  </details>
}
function Selection({ id, objects, baselineObjects, revision, t }: {
  id: string | null
  objects: Map<string, ClinicalObject>
  baselineObjects: Map<string, ClinicalObject>
  revision: ReferenceRevision
  t: T
}) {
  if (id === null) return <aside className={css.selection}><h3>{t('selected')}</h3><p className={css.secondary}>{t('noSelection')}</p></aside>
  const value = objects.get(id)
  const baseline = baselineObjects.get(id)
  if (value === undefined && baseline === undefined) return <aside className={css.selection}><p>{t('invalidSelection')}</p></aside>
  const fields = [...new Set([...Object.keys(baseline ?? {}), ...Object.keys(value ?? {})])]
  const differences = fields.filter(field => !sameValue(baseline?.[field], value?.[field]))
  const evidence = revision.metadata.evidence.filter(item => item.localId === id)
  const questions = revision.metadata.questions.filter(item => item.localId === id)
  const locks = visibleLocks(id, objects, revision.locks)
  return <aside className={css.selection}>
    <h3>{t('selected')}</h3><h4>{nameOf(value ?? baseline ?? {}, t)}</h4>
    <p>{t('localId')}: {id}</p><div className={css.badges}><span>{t(locks.length > 0 ? 'locked' : 'notLocked')}</span>
      <span>{t(revision.changedLocalIds.includes(id) ? 'changed' : 'unchanged')}</span></div>
    {locks.map(lock => <p key={lock.lock}>{lock.inherited ? t('inheritedLock', { lock: lock.lock })
      : lock.field === null ? t('objectLock') : t('fieldLock', { field: lock.field })}</p>)}
    <h4>{t('questions')}</h4>{questions.length === 0 ? <p className={css.secondary}>{t('noQuestions')}</p>
      : <ul className={css.lines}>{questions.map(item => <li key={`${item.field}:${item.message}`}>{item.field}: {item.message}</li>)}</ul>}
    <h4>{t('evidence')}</h4>{evidence.length === 0 ? <p className={css.secondary}>{t('noEvidence')}</p> : <ul className={css.lines}>
      {evidence.map(item => <li key={`${item.sourceRef}:${item.observedAt}`}>
        {t(({ source: 'sourceKind', history: 'historyKind', opinion: 'opinionKind', inference: 'inferenceKind' } as const)[item.kind])} · {item.sourceRef} · {item.observedAt}
      </li>)}</ul>}
    <h4>{t('differences')}</h4>{differences.length === 0 ? <p className={css.secondary}>{t('noDifference')}</p> : <dl className={css.differences}>
      {differences.map(field => <div key={field}><dt>{field}</dt><dd><span>{t('before')}: </span>{differenceText(baseline?.[field], t)}</dd>
        <dd><span>{t('after')}: </span>{differenceText(value?.[field], t)}</dd></div>)}
    </dl>}
    <JsonDetails value={value ?? null} label={t('fields')} />
  </aside>
}
function SavedReference({ state, t }: { state: ReferenceState; t: T }) {
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const revision = revisionNumber === null ? state.revisions.at(-1) : state.revisions.find(item => item.revision === revisionNumber)
  const latest = state.revisions.at(-1)
  const objects = useMemo(() => identifiedObjects(revision?.definition), [revision?.definition])
  const baselineObjects = useMemo(() => identifiedObjects(state.baseline), [state.baseline])
  if (revision === undefined) return <p>{t('noRevisions')}</p>
  const root = objectOf(revision.definition.clinicalPathway) ?? {}
  const changedIds = [...new Set([...objects.keys(), ...baselineObjects.keys()])]
    .filter(id => !sameValue(objects.get(id), baselineObjects.get(id)))
  return <>
    <header className={css.savedHeader}><h3>{state.title}</h3><div className={css.badges}>
      <span>{t(state.mode === 'new' ? 'newMode' : 'revisionMode')}</span>
      <span>{t(revision === latest ? 'current' : 'historical')}</span>
    </div></header>
    <label className={css.revisionSelect}>{t('referenceRevision')}<select aria-label={t('referenceRevision')} value={revision.revision} onChange={(event) => {
      setRevisionNumber(Number(event.target.value)); setSelected(null)
    }}>{state.revisions.map(item => <option key={item.revision} value={item.revision}>
        {t('revisionOption', { revision: item.revision, createdAt: item.createdAt })}
      </option>)}</select></label>
    <Scope scope={state.scope} t={t} />
    <section className={css.section}><h3>{t('baseline')}</h3>{state.source === null ? <p>{t('noBaseline')}</p> : <dl className={css.metadata}>
      <div><dt>{t('definitionId')}</dt><dd>{state.source.definitionId}</dd></div>
      <div><dt>{t('sourceReadAt')}</dt><dd>{state.source.readAt}</dd></div>
    </dl>}</section>
    <label className={css.revisionSelect}>{t('objects')}<select aria-label={t('objects')} value={selected ?? ''} onChange={(event) => { setSelected(event.target.value || null) }}>
      <option value="">{t('noSelection')}</option>
      {[...new Set([...objects.keys(), ...baselineObjects.keys()])].map((id) => {
        const item = objects.get(id) ?? baselineObjects.get(id)
        return item === undefined ? null : <option key={id} value={id}>{nameOf(item, t)} · {id}</option>
      })}
    </select></label>
    <div className={css.workbench}><main className={css.section}>
      <section className={css.section}><h3>{t('definitionName')}</h3><EntityName value={root} selected={selected} select={setSelected} t={t} />
        <dl className={css.metadata}>
          <div><dt>{t('ownerDepartment')}</dt><dd>{valueText(root.createDept, t)}</dd></div>
          <div><dt>{t('usingDepartments')}</dt><dd><ObjectList value={root.deptInfos} selected={selected} select={setSelected} t={t} /></dd></div>
          <div><dt>{t('stayRange')}</dt><dd>{valueText(root.inpatDayRange, t)}</dd></div>
          <div><dt>{t('feeRange')}</dt><dd>{valueText(root.feesRange, t)}</dd></div>
        </dl></section>
      <section className={css.section}><h3>{t('diagnoses')}</h3><ObjectList value={root.diagnoseGroup} selected={selected} select={setSelected} t={t} /></section>
      <section className={css.section}><h3>{t('admission')}</h3><ObjectList assessment value={root.inclusionAssessment} selected={selected} select={setSelected} t={t} /></section>
      <section className={css.section}><h3>{t('phases')}</h3><Phases value={root.treatments} selected={selected} select={setSelected} t={t} /></section>
    </main><Selection id={selected} objects={objects} baselineObjects={baselineObjects} revision={revision} t={t} /></div>
    <section className={css.section}><h3>{t('coverage')}</h3><Lines values={revision.metadata.coverage} t={t} /></section>
    <section className={css.section}><h3>{t('questions')}</h3><Lines values={revision.metadata.questions.map(item => `${item.localId} · ${item.field}: ${item.message}`)} t={t} /></section>
    <section className={css.section}><h3>{t('differences')}</h3>
      {state.baseline === null && <p className={css.secondary}>{t('noBaselineDifference')}</p>}
      <div className={css.badges}>{changedIds.map((id) => {
        const object = objects.get(id) ?? baselineObjects.get(id)
        return object === undefined ? null : <EntityName key={id} value={object} selected={selected} select={setSelected} t={t} />
      })}</div>
      {changedIds.length === 0 && <p className={css.secondary}>{t('noDifference')}</p>}
    </section>
    <JsonDetails value={revision.definition} label={t('json')} />
    <p className={css.secondary}>{t('emrUnavailable')}</p>
  </>
}

/**
 * Render the shared shell overlay for the active reference task.
 * @param props - Framework-bound state hook, authorized scope, and narrow request callbacks.
 * @returns The shared shell overlay; no independent preview page is created.
 */
export function ReferenceOverlay({ useReference, config, close, refresh, create, t }: PropsRuntime<'shell.overlay'> & Face) {
  const state = useReference(value => value)
  return <Modal open={state.open} onClose={close} title={t('title')} closeLabel={t('close')}
    className={css.dialog ?? ''} contentClassName={css.modalContent ?? ''}>
    <div className={css.content} aria-busy={state.busy}>
      <header className={css.topline}><p className={css.secondary}>{t('referenceOnly')}</p>
        <Button variant="outline" disabled={state.busy} onClick={refresh}>{t('refresh')}</Button></header>
      {state.issue !== null && <p className={css.notice} role="status">{t(state.issue)}</p>}
      {state.busy && state.value === null && <div className={css.loading} role="status" aria-label={t('loading')}><span className={css.spinner} /></div>}
      {state.value !== null && (state.value.state === null
        ? <CreateTask key={state.sessionId} sources={state.value.sources} config={config} busy={state.busy}
          unconfirmed={state.creationUnconfirmed} create={create} t={t} />
        : <SavedReference key={state.sessionId} state={state.value.state} t={t} />)}
    </div>
  </Modal>
}

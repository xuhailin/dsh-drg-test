/** Authorized department/patient sidebar beside the shared saved-result view. */
import { useEffect, useState } from 'react'
import { Button, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DirectoryState } from './directory-controller.ts'
import { ResultView, type ViewerInjected } from './ResultView.tsx'
import css from './PatientWorkspace.module.css'

/** Renderer-bound directory and result sources with explicit user operations. */
export interface PatientInjected extends ViewerInjected {
  hooks: ViewerInjected['hooks'] & { directory: ObservableSnapshot<DirectoryState> }
  loadDepartments(): void
  chooseDepartment(department: DirectoryState['departments'][number]): void
  loadPage(index: number, search: string): void
  openPatient(patient: NonNullable<DirectoryState['page']>['patients'][number], department: DirectoryState['departments'][number]): void
  beginReview(): void
  openChat(): void
}

/**
 * @param props - Framework state and actions.
 * @returns A department sidebar and the saved-report component shared by both result containers.
 */
export function PatientWorkspace(props: PropsRuntime<'main'> & InjectFace<PatientInjected> & PropsLocale<'clinical-results'>) {
  const state = props.useDirectory(value => value)
  const viewer = props.useViewer(value => value)
  const [search, setSearch] = useState('')
  useEffect(() => { props.loadDepartments() }, [props.loadDepartments])
  const departmentKey = (department: DirectoryState['departments'][number]): string => JSON.stringify([department.sourceSystem, department.hospitalCode, department.departmentCode])
  const selectedDepartment = state.department === null ? '' : departmentKey(state.department)
  const page = state.page
  return <div className={css.workspace}>
    <aside className={css.directory} aria-label={props.t('patients')} aria-busy={state.phase === 'loading'}>
      <h1>{props.t('patients')}</h1><p className={css.notice}>{props.t('directoryScope')}</p>
      <label>{props.t('department')}<select aria-label={props.t('department')} value={selectedDepartment} onChange={(event) => {
        const department = state.departments.find(item => departmentKey(item) === event.target.value)
        if (department !== undefined) { setSearch(''); props.chooseDepartment(department) }
      }}>
        <option value="" disabled>{props.t('chooseDepartment')}</option>
        {state.departments.map(department => <option key={`${department.sourceSystem}:${department.hospitalCode}:${department.departmentCode}`} value={departmentKey(department)}>{department.departmentName}</option>)}
      </select></label>
      <form className={css.search} onSubmit={(event) => { event.preventDefault(); props.loadPage(1, search) }}>
        <label>{props.t('patientSearch')}<input value={search} maxLength={100} onChange={(event) => { setSearch(event.target.value) }} /></label>
        <Button type="submit" variant="outline" disabled={state.department === null || state.phase === 'loading'}>{props.t('search')}</Button>
      </form>
      {state.phase !== 'ready' && state.phase !== 'idle' && <p className={css.notice} role="status">{props.t(state.phase === 'failed' ? 'directoryFailed' : state.phase === 'loading' ? 'loading' : state.phase)}</p>}
      {state.phase === 'failed' && <Button variant="outline" onClick={props.loadDepartments}>{props.t('retry')}</Button>}
      {state.phase === 'ready' && state.departments.length === 0 && <p className={css.notice}>{props.t('noDepartments')}</p>}
      {page !== null && <><ul className={css.patients}>{page.patients.map(patient => <li key={patient.inpatId}>
        <button className={css.patient} type="button" aria-pressed={patient.inpatId === state.selectedPatient?.inpatId}
          disabled={state.opening} onClick={() => {
            if (state.department !== null) props.openPatient(patient, state.department)
          }}>
          {patient.patientName}<span>{patient.bedName ?? props.t('bedUnknown')} · {patient.inpatCode ?? patient.inpatId}</span>
        </button>
      </li>)}</ul>
      {page.patients.length === 0 && <p className={css.notice}>{props.t('noPatients')}</p>}
      <div className={css.paging}>
        <Button variant="outline" disabled={page.pageIndex <= 1 || state.phase === 'loading'} onClick={() => { props.loadPage(page.pageIndex - 1, search) }}>{props.t('previousPage')}</Button>
        <Button variant="outline" disabled={!page.hasMore || state.phase === 'loading'} onClick={() => { props.loadPage(page.pageIndex + 1, search) }}>{props.t('nextPage')}</Button>
      </div></>}
    </aside>
    <section className={css.detail}>
      <div className={css.toolbar}>
        <Button variant="primary" disabled={state.sessionId === null || ['pending', 'unknown'].includes(state.review)} onClick={props.beginReview}>{props.t('startReview')}</Button>
        <Button variant="outline" disabled={state.sessionId === null} onClick={props.refresh}>{props.t('refresh')}</Button>
        <Button variant="outline" disabled={state.sessionId === null} onClick={props.openChat}>{props.t('openChat')}</Button>
        {state.review !== 'idle' && <p className={css.notice} role="status">
          {props.t(state.review === 'unknown' ? 'rerunUnknown' : state.review)}
        </p>}
      </div>
      <div className={css.result}>
        <ResultView state={viewer} select={props.select} refresh={props.refresh} rerun={props.rerun} t={props.t} />
      </div>
    </section>
  </div>
}

/**
 * @param props - Existing Sidebar navigation icon size.
 * @returns The registered patient-workspace icon.
 */
export function PatientIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconChecklistOutlineRegular size={size} /> }

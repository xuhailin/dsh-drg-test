/** Department-scoped inpatient browsing, with server authorization on every request. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { departmentDirectorySchema, patientDirectorySchema, type DepartmentDirectory, type PatientDirectory, type PatientDirectoryRequest } from '@deepseek-ai/dsh-experimental-emr-encounter/wire'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { ViewerConfig } from '../types.ts'
import type { ResultSelection } from './protocol.ts'

type Department = DepartmentDirectory['departments'][number]
type Patient = PatientDirectory['patients'][number]
const admission = z.object({ sessionId: z.string().min(1), revision: z.number().int().nonnegative(), status: z.enum(['bound', 'accepted', 'duplicate']), dischargeBlocked: z.literal(false) })
/** A directory view never carries evidence, diagnoses, or a second copy of the report. */
export interface DirectoryState {
  phase: 'idle' | 'loading' | 'ready' | 'login' | 'denied' | 'failed'
  departments: DepartmentDirectory['departments']
  department: Department | null
  page: PatientDirectory | null
  selectedPatient: Patient | null
  sessionId: SessionId | null
  opening: boolean
  review: 'idle' | 'pending' | 'accepted' | 'unknown'
}
const empty: DirectoryState = { phase: 'idle', departments: [], department: null, page: null, selectedPatient: null, sessionId: null, opening: false, review: 'idle' }

/** One patient workspace owns directory requests and invalidates old-patient reads immediately. */
export class DirectoryController {
  /** Framework-bound minimal directory and operation status. */
  readonly view = createSnapshotStore<DirectoryState>(empty)
  private readonly lifetime = new AbortController()
  private query: AbortController | null = null
  private opening: AbortController | null = null
  private generation = 0
  /**
   * @param config - Public bounds.
   * @param send - Authenticated transport.
   * @param clearResult - Clear old patient evidence before selection changes.
   * @param openResult - Load the authorized Session's saved-result listing.
   */
  constructor(private readonly config: ViewerConfig, private readonly send: typeof fetch,
    private readonly clearResult: () => void, private readonly openResult: (selection: ResultSelection) => Promise<void>) {}

  /** Load only departments granted to the current authenticated actor. @returns Bounded read completion. */
  async load(): Promise<void> {
    const signal = this.beginQuery()
    try {
      const value = departmentDirectorySchema.parse(await this.request('departments', {}, signal))
      if (signal.aborted) return
      const current = this.view.getSnapshot().department
      if (current !== null && !value.departments.some(item => item.sourceSystem === current.sourceSystem
        && item.hospitalCode === current.hospitalCode && item.departmentCode === current.departmentCode)) {
        this.invalidatePatient()
        this.view.update((state) => { state.department = null; state.page = null })
      }
      this.view.update((state) => { state.departments = value.departments; state.phase = 'ready' })
    } catch (error) { this.failed(error, signal) }
  }

  /**
   * Select an explicitly chosen department and clear any previous patient's result.
   * @param department - A row from the current authorized listing.
   * @returns First-page read completion.
   */
  async choose(department: Department): Promise<void> {
    if (!this.view.getSnapshot().departments.some(item => sameDepartment(item, department))) return
    this.invalidatePatient()
    this.view.update((state) => { state.department = department; state.page = null })
    await this.page(1, '')
  }

  /** Read a bounded inpatient page; the server rechecks department authorization.
   * @param pageIndex - One-based page.
   * @param search - Explicitly submitted name, bed or inpatient-code search.
   * @returns Page-read completion.
   */
  async page(pageIndex: number, search = ''): Promise<void> {
    const department = this.view.getSnapshot().department
    if (department === null) return
    const signal = this.beginQuery()
    const request: PatientDirectoryRequest = { sourceSystem: department.sourceSystem, hospitalCode: department.hospitalCode,
      departmentCode: department.departmentCode, pageIndex, pageSize: this.config.directoryPageSize, search }
    try {
      const result = patientDirectorySchema.parse(await this.request('patients', request, signal))
      if (signal.aborted) return
      if (result.departmentCode !== request.departmentCode || result.hospitalCode !== request.hospitalCode
        || result.sourceSystem !== request.sourceSystem || result.pageIndex !== pageIndex || result.pageSize !== request.pageSize) throw new Error('DIRECTORY_SCOPE_MISMATCH')
      this.view.update((state) => { state.page = result; state.phase = 'ready' })
    } catch (error) { this.failed(error, signal) }
  }

  /** Bind one row to the existing private encounter Session without starting a review.
   * @param patient - Row from the rendered authorized page.
   * @param renderedDepartment - Scope displayed with that row.
   * @returns Authorized Session selection completion.
   */
  async open(patient: Patient, renderedDepartment: Department): Promise<void> {
    const state = this.view.getSnapshot(), department = state.department
    if (department === null || !sameDepartment(department, renderedDepartment)
      || !state.page?.patients.some(item => item.inpatId === patient.inpatId && item.inpatCode === patient.inpatCode)) return
    this.invalidatePatient()
    const generation = this.generation, opening = new AbortController()
    this.opening = opening
    this.view.update((state) => { state.selectedPatient = patient; state.opening = true })
    try {
      const receipt = admission.parse(await this.request('launch', { eventId: randomUUID(), trigger: 'open',
        sourceSystem: department.sourceSystem, hospitalCode: department.hospitalCode, inpatId: patient.inpatId,
        ...(patient.inpatCode === undefined ? {} : { inpatCode: patient.inpatCode }),
      }, opening.signal))
      if (opening.signal.aborted || generation !== this.generation) return
      const sessionId = receipt.sessionId as SessionId
      this.view.update((state) => { state.sessionId = sessionId })
      await this.openResult({ sessionId })
    } catch (error) { this.failed(error, opening.signal) }
    finally { if (generation === this.generation) this.view.update((state) => { state.opening = false }) }
  }

  /** Request a review only after an explicit gesture; discharge remains independent. @returns Admission completion. */
  async review(): Promise<void> {
    const state = this.view.getSnapshot(), id = state.sessionId
    if (id === null || state.review === 'pending' || state.review === 'unknown') return
    const generation = this.generation
    this.view.update((value) => { value.review = 'pending' })
    try {
      const result = admission.parse(await this.request('review', { sessionId: id, eventId: randomUUID(), trigger: 'manual-review' }, this.lifetime.signal))
      if (generation !== this.generation) return
      if (result.sessionId !== id) throw new Error('DIRECTORY_SESSION_MISMATCH')
      this.view.update((value) => { value.review = 'accepted' })
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof DirectoryFailure && (error.phase === 'login' || error.phase === 'denied')) this.failed(error, this.lifetime.signal)
      else this.view.update((value) => { value.review = 'unknown' })
    }
  }

  /** Clear patient data and cancel local requests after account or host changes. */
  clear(): void { this.query?.abort(); this.invalidatePatient(); this.view.set(empty) }
  /** Dispose every local wait without cancelling admitted server work. */
  dispose(): void { this.clear(); this.lifetime.abort() }

  private invalidatePatient(): void {
    this.generation++
    this.opening?.abort()
    this.opening = null
    this.clearResult()
    this.view.update((state) => { state.selectedPatient = null; state.sessionId = null; state.opening = false; state.review = 'idle' })
  }
  private beginQuery(): AbortSignal {
    this.query?.abort()
    this.query = new AbortController()
    this.view.update((state) => { state.phase = 'loading' })
    return AbortSignal.any([this.query.signal, this.lifetime.signal])
  }
  private failed(error: unknown, signal: AbortSignal): void {
    if (signal.aborted || this.lifetime.signal.aborted) return
    const phase = error instanceof DirectoryFailure ? error.phase : 'failed'
    if (phase === 'login' || phase === 'denied') { this.clear(); this.view.update((state) => { state.phase = phase }) }
    else this.view.update((state) => { state.phase = phase })
  }
  private async request(operation: string, value: object, signal: AbortSignal): Promise<unknown> {
    const send = this.send
    const bounded = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    const response = await send(`api/clinical-review/${operation}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: bounded })
    bounded.throwIfAborted()
    if (!response.ok) throw new DirectoryFailure(response.status === 401 ? 'login' : response.status === 403 ? 'denied' : 'failed')
    const result: unknown = await response.json()
    bounded.throwIfAborted()
    return result
  }
}

class DirectoryFailure extends Error {
  constructor(readonly phase: 'login' | 'denied' | 'failed') { super(phase) }
}

function sameDepartment(left: Department, right: Department): boolean {
  return left.sourceSystem === right.sourceSystem && left.hospitalCode === right.hospitalCode
    && left.departmentCode === right.departmentCode
}

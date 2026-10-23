// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResultView } from '../src/client/ResultView.tsx'
import { zh } from '../src/client/locales.ts'
import type { ViewerState } from '../src/client/controller.ts'
import { listing, reference, result } from './fixtures.client.ts'

const t = makeTranslate(zh)
afterEach(cleanup)
function draw(state: Partial<ViewerState> = {}) {
  const select = vi.fn(), refresh = vi.fn(), rerun = vi.fn()
  const view: ViewerState = { phase: 'ready', result, selection: reference, listing: null, rerun: 'idle', ...state }
  return { ...render(<ResultView state={view} select={select} refresh={refresh} rerun={rerun} t={t} />), select, refresh, rerun }
}

describe('shared saved clinical report presentation', () => {
  it('leads with the summary and clinician questions while keeping identifiers in closed details', () => {
    const view = draw()
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByText(zh.historical)).toBeTruthy()
    expect(screen.getByText('Exact quotation')).toBeTruthy()
    expect([...view.container.querySelectorAll('h2')].slice(0, 2).map(node => node.textContent)).toEqual([zh.summary, zh.findings])
    const sourceDetails = screen.getByText(zh.sourceDetails).closest('details')!
    const reportDetails = screen.getByText(zh.reportDetails).closest('details')!
    expect(sourceDetails.open).toBe(false)
    expect(reportDetails.open).toBe(false)
    const firstScreen = view.container.querySelector('article')!.cloneNode(true) as HTMLElement
    firstScreen.querySelectorAll('details').forEach((detail) => { detail.remove() })
    for (const identifier of ['document-1', 'revision-old', 'source-old', result.reportId, zh.revision, zh.legacy, 'Synthetic retrieval gap']) {
      expect(firstScreen.textContent).not.toContain(identifier)
    }
    expect(firstScreen.textContent).toContain(zh.encounterLabel.replace('{label}', result.encounterLabel))
    expect(firstScreen.textContent).toContain(zh.coverageNote)
    expect(firstScreen.textContent).toContain(zh.calculationNote)
    fireEvent.click(sourceDetails.querySelector('summary')!)
    fireEvent.click(reportDetails.querySelector('summary')!)
    for (const text of ['document-1', 'revision-old', 'signed', 'Synthetic retrieval gap', 'unreviewed-source', zh.unread, zh.unsupported, zh.freshnessUnknown]) expect(screen.getByText(text)).toBeTruthy()
    expect(screen.getByText(zh.progressFailed)).toBeTruthy()
    expect(screen.getByText(zh.navigationUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /EMR/ })).toBeNull()
    expect(screen.getByText(zh.disclaimer)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.history), { target: { value: '2' } })
  })

  it('requires explicit history selection and does not hide an old report after a failed read or rerun', () => {
    const b = draw({ phase: 'failed', rerun: 'failed' })
    expect(screen.getByText(result.summary)).toBeTruthy()
    expect(screen.getByText(zh.rerunFailed)).toBeTruthy()
    fireEvent.click(screen.getByText(zh.reportDetails))
    fireEvent.change(screen.getByLabelText(zh.history), { target: { value: '2' } })
    expect(b.select).toHaveBeenCalledWith(result.history[0])
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(b.refresh).toHaveBeenCalledOnce()
    expect(screen.getByText('Exact quotation')).toBeTruthy()
  })

  it('offers a listing choice instead of automatically rendering the newest report', () => {
    const b = draw({ phase: 'choose', result: null, listing })
    expect(screen.queryByText(result.summary)).toBeNull()
    expect(screen.getByLabelText(zh.history)).toHaveProperty('value', '')
    fireEvent.change(screen.getByLabelText(zh.history), { target: { value: '1' } })
    expect(b.select).toHaveBeenCalledWith(result.history[1])
  })

  it.each([
    ['idle', zh.idle], ['empty', zh.noReport], ['login', zh.login], ['denied', zh.denied], ['not-found', zh.notFound], ['unsupported', zh.unsupportedFormat],
  ] as const)('distinguishes %s from a successful empty report', (phase, message) => {
    draw({ phase, result: null })
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByText(result.summary)).toBeNull()
  })

  it('labels zero findings and missing historical sources without implying a complete review', () => {
    draw({ result: { ...result, findings: [], snapshotStatus: 'unavailable', unreviewedSourceRefs: [] } })
    expect(screen.getByText(zh.zeroFindings)).toBeTruthy()
    expect(screen.getAllByText(zh.snapshotUnavailable)).toHaveLength(2)
    expect(screen.queryByText(zh.unreviewedEmpty)).toBeNull()
  })

  it('keeps source quotations readable when the original record cannot be retrieved', () => {
    const finding = result.findings[0]!
    draw({ result: { ...result, findings: [{ ...finding,
      evidenceRefs: finding.evidenceRefs.map(evidence => ({ ...evidence, source: null, sourceStatus: 'unavailable' })),
    }] } })
    expect(screen.getByText('Exact quotation')).toBeTruthy()
    expect(screen.getByText(zh.missingSource)).toBeTruthy()
    expect(screen.getByText(zh.suggestion)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /定位|病历/ })).toBeNull()
  })
})

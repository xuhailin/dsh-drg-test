// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ResultCards } from '../src/client/ResultCards.tsx'
import { SavedCardController } from '../src/client/saved-cards.ts'
import { zh } from '../src/client/locales.ts'
import type { ResultCardData } from '../src/client/result-card.ts'
import { config, reference, result } from './fixtures.client.ts'

const controllers: SavedCardController[] = []
afterEach(() => { cleanup(); for (const controller of controllers.splice(0)) controller.dispose() })

function props(controller: SavedCardController, generatedAt: string | null = result.generatedAt) {
  const open = vi.fn()
  const raw: readonly ResultCardData[] = [{ ref: reference, reportId: result.reportId, encounterLabel: 'Unconfirmed metadata',
    generatedAt, findingCount: 99, coverageGaps: null }]
  return { open, view: { turn: { turn: 1 }, ownerSessionId: reference.sessionId, open,
    useResults: () => raw, useConfirmed: bindSnapshotSelector(controller.view),
    confirm: (ref, id, retry) => { void controller.confirm(ref, id, retry) }, t: makeTranslate(zh),
  } as ComponentProps<typeof ResultCards> }
}

describe('saved report card publication', () => {
  it('waits for persistence-confirmed metadata before showing or opening the immutable report card', async () => {
    let resolve!: (response: Response) => void
    const response = new Promise<Response>((value) => { resolve = value })
    const controller = new SavedCardController(config, () => response)
    controllers.push(controller)
    const b = props(controller)
    render(<ResultCards {...b.view} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Unconfirmed metadata')).toBeNull()
    await act(async () => { resolve(Response.json(result)); await response })
    const card = screen.getByRole('button', { name: zh.openSavedResult.replace('{generatedAt}', result.generatedAt ?? zh.unknown) })
    expect(card.textContent).toContain(result.encounterLabel)
    expect(card.textContent).not.toContain('Unconfirmed metadata')
    expect(card.textContent).not.toContain(zh.revision)
    expect(card.textContent).toContain(zh.title)
    fireEvent.click(card)
    expect(b.open).toHaveBeenCalledWith(reference)
  })

  it('shows a read retry without publishing a saved card when confirmation cannot establish acceptance', async () => {
    const controller = new SavedCardController(config, async () => new Response(null, { status: 503 }))
    controllers.push(controller)
    const b = props(controller)
    render(<ResultCards {...b.view} />)
    await screen.findByText(zh.cardUnavailable)
    expect(screen.queryByRole('button', { name: zh.openSavedResult.replace('{generatedAt}', result.generatedAt ?? zh.unknown) })).toBeNull()
    expect(screen.getByRole('button', { name: zh.retry })).toBeTruthy()
    expect(b.open).not.toHaveBeenCalled()
  })

  it.each([null, '2026-10-23T02:00:00.000Z'])('does not anchor a confirmed report to a later or unknown raw state timestamp %s', async (generatedAt) => {
    const controller = new SavedCardController(config, async () => Response.json(result))
    controllers.push(controller)
    const b = props(controller, generatedAt)
    render(<ResultCards {...b.view} />)
    await act(async () => { await controller.confirm(reference, result.reportId) })
    expect(controller.view.getSnapshot().confirmed[result.reportId]).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(b.open).not.toHaveBeenCalled()
  })
})

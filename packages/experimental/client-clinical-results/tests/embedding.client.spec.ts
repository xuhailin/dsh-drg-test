// @vitest-environment jsdom
/** Embedding validates browser identity and retires old-patient request correspondence. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResultEmbedding, type EmbeddingCallbacks } from '../src/client/embedding.ts'
import { resultSelectionSchema } from '../src/client/protocol.ts'
import type { ViewerConfig } from '../src/types.ts'

const config: ViewerConfig = { allowedOrigins: ['https://emr.example'], requestTimeoutMs: 1000, maxMessageBytes: 8192, maxPendingRequests: 4, maxActionReceipts: 20, directoryPageSize: 20 }
const selection = resultSelectionSchema.parse({ sessionId: 'clinical-one', resultId: 'result-one', revision: 1, encounterRef: 'encounter-one' })
const disposers: (() => void)[] = []
afterEach(() => { disposers.splice(0).reverse().forEach((dispose) =>{  dispose() }); vi.restoreAllMocks() })

function bench(overrides: Partial<EmbeddingCallbacks> = {}) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const surface = frame.contentWindow!
  disposers.push(() => { frame.remove() })
  const messages: Record<string, unknown>[] = []
  vi.spyOn(surface.parent, 'postMessage').mockImplementation((value: Record<string, unknown>) => { messages.push(value) })
  const callbacks: EmbeddingCallbacks = { open: vi.fn(async () => {}), launch: vi.fn(async () => selection), clear: vi.fn(),
    rerun: vi.fn(async () => ({ status: 'accepted', revision: 2 })), selection: vi.fn(() => selection), authorize: vi.fn(async () => true), ...overrides }
  const embedding = new ResultEmbedding(config, callbacks, surface)
  disposers.push(embedding.start())
  const viewId = messages[0]!.viewId
  const send = async (data: object, origin = config.allowedOrigins[0]!, source: Window = surface.parent) => {
    await embedding.receive({ origin, source, data: { protocolVersion: 1, viewId, requestId: 'connect', ...data } })
  }
  const connect = () => send({ type: 'dsh.results.connect', accountRef: 'actor', capabilities: [], selection })
  return { embedding, callbacks, messages, viewId, surface, send, connect }
}

describe('result embedding', () => {
  it('requires the exact parent, origin, version and load challenge', async () => {
    const test = bench()
    const request = { type: 'dsh.results.connect', accountRef: 'actor', capabilities: [], selection }
    await test.send(request, 'https://foreign.example')
    await test.send(request, config.allowedOrigins[0], test.surface)
    await test.send({ ...request, protocolVersion: 2 })
    await test.send({ ...request, viewId: 'previous-load' })
    await test.send({ ...request, token: 'forbidden-field' })
    await test.send({ ...request, accountRef: 'a'.repeat(9000) })
    expect(test.callbacks.open).not.toHaveBeenCalled()
    await test.connect()
    expect(test.callbacks.open).toHaveBeenCalledExactlyOnceWith(selection)
    expect(test.messages.at(-1)).toMatchObject({ status: 'completed', requestId: 'connect', viewId: test.viewId })
    expect(JSON.stringify(test.messages)).not.toContain('summary')
  })

  it('reuses receipts and rejects reused IDs with different action parameters', async () => {
    const test = bench()
    await test.connect()
    const action = { type: 'dsh.results.action', requestId: 'rerun', accountRef: 'actor', selection, actionKey: 'review.rerun' }
    await test.send(action)
    await test.send(action)
    expect(test.callbacks.rerun).toHaveBeenCalledExactlyOnceWith(selection, 'rerun')
    expect(test.messages.at(-1)).toMatchObject({ requestId: 'rerun', status: 'accepted' })
    await test.send({ ...action, selection: { ...selection, revision: 2 } })
    expect(test.messages.at(-1)).toMatchObject({ status: 'rejected', reason: 'conflicting-request' })
    await test.send({ ...action, requestId: 'forged', selection: { ...selection, revision: 2 } })
    expect(test.callbacks.rerun).toHaveBeenCalledTimes(1)
    expect(test.messages.at(-1)).toMatchObject({ status: 'rejected', reason: 'selection-mismatch' })
  })

  it('clears old content immediately on patient switch and ignores a late action receipt', async () => {
    let complete: ((value: { status: string; revision: number }) => void) | undefined
    const test = bench({ rerun: () => new Promise((resolve) => { complete = resolve }) })
    await test.connect()
    const pending = test.send({ type: 'dsh.results.action', requestId: 'pending', accountRef: 'actor', selection, actionKey: 'review.rerun' })
    await test.send({ type: 'dsh.results.select', requestId: 'switch', accountRef: 'actor', selection: { ...selection, sessionId: 'clinical-two', encounterRef: 'encounter-two' } })
    expect(test.callbacks.clear).toHaveBeenCalled()
    expect(test.messages.at(-1)).toMatchObject({ type: 'dsh.results.ready' })
    expect(test.messages.at(-1)!.viewId).not.toBe(test.viewId)
    complete!({ status: 'accepted', revision: 2 })
    await pending
    expect(test.messages.filter(value => value.requestId === 'pending')).toHaveLength(0)
    await test.connect()
    expect(test.callbacks.open).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh challenge after account change, clear or authentication invalidation', async () => {
    const test = bench()
    await test.connect()
    await test.send({ type: 'dsh.results.connect', requestId: 'other-account', accountRef: 'other', capabilities: [], selection })
    expect(test.callbacks.clear).toHaveBeenCalledTimes(2)
    expect(test.messages.at(-1)!.viewId).not.toBe(test.viewId)
    await test.connect()
    expect(test.callbacks.open).toHaveBeenCalledTimes(1)
    test.embedding.invalidate()
    expect(test.callbacks.clear).toHaveBeenCalledTimes(3)
    test.embedding.dispose()
    await test.connect()
    expect(test.callbacks.open).toHaveBeenCalledTimes(1)
  })
  it('retires a pending launch before accepting a different selection', async () => {
    let complete: ((value: typeof selection) => void) | undefined
    const test = bench({ launch: () => new Promise((resolve) => { complete = resolve }) })
    const pending = test.send({ type: 'dsh.results.connect', accountRef: 'actor', capabilities: [],
      launch: { eventId: 'open-a', trigger: 'open', sourceSystem: 'fixture', hospitalCode: '1001', inpatId: '123' } })
    await test.send({ type: 'dsh.results.select', requestId: 'select-b', accountRef: 'actor', selection: { ...selection, sessionId: 'clinical-two' } })
    complete!(selection)
    await pending
    expect(test.callbacks.open).not.toHaveBeenCalled()
    expect(test.messages.at(-1)).toMatchObject({ type: 'dsh.results.ready' })
    expect(test.messages.at(-1)!.viewId).not.toBe(test.viewId)
  })

  it('binds actions to the revision actually displayed after local history selection', async () => {
    let current = selection
    const test = bench({ selection: () => current })
    await test.connect()
    current = { ...selection, revision: 2 }
    await test.send({ type: 'dsh.results.action', requestId: 'old-revision', accountRef: 'actor', selection, actionKey: 'review.rerun' })
    expect(test.callbacks.rerun).not.toHaveBeenCalled()
    expect(test.messages.at(-1)).toMatchObject({ status: 'rejected', reason: 'selection-mismatch' })
  })

  it('rechecks authorization before replaying a retained action receipt', async () => {
    const authorized = vi.fn(async () => false)
    const test = bench({ authorize: authorized })
    await test.connect()
    const action = { type: 'dsh.results.action', requestId: 'retained', accountRef: 'actor', selection, actionKey: 'review.rerun' }
    await test.send(action)
    expect(test.messages.at(-1)).toMatchObject({ status: 'accepted' })
    await test.send(action)
    expect(authorized).toHaveBeenCalledExactlyOnceWith(selection)
    expect(test.callbacks.rerun).toHaveBeenCalledTimes(1)
    expect(test.messages.at(-1)).toMatchObject({ status: 'rejected', reason: 'authorization-required' })
  })

  it('retires an unauthorized view without starting another login handshake loop', async () => {
    const test = bench()
    await test.connect()
    test.embedding.authorizationLost()
    expect(test.messages.at(-1)).toMatchObject({ type: 'dsh.results.closed', viewId: test.viewId, reason: 'authorization-required' })
    await test.connect()
    expect(test.callbacks.open).toHaveBeenCalledTimes(1)
    test.embedding.invalidate()
    expect(test.messages.at(-1)).toMatchObject({ type: 'dsh.results.ready' })
    expect(test.messages.at(-1)!.viewId).not.toBe(test.viewId)
  })

})

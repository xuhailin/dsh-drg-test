/** Real-profile saved-result reading, historical evidence, and optional patient-directory browser flow. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resultResponseSchema, resultsResponseSchema, resultRequestSchema } from '@deepseek-ai/dsh-experimental-clinical-review/result'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const binding = { schemaVersion: 1, bindingId: '11111111-1111-4111-8111-111111111111', actorId: 'synthetic-doctor',
  actorIssuer: 'https://synthetic.example', actorSubject: 'doctor', sourceSystem: 'synthetic-emr', hospitalCode: '1001', inpatId: '123', inpatCode: 'SYNTHETIC-123' }
const department = { sourceSystem: binding.sourceSystem, hospitalCode: binding.hospitalCode, departmentCode: 'synthetic-dept', departmentName: 'Synthetic department' }
const oldContent = 'Clinical diagnosis: pneumonia.\nDischarge summary: no pneumonia.\n'
const newContent = 'Clinical diagnosis: recovered pneumonia.\nDischarge summary: recovered pneumonia.\n'
function snapshot(revision: number) {
  const content = revision === 1 ? oldContent : newContent
  const digest = createHash('sha256').update(content).digest('hex')
  return { schemaVersion: 1, bindingId: binding.bindingId, caseRevision: digest, providerRevision: 'synthetic-provider-v1',
    capturedAt: `2026-10-2${revision}T01:00:00.000Z`, cutoff: `2026-10-2${revision}T00:00:00.000Z`,
    sources: [{ sourceRef: 'synthetic-source', category: 'documents', sourceId: 'synthetic-document', sourceRevision: `source-${revision}`,
      state: 'signed', occurredAt: '2026-10-20T00:00:00.000Z', content, contentDigest: digest }],
    coverage: ['encounter', 'diagnoses', 'orders', 'documents', 'labs', 'checks', 'operations', 'administration'].map(category => ({
      category, status: category === 'documents' ? 'complete' : category === 'labs' ? 'unread' : 'unsupported',
      ...(category === 'labs' ? { detail: 'Synthetic lab gap' } : {}),
    })) }
}

class ClinicalModel extends LlmAdapter {
  calls = 0
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const step = this.calls++, round = Math.floor(step / 4) + 1, stage = step % 4
    if (round > 2) throw new Error('Synthetic review script exhausted')
    const quote = 'no pneumonia', start = oldContent.indexOf(quote)
    const calls = [
      { name: 'review_load_case', args: {} },
      { name: 'review_read_evidence', args: { revision: round, sourceRef: 'synthetic-source', start: 0, length: 2000 } },
      { name: 'review_submit_findings', args: { revision: round, caseRevision: snapshot(round).caseRevision,
        summary: `Synthetic saved review ${round}`, reviewedSourceRefs: ['synthetic-source'], findings: round === 2 ? [] : [{
          kind: 'inconsistency', title: 'Synthetic diagnosis inconsistency', explanation: 'Compare the retained original records',
          suggestion: 'Verify the original document', citations: [{ sourceRef: 'synthetic-source', start, end: start + quote.length, quote }],
        }] } },
    ]
    const call = calls[stage]
    if (call !== undefined) {
      const id = ToolCallId(`clinical-browser-${step}`), args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `Synthetic review ${round} saved; pending human review.` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each([{ name: 'root', prefix: undefined }, { name: 'prefix', prefix: 'clinical-prefix/' }])('opens the same immutable report through chat and a standalone page at $name while patient selection remains read-only', async ({ name, prefix }) => {
  const cleanups: (() => void | Promise<void>)[] = []
  const failurePage: { current?: Page } = {}
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail' && failurePage.current !== undefined) await saveFailureShot(failurePage.current, `clinical-results-${name}`)
    const errors: unknown[] = []
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup() }
      catch (error: unknown) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Clinical browser fixture cleanup failed')
  })
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'clinical-result-browser-'))
  cleanups.push(() => rm(fixtureRoot, { recursive: true, force: true }))
  let sourceRevision = 1, denied = false, captures = 0
  const broker = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.setHeader('content-type', 'application/json')
      if (request.headers['x-api-key'] !== 'synthetic-browser-only') { response.writeHead(403); response.end('{}'); return }
      const operation = request.url?.split('/').at(-1)
      if (operation === 'authorize' && denied) { response.writeHead(403); response.end('{}'); return }
      let value: object
      switch (operation) {
        case 'launch': value = { grant: '2'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }; break
        case 'consume': case 'authorize': value = binding; break
        case 'capture': captures++; value = snapshot(sourceRevision); break
        case 'departments': value = { departments: [department] }; break
        case 'patients': value = { sourceSystem: department.sourceSystem, hospitalCode: department.hospitalCode,
          departmentCode: department.departmentCode, pageIndex: body.pageIndex, pageSize: body.pageSize, hasMore: false,
          patients: [{ inpatId: binding.inpatId, inpatCode: binding.inpatCode, patientName: 'Synthetic patient', bedName: 'A-01' }] }; break
        default: response.writeHead(404); response.end('{}'); return
      }
      response.end(JSON.stringify(value))
    })().catch(() => { response.writeHead(500); response.end('{}') })
  })
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => { resolve() })) })
  const port = (broker.address() as AddressInfo).port
  const previous = process.env.DSH_CLINICAL_BROWSER_TOKEN
  process.env.DSH_CLINICAL_BROWSER_TOKEN = 'synthetic-browser-only'
  cleanups.push(() => { if (previous === undefined) Reflect.deleteProperty(process.env, 'DSH_CLINICAL_BROWSER_TOKEN'); else process.env.DSH_CLINICAL_BROWSER_TOKEN = previous })
  const overlay = join(fixtureRoot, 'viewer.overlay.yml')
  await writeFile(overlay, `- insert:\n  - id: clinical-review\n    name: '@deepseek-ai/dsh-experimental-clinical-review'\n    config: ${JSON.stringify({ brokerBaseUrl: `http://127.0.0.1:${port}/runtime/emr/`, runtimeTokenEnv: 'DSH_CLINICAL_BROWSER_TOKEN', ownerId: binding.actorId, cwd: fixtureRoot, reviewLanguage: 'en' })}\n  - id: clinical-results\n    name: '@deepseek-ai/dsh-experimental-client-clinical-results'\n    config: {}\n`)
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, toolsMode: 'native',
    ...prefix === undefined ? {} : { publicMount: { prefix } }, profile: { hmr: false, packages: [
      { dir: fileURLToPath(new URL('../../../packages/experimental/clinical-review', import.meta.url)) },
      { dir: fileURLToPath(new URL('../../../packages/experimental/client-clinical-results', import.meta.url)) },
    ] } })
  cleanups.push(() => scaffold.close())
  const model = new ClinicalModel()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['clinical-browser-test'], model))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'clinical-browser-test', model: 'synthetic' })
  const browser = await chromium.launch()
  cleanups.push(() => browser.close())
  const page = await newEnglishPage(browser)
  failurePage.current = page
  const tripwire = watchConsole(page)
  const clinicalRequest = (operation: string, body: Record<string, unknown>) => page.evaluate(async ({ operation, body }) => {
    const response = await fetch(`api/clinical-review/${operation}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data: unknown = await response.json()
    return { status: response.status, data }
  }, { operation, body })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Department patients', exact: true }).click()
  await page.getByRole('combobox', { name: /^Department/ }).selectOption({ label: 'Synthetic department' })
  const launching = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/clinical-review/launch'))
  await page.getByRole('button', { name: 'Synthetic patient A-01 · SYNTHETIC-123', exact: true }).click()
  const launched = await launching
  expect(launched.status(), await launched.text()).toBe(200)
  const receipt: unknown = await launched.json()
  if (receipt === null || typeof receipt !== 'object' || !('sessionId' in receipt)) throw new Error('Launch receipt missing Session')
  const sessionId = resultRequestSchema.shape.sessionId.parse(receipt.sessionId)
  await page.getByText('No saved report for this encounter', { exact: true }).waitFor()
  expect(model.calls).toBe(0)
  expect(captures).toBe(0)
  await page.getByRole('button', { name: 'Start review', exact: true }).click()
  await page.getByRole('button', { name: 'Open review chat', exact: true }).click()
  const card = page.getByRole('button', { name: 'View result · Revision 1', exact: true })
  await card.waitFor({ timeout: 15_000 })
  await card.click()
  const report = page.locator('article[data-clinical-result]')
  await expect.poll(() => report.count()).toBe(1)
  await report.locator('summary').click()
  await expect.poll(() => report.locator('blockquote').textContent()).toBe('no pneumonia')
  const source = await clinicalRequest('results', { sessionId })
  const saved = resultsResponseSchema.parse(source.data).results[0]!
  sourceRevision = 2
  const rerun = await clinicalRequest('rerun', { sessionId: saved.sessionId, encounterRef: saved.encounterRef,
    resultId: saved.resultId, revision: saved.revision, requestId: 'browser-second-review' })
  expect(rerun.status).toBe(202)
  await page.getByRole('button', { name: 'View result · Revision 2', exact: true }).waitFor({ timeout: 30_000 })
  await expect.poll(() => model.calls, { timeout: 10_000 }).toBe(8)
  expect(await report.locator('blockquote').textContent()).toBe('no pneumonia')
  const callsAtRead = model.calls, capturesAtRead = captures
  const exactPath = `?page=clinical-results&sessionId=${encodeURIComponent(saved.sessionId)}&resultId=${encodeURIComponent(saved.resultId)}&revision=1`
  await page.goto(new URL(exactPath, scaffold.baseUrl.replace(/\/$/u, '') + '/').href)
  await page.locator('article[data-clinical-result]').waitFor()
  expect(await page.locator('[data-composer-input]').count()).toBe(0)
  for (const width of [360, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    const evidence = page.locator('article[data-clinical-result] summary')
    await evidence.focus()
    if (!(await evidence.evaluate(element => element.parentElement?.hasAttribute('open')))) await page.keyboard.press('Enter')
    expect(await page.locator('article[data-clinical-result] blockquote').textContent()).toBe('no pneumonia')
    expect(await page.getByText('source-1', { exact: true }).count()).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(await page.getByRole('main').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    if (width === 360) {
      const golden = fileURLToPath(new URL('./expected/clinical-results/result.expected.md', import.meta.url))
      await mkdir(dirname(golden), { recursive: true })
      await compareOrRefreshGolden(golden, await captureStableAria(page, 'article[data-clinical-result]', scaffold.workspaceCwd,
        { replacements: [[saved.reportId, '{{reportId}}']] }), webSnapshotMode())
    }
    await mkdir(join(fileURLToPath(new URL('../../..', import.meta.url)), 'output/playwright'), { recursive: true })
    const screenshotRoot = join(fileURLToPath(new URL('../../..', import.meta.url)), 'output/playwright')
    await page.screenshot({ path: join(screenshotRoot, `clinical-results-${name}-${width}-evidence.png`) })
    await page.getByRole('main').evaluate((element) => { element.scrollTop = 0 })
    await page.screenshot({ path: join(screenshotRoot, `clinical-results-${name}-${width}.png`) })
  }
  const read = await clinicalRequest('result', { sessionId: saved.sessionId, resultId: saved.resultId, revision: 1 })
  const old = resultResponseSchema.parse(read.data)
  expect(old.findings[0]?.evidenceRefs[0]?.quote).toBe('no pneumonia')
  expect(old.freshness.status).toBe('changed')
  expect(model.calls).toBe(callsAtRead)
  expect(captures).toBe(capturesAtRead)
  denied = true
  await page.getByRole('button', { name: 'Update result and progress', exact: true }).click()
  await page.getByText('Access denied. Check your account and encounter authorization.', { exact: true }).waitFor()
  expect(await page.locator('article[data-clinical-result]').count()).toBe(0)
  expect(await page.locator('body').textContent()).not.toContain('no pneumonia')
  expect(await page.locator('body').textContent()).not.toContain(binding.inpatCode)
  const deniedGolden = fileURLToPath(new URL('./expected/clinical-results/denied.expected.md', import.meta.url))
  await compareOrRefreshGolden(deniedGolden, await captureStableAria(page, 'main', scaffold.workspaceCwd), webSnapshotMode())
  expect(tripwire.pageErrors).toEqual([])
})

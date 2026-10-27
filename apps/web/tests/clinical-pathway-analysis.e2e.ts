/** Select the deployment-owned pathway preset and send a keyless turn through the real Web composition. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { SessionId } from '@deepseek-ai/dsh-session'
import { generateClinicalPathwayPreset, generateClinicalPreset } from '../../../deploy/hosted-workspaces/company-presets.mjs'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const PRESET = 'clinical-pathway-analysis'
const REPLY = 'CLINICAL_PATHWAY_REFERENCE_ONLY'
const PATHWAY_TITLE = 'Pathway navigation regression'
const REVIEW_TITLE = 'Synthetic encounter navigation regression'
const RECORDED_TITLE = 'Restored pathway recording'

async function expectEncounterControls(page: Page, visible: boolean): Promise<void> {
  for (const name of ['Insurance assistant', 'Connect encounter', 'Pre-discharge review']) {
    const button = page.getByRole('button', { name, exact: true })
    await expect.poll(() => button.count(), { message: name }).toBe(visible ? 1 : 0)
    if (visible) expect(await button.isEnabled()).toBe(true)
  }
}

async function openNamedSession(page: Page, title: string): Promise<void> {
  const row = page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
  await expect.poll(async () => {
    if (await row.count() > 0) return true
    const ungrouped = page.getByRole('treeitem', { name: /^Ungrouped/ })
    if (await ungrouped.count() === 1 && await ungrouped.getAttribute('aria-expanded') === 'false') await ungrouped.click()
    return await row.count() > 0
  }).toBe(true)
  await row.click()
}

/** A transport fixture that records the actual assembled request, without assessing medical quality. */
class PathwayModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('isolates new, started, and restored pathway chats from encounter controls while clinical review retains them', async () => {
  const cleanups: (() => void | Promise<void>)[] = []
  const failurePage: { current?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && failurePage.current !== undefined) await saveFailureShot(failurePage.current, 'clinical-pathway-analysis')
    } finally {
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() }
        catch (error: unknown) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Clinical pathway browser cleanup failed')
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'clinical-pathway-browser-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'workspace'))
  const binding = { schemaVersion: 1, bindingId: '11111111-1111-4111-8111-111111111111', actorId: 'synthetic-pathway-doctor',
    actorIssuer: 'https://synthetic.example', actorSubject: 'doctor', sourceSystem: 'synthetic-emr', hospitalCode: '1001',
    inpatId: '123', inpatCode: 'SYNTHETIC-PATHWAY-123' }
  const brokerOperations: string[] = []
  const broker = createServer((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.headers['x-api-key'] !== 'synthetic-pathway-browser-only') { response.writeHead(403); response.end('{}'); return }
    const operation = request.url?.split('/').at(-1) ?? ''
    brokerOperations.push(operation)
    if (operation === 'launch') response.end(JSON.stringify({ grant: '2'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    else if (operation === 'consume' || operation === 'authorize') response.end(JSON.stringify(binding))
    else if (operation === 'departments') response.end(JSON.stringify({ departments: [] }))
    else { response.writeHead(500); response.end('{}') }
  })
  cleanups.push(async () => { broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => { resolve() })) })
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve))
  const previousToken = process.env.DSH_PATHWAY_BROWSER_TOKEN
  process.env.DSH_PATHWAY_BROWSER_TOKEN = 'synthetic-pathway-browser-only'
  cleanups.push(() => {
    if (previousToken === undefined) Reflect.deleteProperty(process.env, 'DSH_PATHWAY_BROWSER_TOKEN')
    else process.env.DSH_PATHWAY_BROWSER_TOKEN = previousToken
  })
  const overlay = join(root, 'pathway.overlay.yml')
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const preset = generateClinicalPathwayPreset(repository)
  await writeFile(overlay, dump([{ insert: [preset, generateClinicalPreset(repository),
    { id: 'clinical-review', name: '@deepseek-ai/dsh-experimental-clinical-review', config: {
      brokerBaseUrl: `http://127.0.0.1:${(broker.address() as AddressInfo).port}/runtime/emr/`, runtimeTokenEnv: 'DSH_PATHWAY_BROWSER_TOKEN',
      ownerId: binding.actorId, cwd: join(root, 'workspace'), agentPreset: 'clinical-review',
    } },
    { id: 'client-emr-entry', name: '@deepseek-ai/dsh-experimental-client-emr-entry', config: {
      allowedOrigins: [], defaultSourceSystem: binding.sourceSystem, defaultHospitalCode: binding.hospitalCode,
    } },
    { id: 'client-clinical-results', name: '@deepseek-ai/dsh-experimental-client-clinical-results', config: {} },
  ] }], { schema: entryListSchema }))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, toolsMode: 'native', profile: { hmr: false, packages: [
    { dir: join(repository, 'packages/experimental/clinical-review') },
    { dir: join(repository, 'packages/experimental/client-emr-entry') },
    { dir: join(repository, 'packages/experimental/client-clinical-results') },
  ] } })
  cleanups.push(() => scaffold.close())
  const model = new PathwayModel()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['clinical-pathway-browser-test'], model))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'clinical-pathway-browser-test', model: 'synthetic' })
  const browser = await chromium.launch()
  cleanups.push(() => browser.close())
  const page = await newEnglishPage(browser)
  failurePage.current = page
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, root)
  await expectEncounterControls(page, false)
  // Establish that the real encounter widgets are mounted before testing their absence elsewhere.
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
  await page.getByRole('menuitem', { name: /^医保助手/ }).click()
  const insuranceNavigation = page.getByRole('button', { name: 'Insurance assistant', exact: true })
  await insuranceNavigation.waitFor()
  expect(await insuranceNavigation.isEnabled()).toBe(true)
  await page.getByRole('button', { name: 'Connect encounter', exact: true }).click()
  const entry = page.getByRole('dialog', { name: 'Connect encounter', exact: true })
  await entry.getByRole('textbox', { name: 'Inpatient record ID', exact: true }).fill(binding.inpatId)
  const launching = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/clinical-review/launch'))
  await entry.getByRole('button', { name: 'Open encounter chat', exact: true }).click()
  const launch = await launching
  expect(launch.status(), await launch.text()).toBe(200)
  const receipt = await launch.json() as { sessionId: string }
  const reviewId = SessionId(receipt.sessionId)
  await page.locator(`[data-conversation-session="${reviewId}"]`).waitFor()
  await scaffold.ctx.sessionController.rename({ sessionId: reviewId, title: REVIEW_TITLE })
  expect(model.requests).toHaveLength(0)
  expect(await page.getByRole('button', { name: 'Connect encounter', exact: true }).isEnabled()).toBe(true)
  expect(await page.getByRole('button', { name: 'Pre-discharge review', exact: true }).count()).toBe(0)
  // The session header appears after the first turn; this fixture turn requests no patient evidence.
  const reviewComposer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await writeComposerDraft(page, reviewComposer, 'Synthetic navigation check. Reply with the fixture acknowledgment.')
  await reviewComposer.press('Enter')
  await page.getByText(REPLY, { exact: true }).waitFor()
  await expectEncounterControls(page, true)
  expect(model.requests).toHaveLength(1)
  await insuranceNavigation.click()
  await page.getByText('No department access is configured for this account', { exact: true }).waitFor()
  expect(await insuranceNavigation.count()).toBe(1)
  expect(await insuranceNavigation.getAttribute('aria-current')).toBe('page')
  expect(await page.getByRole('button', { name: 'Connect encounter', exact: true }).isEnabled()).toBe(true)
  await openNamedSession(page, REVIEW_TITLE)
  await expectEncounterControls(page, true)
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
  await expectEncounterControls(page, false)
  await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
  await page.getByRole('menuitem', { name: /^临床路径分析/ }).click()
  await page.getByRole('button', { name: '临床路径分析', exact: true }).waitFor()
  await expectEncounterControls(page, false)
  const selected = await page.evaluate(() => {
    const current = localStorage.getItem('dsh.sessions.current')
    return current === null ? undefined : (JSON.parse(current) as { sessionId?: string }).sessionId
  })
  if (selected === undefined) throw new Error('Pathway selection did not create a Session')
  const id = SessionId(selected)
  await scaffold.ctx.sessionController.rename({ sessionId: id, title: PATHWAY_TITLE })
  const agent = scaffold.ctx.agents.get(id)
  if (agent === undefined) throw new Error('Selected pathway Agent is unavailable')
  expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe(PRESET)
  expect(scaffold.ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBe(PRESET)
  expect(model.requests).toHaveLength(1)
  const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
  await writeComposerDraft(page, composer, '目前尚未提供历史病例数据，也未启用读取工具，请说明临床路径参考稿 v1 和 v2 的分析范围；不创建医院业务草案。')
  await composer.press('Enter')
  await page.getByText(REPLY, { exact: true }).waitFor()
  await expectEncounterControls(page, false)
  expect(model.requests).toHaveLength(2)
  const request = model.requests[1]!
  const prompt = JSON.stringify(request.messages)
  for (const text of ['你是“临床路径分析”助手', '所有产物均为“参考分析／参考方案”', '参考稿 v1/v2 不是医院业务版本',
    '你不创建医院草案，不写入路径、病历或医嘱', '工具未启用、读取失败或资料缺失时，明确说明对应限制',
    '历史高频行为不等于诊疗标准', '医嘱、收费、记录存在及来源“完成”状态都不能独自证明临床任务已执行',
    '不同调用或分页不是同一不可变数据库快照', '当前任何用户确认都只修改参考方案']) {
    expect(prompt).toContain(text)
  }
  for (const text of ['你是“医保助手”', 'implementation checkout', 'pnpm run dev:web', 'plan:policy']) expect(prompt).not.toContain(text)
  const tools = request.tools?.map(tool => tool.name) ?? []
  expect(tools).toEqual(expect.arrayContaining(['read', 'grep', 'web_search', process.platform === 'win32' ? 'pwsh' : 'bash']))
  expect(tools.some(name => name.startsWith('review_') || name === 'exit_plan_mode')).toBe(false)
  for (const name of ['pathway_read', 'history_query', 'case_read']) expect(tools).not.toContain(name)
  await expect(scaffold.ctx.agentPresets.select(agent, 'standard')).rejects.toMatchObject({ code: 'agent-preset/locked' })
  expect(scaffold.ctx.agentPresets.composedPreset(agent.ctx)).toBe(PRESET)

  await openNamedSession(page, REVIEW_TITLE)
  await expectEncounterControls(page, true)
  await openNamedSession(page, PATHWAY_TITLE)
  await page.getByText(REPLY, { exact: true }).waitFor()
  await expectEncounterControls(page, false)

  // Borrow the canonical headless recording read-only; this also covers persisted preset restoration.
  const recorded = await seedSession(scaffold, await readFile(join(repository, 'snapshots/session/clinical-pathway-analysis/session.v4.jsonl'), 'utf8'),
    'clinical-pathway-restored-browser', PRESET)
  await scaffold.ctx.sessionController.rename({ sessionId: recorded, title: RECORDED_TITLE })
  await openNamedSession(page, RECORDED_TITLE)
  await page.locator(`[data-conversation-session="${recorded}"]`).waitFor()
  await expectEncounterControls(page, false)
  const warningStart = tripwire.warnings.length
  await page.reload()
  await page.locator(`[data-conversation-session="${recorded}"]`).waitFor()
  await expectEncounterControls(page, false)
  acknowledgeReloadConnectionLoss(tripwire, warningStart)
  await openNamedSession(page, REVIEW_TITLE)
  await expectEncounterControls(page, true)
  const reviewWarningStart = tripwire.warnings.length
  await page.reload()
  await page.locator(`[data-conversation-session="${reviewId}"]`).waitFor()
  await expectEncounterControls(page, true)
  acknowledgeReloadConnectionLoss(tripwire, reviewWarningStart)
  await page.getByRole('button', { name: 'New session', exact: true }).last().click()
  await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
  await expectEncounterControls(page, false)
  expect(model.requests).toHaveLength(2)
  expect(brokerOperations).toEqual(expect.arrayContaining(['launch', 'consume', 'departments']))
  expect(brokerOperations.every(operation => ['launch', 'consume', 'authorize', 'departments'].includes(operation))).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

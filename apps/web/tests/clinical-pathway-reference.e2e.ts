/** Real Web composition smoke for the optional private reference preview, using synthetic data only. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump } from 'js-yaml'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { ReferenceConfig } from '@deepseek-ai/dsh-experimental-clinical-pathway-reference/types'
import { readDefinition } from '../../../packages/experimental/clinical-pathway-reference/src/emr/definition-reader.ts'
import { commitRequestSchema, viewSchema } from '../../../packages/experimental/clinical-pathway-reference/src/protocol.ts'
import { generateClinicalPathwayPreset } from '../../../deploy/hosted-workspaces/company-presets.mjs'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const PRESET = 'clinical-pathway-analysis'
const CHAT_TITLE = 'Synthetic P1 pathway chat'
const TASK_TITLE = 'Synthetic P1 reference task'
const config: ReferenceConfig = { scope: { sourceSystem: 'synthetic-emr', hospitalCode: '1001', departmentCodes: ['99999'],
  departmentBasis: 'current', admissionFrom: '2025-10-27T00:00:00Z', admissionTo: '2026-10-27T00:00:00Z' },
maxRequestBytes: 200000, maxStateBytes: 2000000, maxRevisions: 10 }

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

it('creates, follows saved revisions and restores a full synthetic reference in the shipped Web modal at desktop and 390px', async () => {
  const cleanups: (() => void | Promise<void>)[] = []
  const failurePage: { current?: Page } = {}
  onTestFinished(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && failurePage.current !== undefined) await saveFailureShot(failurePage.current, 'clinical-pathway-reference')
    } finally {
      const errors: unknown[] = []
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() }
        catch (error: unknown) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Pathway preview browser cleanup failed')
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'clinical-pathway-reference-browser-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'workspace'))
  const overlay = join(root, 'reference.overlay.yml')
  await writeFile(overlay, dump([{ insert: [generateClinicalPathwayPreset(repository),
    { id: 'pathway-reference', name: '@deepseek-ai/dsh-experimental-clinical-pathway-reference', config },
  ] }], { schema: entryListSchema }))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay, toolsMode: 'native', profile: { hmr: false, packages: [
    { dir: join(repository, 'packages/experimental/clinical-pathway-reference') },
  ] } })
  cleanups.push(() => scaffold.close())
  const seeded = await seedSession(scaffold,
    await readFile(join(repository, 'snapshots/session/clinical-pathway-analysis/session.v4.jsonl'), 'utf8'),
    'synthetic-pathway-reference-browser', PRESET)
  await scaffold.ctx.sessionController.rename({ sessionId: seeded, title: CHAT_TITLE })
  const browser = await chromium.launch()
  cleanups.push(() => browser.close())
  const page = await newEnglishPage(browser)
  failurePage.current = page
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, root)
  expect(await page.getByRole('button', { name: 'Reference', exact: true }).count()).toBe(0)
  await openNamedSession(page, CHAT_TITLE)
  await page.locator(`[data-conversation-session="${seeded}"]`).waitFor()
  const reading = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/pathway-reference/read'))
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  const readResult = await reading
  expect(readResult.status(), await readResult.text()).toBe(200)
  const modal = page.getByRole('dialog', { name: 'Clinical pathway reference', exact: true })
  await modal.getByRole('textbox', { name: 'Task title', exact: true }).fill(TASK_TITLE)
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/pathway-reference/create'))
  await modal.getByRole('button', { name: 'Create reference task', exact: true }).click()
  const receipt = await created
  expect(receipt.status(), await receipt.text()).toBe(200)
  const createdView = viewSchema.parse(await receipt.json())
  expect(createdView.state?.revisions.at(-1)?.revision).toBe(1)
  await modal.getByText(TASK_TITLE, { exact: true }).waitFor()
  expect(await modal.getByRole('textbox').count()).toBe(0)
  const definition = readDefinition(JSON.parse(await readFile(join(repository,
    'packages/experimental/clinical-pathway-reference/tests/definition.example.json'), 'utf8')))
  const rootIdentity = createdView.state?.revisions[0]?.definition.clinicalPathway.localId
  if (rootIdentity === undefined) throw new Error('Created reference lacks a stable pathway identity')
  definition.clinicalPathway.localId = rootIdentity
  const candidate = commitRequestSchema.parse({ sessionId: seeded,
    requestId: 'synthetic-browser-complex-content', baseRevision: 1, definition,
    metadata: { coverage: ['Synthetic source; incomplete dictionary matching'], questions: [
      { localId: 'herb-b', field: 'drugCode', message: 'Synthetic unresolved dictionary item' },
    ], evidence: [] }, locks: ['herb-b#drugCode', 'group-a'],
  })
  const committed = await scaffold.hostFetch('/api/pathway-reference/commit', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) })
  expect(committed.status, await committed.text()).toBe(200)
  // The ordinary Session revision projection triggers this read; no refresh click or clinical body is injected into the client.
  await modal.getByRole('button', { name: 'Inspect: 合成完整路径（仅验数据结构）', exact: true }).first().waitFor()
  for (const text of ['合成第1—2天', '合成第3—4天', '合成诊疗工作', '合成护理工作', '合成整方（不作临床建议）', '合成药味一', '未读取的关联路径']) {
    expect(await modal.getByText(text, { exact: true }).count()).toBeGreaterThan(0)
  }
  await modal.getByLabel('Objects', { exact: true }).selectOption('herb-b')
  await modal.getByText('Field lock: drugCode', { exact: true }).waitFor()
  await modal.getByText('drugCode: Synthetic unresolved dictionary item', { exact: true }).waitFor()
  const refreshing = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/api/pathway-reference/read'))
  await modal.getByRole('button', { name: 'Refresh', exact: true }).click()
  const refreshed = await refreshing
  expect(refreshed.status(), await refreshed.text()).toBe(200)
  const screenshots = join(repository, 'output/playwright/clinical-pathway-reference')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'desktop-light.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(theme === 'dark')
    const geometry = await modal.evaluate(element => ({ left: element.getBoundingClientRect().left,
      right: element.getBoundingClientRect().right, width: window.innerWidth,
      overflowing: [...element.querySelectorAll('div,section,aside,pre')].filter(child => child.scrollWidth > child.clientWidth + 1)
        .map(child => ({ tag: child.tagName, className: child.className, scroll: child.scrollWidth, client: child.clientWidth })),
      document: document.documentElement.scrollWidth,
    }))
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.width)
    expect(geometry.document).toBeLessThanOrEqual(390)
    expect(geometry.overflowing).toEqual([])
    await page.screenshot({ path: join(screenshots, `mobile-${theme}.png`), fullPage: true })
  }
  await modal.getByRole('button', { name: 'Close', exact: true }).click()
  const warningStart = tripwire.warnings.length
  await page.reload()
  await page.locator(`[data-conversation-session="${seeded}"]`).waitFor()
  acknowledgeReloadConnectionLoss(tripwire, warningStart)
  await page.getByRole('button', { name: 'Reference', exact: true }).click()
  await modal.getByText(TASK_TITLE, { exact: true }).waitFor()
  await modal.getByRole('button', { name: 'Inspect: 合成完整路径（仅验数据结构）', exact: true }).first().waitFor()
  const selectedRevision = await modal.getByLabel('Reference revision', { exact: true }).inputValue()
  expect(selectedRevision).toBe('2')
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

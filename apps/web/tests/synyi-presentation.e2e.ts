/** Deployment branding over the real Web profile, including proxy-mounted browser resources. */
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-settings'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const bundleRoot = fileURLToPath(new URL('../../../packages/bundle/synyi-web-app/', import.meta.url))

async function observeFirstFrame(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sample = (): void => {
      if (document.body === null) { requestAnimationFrame(sample); return }
      document.documentElement.dataset.synyiFirstFrameBackground = getComputedStyle(document.body).backgroundColor
    }
    requestAnimationFrame(sample)
  })
}

async function palette(page: Page) {
  return await page.evaluate(() => {
    const style = getComputedStyle(document.body)
    return {
      background: style.backgroundColor,
      brand: style.getPropertyValue('--dsw-alias-brand-primary').trim(),
      radius: style.getPropertyValue('--dsw-radius-md').trim(),
      dark: document.body.hasAttribute('data-ds-dark-theme'),
    }
  })
}

it.each([
  { name: 'root', publicMount: undefined },
  { name: 'prefix', publicMount: { prefix: 'w/synyi-test/' } },
])('keeps Synyi branding and theme inside its deployment composition at $name', async ({ name, publicMount }) => {
  const scaffold = await launchWebScaffold({
    ...publicMount === undefined ? {} : { publicMount },
    // Match `dsh web --patch`: the CLI installation supplies the optional bundle's dependencies.
    extraOverlayPath: `${bundleRoot}cordis.patch.yml`,
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFinished(async ({ task }) => {
    if (task.result?.state === 'fail') await saveFailureShot(page, `synyi-presentation-${name}`)
  })
  const tripwire = watchConsole(page)
  await observeFirstFrame(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await scaffold.ctx.settings.update('ui-theme', { preference: 'light' })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByText('SYNYI AI', { exact: true }).waitFor()
  expect(await page.getByText('SYNYI AI', { exact: true }).count()).toBe(1)
  expect(await page.locator('img[data-brand="synyi"]').count()).toBeGreaterThanOrEqual(1)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-brand-official')?.disabled).toBe(true)
  const expectedTitle = readClientBuildRecord(repoRoot).environment.DSH_CLIENT_TITLE ?? 'DSH Local Build'
  await expect.poll(() => page.title()).toBe(expectedTitle)
  await expect.poll(() => palette(page)).toEqual({ background: 'rgb(240, 242, 245)', brand: '#3664d9', radius: '4px', dark: false })
  expect(await page.locator('html').getAttribute('data-synyi-first-frame-background')).toBe('rgb(240, 242, 245)')

  const resources = await page.evaluate(async () => {
    const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')]
    const manifests = [...document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]')]
    const links = [...icons, ...manifests]
    return {
      icons: icons.map(link => ({ path: new URL(link.href).pathname, media: link.media })),
      manifests: manifests.map(link => new URL(link.href).pathname),
      responses: await Promise.all(links.map(async (link) => {
        const response = await fetch(link.href)
        return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
      })),
    }
  })
  const prefix = new URL(scaffold.baseUrl).pathname.replace(/\/$/u, '')
  expect(resources.icons).toEqual([
    { path: `${prefix}/synyi-brand/favicon-dark.svg`, media: '(prefers-color-scheme: dark)' },
    { path: `${prefix}/synyi-brand/favicon.svg`, media: '(prefers-color-scheme: light)' },
  ])
  expect(resources.manifests).toEqual([`${prefix}/synyi-brand/manifest.webmanifest`])
  expect(resources.responses.map(response => response.status)).toEqual([200, 200, 200])
  expect(resources.responses.map(response => response.type)).toEqual(['image/svg+xml', 'image/svg+xml', 'application/manifest+json'])
  expect(resources.responses[0]!.body).toContain('data:image/png;base64,')
  expect(JSON.parse(resources.responses[2]!.body)).toMatchObject({ name: '森亿智能', start_url: '../', scope: '../' })

  await scaffold.ctx.settings.update('ui-theme', { preference: 'dark' })
  await expect.poll(() => palette(page)).toEqual({ background: 'rgb(21, 30, 44)', brand: '#9cb6ff', radius: '4px', dark: true })
  await page.reload()
  await page.getByText('SYNYI AI', { exact: true }).waitFor()
  expect(await page.locator('html').getAttribute('data-synyi-first-frame-background')).toBe('rgb(21, 30, 44)')
  await expect.poll(() => page.title()).toBe(expectedTitle)
  await scaffold.ctx.settings.update('ui-theme', { preference: 'system' })
  await expect.poll(() => palette(page)).toMatchObject({ background: 'rgb(240, 242, 245)', dark: false })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => palette(page)).toMatchObject({ background: 'rgb(21, 30, 44)', dark: true })
  expect(tripwire.pageErrors).toEqual([])
})

it('retains the upstream Web palette and metadata without the Synyi layer', async () => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await observeFirstFrame(page)
  await scaffold.ctx.settings.update('ui-theme', { preference: 'light' })
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Account menu', exact: true }).waitFor()
  expect(await page.locator('[data-brand="synyi"]').count()).toBe(0)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ui-brand-official')?.disabled).toBe(false)
  expect(await page.locator('html').getAttribute('data-synyi-first-frame-background')).toBe('rgb(255, 255, 255)')
  expect(await page.locator('link[rel="manifest"]').evaluate(link => new URL((link as HTMLLinkElement).href).pathname)).toBe('/manifest.webmanifest')
  expect(await page.locator('link[rel="icon"]').count()).toBe(2)
  expect((await scaffold.hostFetch('/synyi-brand/favicon.svg')).status).toBe(404)
})

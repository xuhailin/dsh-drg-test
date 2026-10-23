/** Synyi metadata through a real Loader composition and HTTP listener. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import * as Brand from '../src/index.ts'

const compositions: { ctx: Context; root: string }[] = []

afterEach(async () => {
  for (const { ctx, root } of compositions.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

async function loadComposition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-synyi-brand-'))
  const ctx = new Context()
  compositions.push({ ctx, root })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:webserver',
    '  config:',
    '    host: 127.0.0.1',
    '    port: 0',
    '- id: synyi-brand',
    '  name: cordis:synyi-brand',
    '',
  ].join('\n'))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.webserver = WebServer
  ctx.loader.builtins['synyi-brand'] = Brand
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('Synyi Host branding', () => {
  it('serves brand assets and replaces the shell links while retaining mounted application URLs', async () => {
    const ctx = await loadComposition()
    const origin = ctx.webServer.getOrigin()
    const index = await readFile(new URL('../../../../apps/web/index.html', import.meta.url), 'utf8')
    const html = ctx.webServer.renderIndex(index)
    expect(html.match(/rel="icon"/g)).toHaveLength(2)
    expect(html.match(/rel="manifest"/g)).toHaveLength(1)
    expect(html).toContain('href="synyi-brand/favicon.svg" media="(prefers-color-scheme: light)"')
    expect(html).toContain('href="synyi-brand/favicon-dark.svg" media="(prefers-color-scheme: dark)"')
    expect(html).not.toContain('href="/favicon')

    for (const name of ['favicon.svg', 'favicon-dark.svg']) {
      const response = await fetch(`${origin}/synyi-brand/${name}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/svg+xml')
      expect(await response.text()).toBe(await readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8'))
      const head = await fetch(`${origin}/synyi-brand/${name}`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
      expect(await head.text()).toBe('')
    }
    const manifestResponse = await fetch(`${origin}/synyi-brand/manifest.webmanifest`)
    expect(manifestResponse.headers.get('content-type')).toBe('application/manifest+json')
    const manifest = await manifestResponse.json() as { name: string; start_url: string; scope: string; icons: { src: string }[] }
    expect(manifest.name).toBe('森亿智能')
    const mountedManifest = new URL('synyi-brand/manifest.webmanifest', `${origin}/w/owner/`)
    expect(new URL(manifest.start_url, mountedManifest).pathname).toBe('/w/owner/')
    expect(new URL(manifest.scope, mountedManifest).pathname).toBe('/w/owner/')
    expect(new URL(manifest.icons[0]!.src, mountedManifest).pathname).toBe('/w/owner/synyi-brand/favicon.svg')
    const denied = await fetch(`${origin}/synyi-brand/favicon.svg`, { method: 'POST' })
    expect(denied.status).toBe(405)
    expect(denied.headers.get('allow')).toBe('GET, HEAD')
    expect((await fetch(`${origin}/synyi-brand/unknown.svg`)).status).toBe(404)

    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'synyi-brand')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.webServer.renderIndex(index)).toContain('href="/favicon.svg"')
    expect((await fetch(`${origin}/synyi-brand/favicon.svg`)).status).toBe(404)
  })

  it('retains unrelated metadata and rejects documents without a head', async () => {
    const ctx = await loadComposition()
    const html = ctx.webServer.renderIndex("<head><link rel='shortcut icon' href='old.ico'><link rel='stylesheet' href='style.css'><link href='other'><link rel='manifest' href='old.json'></head>")
    expect(html).not.toContain('old.ico')
    expect(html).not.toContain('old.json')
    expect(html).toContain("<link rel='stylesheet' href='style.css'>")
    expect(html).toContain("<link href='other'>")
    expect(() => ctx.webServer.renderIndex('<body></body>')).toThrow('ui-brand-synyi: index document has no closing head element')
  })
})
